'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { resolveAllImages } = require('./detail-image-resolver');

const FIRST = 'https://img.alicdn.com/detail/first.png';
const SECOND = 'https://img.alicdn.com/detail/second.png';

function stream(chunks = [Buffer.from('image')]) { return Readable.from(chunks); }
function reply({ ok = true, status = 200, headers = Promise.resolve({ 'content-type': 'image/png' }), chunks } = {}) {
  return { ok, status, headers, stream: stream(chunks) };
}
function image(candidates, domIndex = 0) { return { kind: 'image', candidates, domIndex, width: 1, height: 9999 }; }
function fakeSharp({ pending = false, fail = false } = {}) {
  const calls = [];
  const sharp = (buffer, options) => ({ metadata: () => {
    calls.push({ buffer, options });
    if (pending) return new Promise(() => {});
    if (fail) return Promise.reject(new Error('private decoder error'));
    return Promise.resolve({ width: 640, height: 480 });
  }});
  return { sharp, calls };
}
function options(overrides = {}) {
  const decoded = fakeSharp();
  return { request: async () => reply(), sharp: decoded.sharp, limits: { perAssetBytes: 50 * 1024 * 1024, totalBytes: 500 * 1024 * 1024 }, ...overrides, decoded };
}
async function promptly(promise) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('resolver did not abort promptly')), 80))]);
}

test('falls back after 404, records normalized sourceUrl, and uses decoded metadata', async () => {
  const calls = [];
  const result = await resolveAllImages([image([FIRST, SECOND])], options({ request: async (url) => {
    calls.push(url); return url === FIRST ? reply({ ok: false, status: 404 }) : reply({ chunks: [Buffer.from('second')] });
  }}));
  assert.deepEqual(calls, [FIRST, SECOND]);
  assert.deepEqual(result[0].sourceUrl, SECOND);
  assert.equal(result[0].width, 640);
  assert.equal(result[0].height, 480);
});

test('uses real Sharp metadata from streamed bytes', async () => {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 13, height: 7, channels: 4, background: 'red' } }).png().toBuffer();
  const result = await resolveAllImages([image([FIRST])], { request: async () => reply({ chunks: [png] }), sharp });
  assert.deepEqual([result[0].width, result[0].height], [13, 7]);
});

test('deducts failed candidates and retries from one shared task budget, then stops immediately', async () => {
  const calls = [];
  const result = resolveAllImages([image([FIRST, SECOND])], options({
    limits: { perAssetBytes: 10, totalBytes: 7 },
    request: async (url) => {
      calls.push(url);
      async function* broken() { yield Buffer.from('1234'); throw new Error('network broke after bytes'); }
      return { ok: true, status: 200, headers: Promise.resolve({ 'content-type': 'image/png' }), stream: broken() };
    },
  }));
  await assert.rejects(result, (error) => error.code === 'ASSET_UNAVAILABLE' && error.lastError.code === 'TASK_SIZE_LIMIT');
  assert.deepEqual(calls, [FIRST, FIRST], 'the 8th consumed byte terminates before another candidate');
});

test('requests each normalized URL at most twice', async () => {
  const calls = [];
  await assert.rejects(resolveAllImages([image([FIRST, '//img.alicdn.com/detail/first.png', SECOND])], options({
    request: async (url) => { calls.push(url); throw new Error('socket reset'); },
  })), { code: 'ASSET_UNAVAILABLE' });
  assert.deepEqual(calls, [FIRST, FIRST, SECOND, SECOND]);
});

test('rejects buffered and synchronous response bodies instead of materializing them', async () => {
  for (const unsafe of [Buffer.from('whole body'), [Buffer.from('sync body')]]) {
    await assert.rejects(resolveAllImages([image([FIRST])], options({ request: async () => ({ ok: true, status: 200, headers: Promise.resolve({ 'content-type': 'image/png' }), stream: unsafe }) })), { code: 'ASSET_UNAVAILABLE' });
  }
});

test('rejects invalid type and empty stream without Sharp', async () => {
  const invalid = options({ request: async () => reply({ headers: Promise.resolve({ 'content-type': 'text/html' }) }) });
  await assert.rejects(resolveAllImages([image([FIRST])], invalid), { code: 'ASSET_UNAVAILABLE' });
  assert.equal(invalid.decoded.calls.length, 0);
  const empty = options({ request: async () => reply({ chunks: [] }) });
  await assert.rejects(resolveAllImages([image([FIRST])], empty), { code: 'ASSET_UNAVAILABLE' });
});

test('ASSET_UNAVAILABLE has bounded redacted candidates and a fixed safe last error', async () => {
  const sensitive = `https://img.alicdn.com/${'secret/'.repeat(100)}x.png?token=private`;
  let error;
  try { await resolveAllImages([image(Array(12).fill(sensitive))], options({ request: async () => reply({ ok: false, status: 404 }) })); } catch (caught) { error = caught; }
  assert.equal(error.code, 'ASSET_UNAVAILABLE');
  assert.equal(error.assetIndex, 0);
  assert.ok(error.candidates.length <= 8 && error.candidates.every((x) => x.length <= 160));
  assert.deepEqual(error.lastError, { code: 'HTTP_UNAVAILABLE', message: '图片响应不可用' });
  assert.equal(JSON.stringify(error).includes('private'), false);
});

