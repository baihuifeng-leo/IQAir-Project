'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { resolveAllImages } = require('./detail-image-resolver');

const MIB = 1024 * 1024;
const FIRST = 'https://img.alicdn.com/detail/first.png';
const SECOND = 'https://img.alicdn.com/detail/second.png';

function response({ status = 200, contentType = 'image/png', chunks = [Buffer.from('image')] } = {}) {
  return {
    status,
    headers: { 'content-type': contentType },
    body: Readable.from(chunks),
  };
}

function imageBlock(candidates, domIndex = 0) {
  return { kind: 'image', candidates, domIndex, width: 1, height: 9999 };
}

function fakeSharp({ metadata, failOn } = {}) {
  const calls = [];
  const sharp = (buffer, options) => {
    calls.push({ buffer, options });
    return {
      async metadata() {
        if (failOn && failOn(buffer)) throw new Error('not a decodable image');
        return metadata || { width: 640, height: 480 };
      },
    };
  };
  return { sharp, calls };
}

function baseOptions(overrides = {}) {
  const decoded = fakeSharp();
  return {
    request: async () => response(),
    sharp: decoded.sharp,
    emit: () => {},
    limits: { perAssetBytes: 50 * MIB, totalBytes: 500 * MIB },
    ...overrides,
    decoded,
  };
}

test('falls back from an unavailable candidate and uses decoded metadata instead of DOM dimensions', async () => {
  const calls = [];
  const options = baseOptions({
    request: async (url) => {
      calls.push(url);
      return url === FIRST ? response({ status: 404 }) : response({ chunks: [Buffer.from('decoded-second')] });
    },
  });

  const resolved = await resolveAllImages([imageBlock([FIRST, SECOND])], options);

  assert.deepEqual(calls, [FIRST, SECOND]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].width, 640);
  assert.equal(resolved[0].height, 480);
  assert.equal(resolved[0].buffer.toString(), 'decoded-second');
  assert.deepEqual(options.decoded.calls[0].options, { animated: false, limitInputPixels: false });
});

test('uses the installed Sharp decoder dimensions for a valid streamed PNG', async () => {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 13, height: 7, channels: 4, background: '#336699' } }).png().toBuffer();

  const resolved = await resolveAllImages([imageBlock([FIRST])], {
    request: async () => response({ chunks: [png.subarray(0, 10), png.subarray(10)] }),
    sharp,
  });

  assert.equal(resolved[0].width, 13);
  assert.equal(resolved[0].height, 7);
});

test('retries a transient request failure once for the same candidate', async () => {
  let attempts = 0;
  const options = baseOptions({
    request: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('socket reset');
      return response();
    },
  });

  await resolveAllImages([imageBlock([FIRST])], options);

  assert.equal(attempts, 2);
});

test('makes at most two attempts for each candidate before reporting all-candidates failure', async () => {
  const attempts = new Map();
  const options = baseOptions({
    request: async (url) => {
      attempts.set(url, (attempts.get(url) || 0) + 1);
      throw new Error('connection reset');
    },
  });

  await assert.rejects(resolveAllImages([imageBlock([FIRST, SECOND])], options), { code: 'ASSET_UNAVAILABLE' });

  assert.deepEqual([...attempts], [[FIRST, 2], [SECOND, 2]]);
});

test('rejects an invalid content type before accepting its bytes', async () => {
  const options = baseOptions({
    request: async () => response({ contentType: 'text/html', chunks: [Buffer.from('<html>login</html>')] }),
  });

  await assert.rejects(
    resolveAllImages([imageBlock([FIRST])], options),
    (error) => error.code === 'ASSET_UNAVAILABLE' && error.assetIndex === 0,
  );
  assert.equal(options.decoded.calls.length, 0);
});

test('rejects an empty successful response', async () => {
  const options = baseOptions({ request: async () => response({ chunks: [] }) });

  await assert.rejects(resolveAllImages([imageBlock([FIRST])], options), { code: 'ASSET_UNAVAILABLE' });
  assert.equal(options.decoded.calls.length, 0);
});

test('enforces the 50 MiB per-resource cap while reading a streamed response', async () => {
  const chunks = [Buffer.alloc(49 * MIB), Buffer.alloc(2 * MIB)];
  const options = baseOptions({ request: async () => response({ chunks }) });

  await assert.rejects(resolveAllImages([imageBlock([FIRST])], options), { code: 'ASSET_UNAVAILABLE' });
  assert.equal(options.decoded.calls.length, 0);
});

test('enforces the 500 MiB aggregate cap across otherwise valid candidates', async () => {
  const options = baseOptions({
    limits: { perAssetBytes: 50 * MIB, totalBytes: 10 },
    request: async (url) => response({ chunks: [Buffer.from(url === FIRST ? '123456' : '78901')] }),
  });

  await assert.rejects(
    resolveAllImages([imageBlock([FIRST]), imageBlock([SECOND], 1)], options),
    (error) => error.code === 'ASSET_UNAVAILABLE' && error.assetIndex === 1,
  );
});

test('rejects a response whose bytes Sharp cannot decode', async () => {
  const options = baseOptions({
    sharp: fakeSharp({ failOn: () => true }).sharp,
    request: async () => response({ chunks: [Buffer.from('corrupt-image')] }),
  });

  await assert.rejects(resolveAllImages([imageBlock([FIRST])], options), { code: 'ASSET_UNAVAILABLE' });
});

test('aborting during resolution clears earlier decoded buffers and makes no further requests', async () => {
  const controller = new AbortController();
  let calls = 0;
  const options = baseOptions({
    signal: controller.signal,
    request: async (url) => {
      calls += 1;
      if (url === FIRST) return response({ chunks: [Buffer.from('first-image')] });
      async function* abortingBody() {
        yield Buffer.from('partial-second-image');
        controller.abort();
      }
      return { status: 200, headers: { 'content-type': 'image/png' }, body: abortingBody() };
    },
  });

  await assert.rejects(
    resolveAllImages([imageBlock([FIRST]), imageBlock([SECOND], 1), imageBlock(['https://img.alicdn.com/detail/never.png'], 2)], options),
    { code: 'DETAIL_CANCELLED' },
  );
  assert.equal(calls, 2);
  assert.ok(options.decoded.calls[0].buffer.every((byte) => byte === 0), 'previous buffer is zeroed on abort');
});

test('fails atomically when every candidate is unavailable, zeroes earlier buffers, and redacts URLs', async () => {
  const sensitive = `https://img.alicdn.com/detail/${'x'.repeat(300)}.png?access_token=very-secret`;
  const options = baseOptions({
    request: async (url) => {
      if (url === FIRST) return response({ chunks: [Buffer.from('first-image')] });
      return response({ status: 404 });
    },
  });

  await assert.rejects(
    resolveAllImages([imageBlock([FIRST]), imageBlock([SECOND, sensitive], 1)], options),
    (error) => {
      assert.equal(error.code, 'ASSET_UNAVAILABLE');
      assert.equal(error.assetIndex, 1);
      assert.ok(error.candidates.every((candidate) => candidate.length <= 160));
      assert.equal(JSON.stringify(error).includes('very-secret'), false);
      assert.equal(error.candidates.includes(SECOND), false, 'even short candidate URLs are never exposed verbatim');
      assert.equal(error.message.includes(sensitive), false);
      return true;
    },
  );
  assert.ok(options.decoded.calls[0].buffer.every((byte) => byte === 0), 'previous buffer is zeroed on atomic failure');
});
