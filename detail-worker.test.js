'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDetailRunner } = require('./detail-worker');

const PRODUCT_URL = 'https://detail.tmall.com/item.htm?id=123';

function fakeSession(page) {
  const calls = [];
  return {
    calls,
    pageForDetail: async (accountId, url, { signal } = {}) => {
      calls.push({ accountId, url, signal });
      return page;
    },
  };
}

test('runs opening→detecting→resolving→composing in order and forwards result', async () => {
  const page = { marker: 'page' };
  const session = fakeSession(page);
  const events = [];
  const emit = (type, data) => events.push({ type, data });

  const extract = async (p, { emit: onDetect }) => {
    assert.equal(p, page);
    onDetect({ observed: 1 });
    return { blocks: ['block-a'] };
  };
  const resolve = async (blocks, { emit: onResolve }) => {
    assert.deepEqual(blocks, ['block-a']);
    onResolve({ assetIndex: 0, resolved: true });
    return ['resolved-a'];
  };
  const compose = async (blocks, { outputPath, emit: onCompose }) => {
    assert.deepEqual(blocks, ['resolved-a']);
    assert.equal(outputPath, '/tmp/out.png');
    onCompose({ stripTop: 0 });
    return { width: 10, height: 10, size: 100, sha256: 'abc' };
  };

  const runner = createDetailRunner(session, { extract, resolve, compose });
  const result = await runner.run(
    { accountId: 'acc1', url: PRODUCT_URL, outputPath: '/tmp/out.png' },
    { emit },
  );

  assert.deepEqual(result, { width: 10, height: 10, size: 100, sha256: 'abc' });
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0].accountId, 'acc1');
  assert.equal(session.calls[0].url, PRODUCT_URL);

  const phases = events.filter((e) => e.type === 'phase').map((e) => e.data.phase);
  assert.deepEqual(phases, ['opening', 'detecting', 'detecting', 'resolving', 'resolving', 'composing', 'composing']);
});

test('rejects unsupported navigation targets before touching the session', async () => {
  const session = fakeSession({});
  const runner = createDetailRunner(session, {
    extract: async () => { throw new Error('should not be called'); },
    resolve: async () => { throw new Error('should not be called'); },
    compose: async () => { throw new Error('should not be called'); },
  });

  await assert.rejects(
    runner.run({ accountId: 'acc1', url: 'https://evil.example.com/', outputPath: '/tmp/out.png' }, {}),
  );
  assert.equal(session.calls.length, 0);
});

test('rejects when outputPath is missing', async () => {
  const session = fakeSession({});
  const runner = createDetailRunner(session, {});
  await assert.rejects(
    runner.run({ accountId: 'acc1', url: PRODUCT_URL }, {}),
    { code: 'DETAIL_UNAVAILABLE' },
  );
  assert.equal(session.calls.length, 0);
});

test('stops after detecting when the signal is already aborted', async () => {
  const session = fakeSession({});
  const controller = new AbortController();
  const extract = async () => {
    controller.abort();
    return { blocks: [] };
  };
  const runner = createDetailRunner(session, {
    extract,
    resolve: async () => { throw new Error('should not be called'); },
    compose: async () => { throw new Error('should not be called'); },
  });

  await assert.rejects(
    runner.run(
      { accountId: 'acc1', url: PRODUCT_URL, outputPath: '/tmp/out.png' },
      { signal: controller.signal },
    ),
    { code: 'DETAIL_CANCELLED' },
  );
});