for (const [name, make] of [
  ['request', (controller) => ({ request: () => new Promise(() => {}) })],
  ['headers', () => ({ request: async () => reply({ headers: new Promise(() => {}) }) })],
  ['iterator.next', () => {
    let returned = false;
    const iterator = { next: () => new Promise(() => {}), return: async () => { returned = true; return { done: true }; } };
    return { request: async () => ({ ok: true, status: 200, headers: Promise.resolve({ 'content-type': 'image/png' }), stream: { [Symbol.asyncIterator]: () => iterator } }), check: () => returned };
  }],
]) test(`aborts promptly while ${name} is pending and closes the stream`, async () => {
  const controller = new AbortController(); const setup = make(controller); const run = resolveAllImages([image([FIRST])], options({ ...setup, signal: controller.signal }));
  setImmediate(() => controller.abort()); await assert.rejects(promptly(run), { code: 'DETAIL_CANCELLED' }); if (setup.check) assert.equal(setup.check(), true);
});

test('aborts promptly while Sharp metadata is pending and closes the iterator', async () => {
  const controller = new AbortController(); let returned = false;
  const iterator = { done: false, async next() { if (this.done) return { done: true }; this.done = true; return { value: Buffer.from('image'), done: false }; }, async return() { returned = true; return { done: true }; } };
  const run = resolveAllImages([image([FIRST])], options({ signal: controller.signal, sharp: fakeSharp({ pending: true }).sharp, request: async () => ({ ok: true, status: 200, headers: Promise.resolve({ 'content-type': 'image/png' }), stream: { [Symbol.asyncIterator]: () => iterator } }) }));
  setImmediate(() => controller.abort()); await assert.rejects(promptly(run), { code: 'DETAIL_CANCELLED' }); assert.equal(returned, true);
});

test('abort wins over exhausted candidates and emit errors are non-fatal', async () => {
  const controller = new AbortController();
  await assert.rejects(resolveAllImages([image([FIRST])], options({ signal: controller.signal, request: async () => { controller.abort(); return reply({ ok: false, status: 404 }); } })), { code: 'DETAIL_CANCELLED' });
  const result = await resolveAllImages([image([FIRST])], options({ emit: () => { throw new Error('observer failed'); } }));
  assert.equal(result[0].buffer.toString(), 'image');
});

test('aborts promptly even when iterator return never settles', async () => {
  const controller = new AbortController(); let returned = false;
  const iterator = { next: () => new Promise(() => {}), return: () => { returned = true; return new Promise(() => {}); } };
  const run = resolveAllImages([image([FIRST])], options({ signal: controller.signal, request: async () => ({ ok: true, status: 200, headers: Promise.resolve({ 'content-type': 'image/png' }), stream: { [Symbol.asyncIterator]: () => iterator } }) }));
  setImmediate(() => controller.abort()); await assert.rejects(promptly(run), { code: 'DETAIL_CANCELLED' }); assert.equal(returned, true);
});

function trackedReply({ ok = true, status = 200, headers = Promise.resolve({ 'content-type': 'image/png' }), next } = {}) {
  let closed = false;
  const iterator = { next: next || (async () => ({ done: true })), return: () => { closed = true; return Promise.resolve({ done: true }); } };
  return { response: { ok, status, headers, stream: { [Symbol.asyncIterator]: () => iterator } }, closed: () => closed };
}

test('closes every acquired stream on status, type, limit, read, and decode early exits', async () => {
  const cases = [
    () => trackedReply({ ok: false, status: 404 }),
    () => trackedReply({ headers: Promise.resolve({ 'content-type': 'text/html' }) }),
    () => trackedReply({ next: async () => ({ value: Buffer.alloc(11), done: false }) }),
    () => trackedReply({ next: async () => { throw new Error('read failed'); } }),
    () => trackedReply({ next: (() => { let sent = false; return async () => sent ? { done: true } : (sent = true, { value: Buffer.from('bad'), done: false }); })() }),
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const tracked = cases[index]();
    await assert.rejects(resolveAllImages([image([FIRST])], options({ limits: { perAssetBytes: 10, totalBytes: 100 }, request: async () => tracked.response, sharp: index === 4 ? fakeSharp({ fail: true }).sharp : fakeSharp().sharp })), { code: 'ASSET_UNAVAILABLE' });
    assert.equal(tracked.closed(), true);
  }
});

test('requires Promise headers and restores transient retry success plus the 50 MiB cap', async () => {
  await assert.rejects(resolveAllImages([image([FIRST])], options({ request: async () => ({ ok: true, status: 200, headers: { 'content-type': 'image/png' }, stream: stream() }) })), { code: 'ASSET_UNAVAILABLE' });
  let attempts = 0;
  await resolveAllImages([image([FIRST])], options({ request: async () => { attempts += 1; if (attempts === 1) throw new Error('reset'); return reply(); } }));
  assert.equal(attempts, 2);
  await assert.rejects(resolveAllImages([image([FIRST])], options({ request: async () => reply({ chunks: [Buffer.alloc(49 * 1024 * 1024), Buffer.alloc(2 * 1024 * 1024)] }) })), { code: 'ASSET_UNAVAILABLE' });
});

test('Sharp decode fallback and all-candidate failure release every earlier resolved buffer atomically', async () => {
  const decoded = fakeSharp({ fail: true });
  const result = await resolveAllImages([image([FIRST, SECOND])], options({ sharp: (buffer, opts) => buffer.toString() === 'bad' ? decoded.sharp(buffer, opts) : fakeSharp().sharp(buffer, opts), request: async (url) => reply({ chunks: [Buffer.from(url === FIRST ? 'bad' : 'good')] }) }));
  assert.equal(result[0].sourceUrl, SECOND);
  const firstDecoder = fakeSharp();
  await assert.rejects(resolveAllImages([image([FIRST]), image([SECOND], 1)], options({ sharp: firstDecoder.sharp, request: async (url) => url === FIRST ? reply({ chunks: [Buffer.from('first')] }) : reply({ ok: false, status: 404 }) })), { code: 'ASSET_UNAVAILABLE' });
  assert.ok(firstDecoder.calls[0].buffer.every((byte) => byte === 0));
});
