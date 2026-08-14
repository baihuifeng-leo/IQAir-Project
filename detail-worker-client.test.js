'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { DetailWorkerClient } = require('./detail-worker-client');
const { createWorkerRouter } = require('./detail-worker');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.killed = false;
  }

  send(message, callback) {
    this.sent.push(message);
    callback?.();
    return true;
  }

  kill() {
    this.killed = true;
    this.emit('exit', 0, null);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('correlates out-of-order Worker responses by request id', async (t) => {
  const child = new FakeChild();
  const client = new DetailWorkerClient({ fork: () => child });
  t.after(() => client.close());

  await client.start();
  const first = client.request('session.status', { accountId: 'first' });
  const second = client.request('session.status', { accountId: 'second' });

  assert.deepEqual(child.sent.map((message) => message.kind), ['request', 'request']);
  assert.notEqual(child.sent[0].id, child.sent[1].id);

  child.emit('message', {
    kind: 'response', id: child.sent[1].id, ok: true, result: { accountId: 'second' },
  });
  child.emit('message', {
    kind: 'response', id: child.sent[0].id, ok: true, result: { accountId: 'first' },
  });

  assert.deepEqual(await first, { accountId: 'first' });
  assert.deepEqual(await second, { accountId: 'second' });
});

test('times out a request and drops its pending entry', async (t) => {
  const child = new FakeChild();
  const client = new DetailWorkerClient({ fork: () => child, timeoutMs: 15 });
  t.after(() => client.close());

  const pending = client.request('session.status', { accountId: 'default' });
  await assert.rejects(pending, (error) => error.code === 'WORKER_TIMEOUT');
  assert.equal(client.pendingCount, 0);

  child.emit('message', {
    kind: 'response', id: child.sent[0].id, ok: true, result: { stale: true },
  });
  await delay(1);
  assert.equal(client.pendingCount, 0);
});

test('discards a timed-out Worker, rejects its other requests, and starts a fresh child', async (t) => {
  const children = [new FakeChild(), new FakeChild()];
  let forks = 0;
  const client = new DetailWorkerClient({ fork: () => children[forks++], timeoutMs: 15 });
  t.after(() => client.close());

  const timedOut = client.request('session.status', { accountId: 'default' });
  const interrupted = client.request('session.verify', { accountId: 'default' }, { timeoutMs: 100 });
  await assert.rejects(timedOut, (error) => error.code === 'WORKER_TIMEOUT');
  await assert.rejects(interrupted, (error) => error.code === 'WORKER_EXITED');
  assert.equal(children[0].killed, true);
  assert.equal(client.pendingCount, 0);

  const recovered = client.request('session.status', { accountId: 'default' });
  assert.equal(forks, 2);
  children[1].emit('message', {
    kind: 'response', id: children[1].sent[0].id, ok: true, result: { status: 'ready' },
  });
  assert.deepEqual(await recovered, { status: 'ready' });
});

test('rejects every in-flight request when the Worker exits', async (t) => {
  const child = new FakeChild();
  const client = new DetailWorkerClient({ fork: () => child });
  t.after(() => client.close());

  const first = client.request('session.status', { accountId: 'first' });
  const second = client.request('session.verify', { accountId: 'second' });
  child.emit('exit', 1, 'SIGKILL');

  await assert.rejects(first, (error) => error.code === 'WORKER_EXITED');
  await assert.rejects(second, (error) => error.code === 'WORKER_EXITED');
  assert.equal(client.pendingCount, 0);
});

test('forwards Worker events without resolving a matching request', async (t) => {
  const child = new FakeChild();
  const client = new DetailWorkerClient({ fork: () => child });
  t.after(() => client.close());
  const events = [];
  client.on('event', (event) => events.push(event));

  const pending = client.request('session.status', { accountId: 'default' });
  const requestId = child.sent[0].id;
  child.emit('message', {
    kind: 'event', id: requestId, type: 'session.status', payload: { status: 'ready' },
  });

  assert.equal(await Promise.race([
    pending.then(() => 'resolved'),
    delay(5).then(() => 'still pending'),
  ]), 'still pending');
  assert.deepEqual(events, [{ type: 'session.status', payload: { status: 'ready' } }]);

  child.emit('message', {
    kind: 'response', id: requestId, ok: true, result: { status: 'ready' },
  });
  assert.deepEqual(await pending, { status: 'ready' });
});

test('drops remote stack text when rejecting a Worker response', async (t) => {
  const child = new FakeChild();
  const client = new DetailWorkerClient({ fork: () => child });
  t.after(() => client.close());

  const pending = client.request('session.verify', { accountId: 'default' });
  child.emit('message', {
    kind: 'response', id: child.sent[0].id, ok: false,
    error: { code: 'SESSION_FAILED', message: '账号验证失败\n    at privateWorker (/secret/path.js:1:1)' },
  });

  await assert.rejects(pending, (error) => (
    error.code === 'SESSION_FAILED' && error.message === '账号验证失败'
  ));
});

test('revives QR Buffer values sent through JSON child IPC', async (t) => {
  const child = new FakeChild();
  const client = new DetailWorkerClient({ fork: () => child });
  t.after(() => client.close());

  const pending = client.request('session.qr', { accountId: 'default' });
  child.emit('message', {
    kind: 'response', id: child.sent[0].id, ok: true,
    result: { type: 'Buffer', data: [137, 80, 78, 71] },
  });

  assert.deepEqual(await pending, Buffer.from([137, 80, 78, 71]));
});

test('starts a fresh Worker child after an earlier child exits', async (t) => {
  const children = [new FakeChild(), new FakeChild()];
  let calls = 0;
  const client = new DetailWorkerClient({ fork: () => children[calls++] });
  t.after(() => client.close());

  const first = await client.start();
  first.emit('exit', 1, null);
  const second = await client.start();

  assert.equal(first, children[0]);
  assert.equal(second, children[1]);
  assert.equal(calls, 2);
});

test('rejects in-flight requests and removes listeners when explicitly closed', async () => {
  const child = new FakeChild();
  const client = new DetailWorkerClient({ fork: () => child });
  const pending = client.request('detail.run', { taskId: 'task-1' });

  await client.close();

  await assert.rejects(pending, (error) => error.code === 'WORKER_CLOSED');
  assert.equal(client.pendingCount, 0);
  assert.equal(child.listenerCount('message'), 0);
  assert.equal(child.listenerCount('exit'), 0);
});

test('routes every documented Worker command and serializes Worker errors without stacks', async () => {
  const sent = [];
  const calls = [];
  const session = {
    status: async (accountId) => { calls.push(['status', accountId]); return { status: 'ready' }; },
    beginLogin: async (accountId) => { calls.push(['beginLogin', accountId]); return { status: 'waiting_for_scan' }; },
    qr: async (accountId) => { calls.push(['qr', accountId]); return Buffer.from('qr'); },
    verify: async (accountId) => { calls.push(['verify', accountId]); return { status: 'ready' }; },
    clear: async (accountId) => { calls.push(['clear', accountId]); return { status: 'logged_out' }; },
    runExclusive: async (accountId, fn) => { calls.push(['exclusive', accountId]); return fn(); },
  };
  const detail = {
    run: async (payload) => { calls.push(['run', payload.taskId]); return { accepted: true }; },
    cancel: async (payload) => { calls.push(['cancel', payload.taskId]); throw Object.assign(new Error('cancelled privately\n    at /secret/worker.js:1:1'), { code: 'DETAIL_CANCELLED', stack: 'secret stack' }); },
  };
  const route = createWorkerRouter({ session, detail, send: (message) => sent.push(message) });

  const commands = [
    'session.status', 'session.beginLogin', 'session.qr', 'session.verify', 'session.clear',
    'detail.run', 'detail.cancel',
  ];
  for (const [index, type] of commands.entries()) {
    await route({ kind: 'request', id: String(index + 1), type, payload: { accountId: 'default', taskId: 'task-1' } });
  }

  assert.deepEqual(calls, [
    ['status', 'default'], ['beginLogin', 'default'], ['qr', 'default'], ['verify', 'default'], ['clear', 'default'],
    ['exclusive', 'default'], ['run', 'task-1'], ['exclusive', 'default'], ['cancel', 'task-1'],
  ]);
  assert.deepEqual(sent.slice(0, 6).map((message) => message.kind), Array(6).fill('response'));
  assert.equal(sent[6].ok, false);
  assert.deepEqual(sent[6].error, { code: 'DETAIL_CANCELLED', message: 'cancelled privately' });
  assert.equal('stack' in sent[6].error, false);
});

test('rejects inherited object names as unknown Worker commands', async () => {
  const sent = [];
  const session = { runExclusive: async (_accountId, fn) => fn() };
  const route = createWorkerRouter({ session, send: (message) => sent.push(message) });

  await route({ kind: 'request', id: 'prototype-command', type: 'toString', payload: {} });

  assert.deepEqual(sent, [{
    kind: 'response', id: 'prototype-command', ok: false,
    error: { code: 'WORKER_COMMAND_UNKNOWN', message: '不支持的详情 Worker 命令' },
  }]);
});
