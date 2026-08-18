'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { DetailWorkerClient } = require('./detail-worker-client');
const { createWorkerRouter, serializeError } = require('./detail-worker');

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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
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

test('times out a request, drops its pending entry, and signals Worker cancellation', async (t) => {
  const child = new FakeChild();
  const client = new DetailWorkerClient({ fork: () => child, timeoutMs: 15 });
  t.after(() => client.close());

  const pending = client.request('session.status', { accountId: 'default' });
  await assert.rejects(pending, (error) => error.code === 'WORKER_TIMEOUT');
  assert.equal(client.pendingCount, 0);
  assert.deepEqual(child.sent[1], { kind: 'cancel', id: child.sent[0].id });

  child.emit('message', {
    kind: 'response', id: child.sent[0].id, ok: true, result: { stale: true },
  });
  await delay(1);
  assert.equal(client.pendingCount, 0);
});

test('a request timeout does not kill a Worker serving other requests', async (t) => {
  const children = [new FakeChild(), new FakeChild()];
  let forks = 0;
  const client = new DetailWorkerClient({ fork: () => children[forks++], timeoutMs: 15 });
  t.after(() => client.close());

  const timedOut = client.request('session.status', { accountId: 'default' });
  const interrupted = client.request('session.verify', { accountId: 'default' }, { timeoutMs: 100 });
  await assert.rejects(timedOut, (error) => error.code === 'WORKER_TIMEOUT');
  await assert.rejects(interrupted, (error) => error.code === 'WORKER_TIMEOUT');
  assert.equal(children[0].killed, false);
  assert.equal(client.pendingCount, 0);

  const recovered = client.request('session.status', { accountId: 'default' });
  assert.equal(forks, 1);
  const recoveredEnvelope = children[0].sent.findLast((message) => message.kind === 'request');
  children[0].emit('message', {
    kind: 'response', id: recoveredEnvelope.id, ok: true, result: { status: 'ready' },
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

test('discards and terminates a disconnected Worker before restarting', async (t) => {
  const children = [new FakeChild(), new FakeChild()];
  let forks = 0;
  const client = new DetailWorkerClient({ fork: () => children[forks++] });
  t.after(() => client.close());

  const first = client.request('session.status', { accountId: 'default' });
  const second = client.request('session.verify', { accountId: 'default' });
  children[0].emit('disconnect');

  await assert.rejects(first, (error) => error.code === 'WORKER_EXITED');
  await assert.rejects(second, (error) => error.code === 'WORKER_EXITED');
  assert.equal(children[0].killed, true);

  const recovered = client.request('session.status', { accountId: 'default' });
  children[1].emit('message', {
    kind: 'response', id: children[1].sent[0].id, ok: true, result: { status: 'ready' },
  });
  assert.deepEqual(await recovered, { status: 'ready' });
  assert.equal(forks, 2);
});

test('a send callback failure terminates the Worker and rejects all in-flight requests', async (t) => {
  const child = new FakeChild();
  let sendCount = 0;
  child.send = function send(message, callback) {
    this.sent.push(message);
    sendCount += 1;
    if (sendCount === 2) callback?.(new Error('channel closed'));
    else callback?.();
    return sendCount !== 2;
  };
  const client = new DetailWorkerClient({ fork: () => child });
  t.after(() => client.close());

  const first = client.request('session.status', { accountId: 'default' });
  const second = client.request('session.verify', { accountId: 'default' });

  await assert.rejects(first, (error) => error.code === 'WORKER_EXITED');
  await assert.rejects(second, (error) => error.code === 'WORKER_EXITED');
  assert.equal(child.killed, true);
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
    error.code === 'SESSION_FAILED' && error.message === '详情 Worker 请求失败'
  ));
});

test('redacts credentials, signed URLs, and local paths at both IPC boundaries', async (t) => {
  const secrets = [
    'Cookie: sid=private-value',
    'sid=private-value',
    'Authorization: Bearer private-token',
    'request failed https://img.example/item.jpg?sig=private&expires=9',
    'profile failed at /srv/private/profile',
  ];
  for (const secret of secrets) {
    assert.deepEqual(serializeError(Object.assign(new Error(secret), { code: 'SESSION_FAILED' })), {
      code: 'SESSION_FAILED', message: '详情服务发生错误',
    });
  }

  const child = new FakeChild();
  const client = new DetailWorkerClient({ fork: () => child });
  t.after(() => client.close());
  const pending = client.request('session.verify', { accountId: 'default' });
  child.emit('message', {
    kind: 'response', id: child.sent[0].id, ok: false,
    error: { code: 'SESSION_FAILED', message: secrets[0] },
  });
  await assert.rejects(pending, (error) => (
    error.code === 'SESSION_FAILED' && error.message === '详情 Worker 请求失败'
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

test('routes every documented Worker command and treats cancellation of an inactive task as idempotent', async () => {
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
    ['exclusive', 'default'], ['run', 'task-1'],
  ]);
  assert.deepEqual(sent.map((message) => message.kind), Array(7).fill('response'));
  assert.deepEqual(sent[6], {
    kind: 'response', id: '7', ok: true, result: { cancelled: false },
  });
});

test('detail.cancel aborts a running detail task out of band without entering the account lock', async () => {
  const sent = [];
  const runStarted = deferred();
  const fallbackFinish = deferred();
  let lockTail = Promise.resolve();
  let lockCalls = 0;
  let receivedSignal;
  const session = {
    runExclusive(_accountId, fn) {
      lockCalls += 1;
      const result = lockTail.then(fn);
      lockTail = result.catch(() => {});
      return result;
    },
  };
  const detail = {
    run: async (_payload, { signal } = {}) => {
      receivedSignal = signal;
      runStarted.resolve();
      if (!signal) return fallbackFinish.promise;
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'DETAIL_CANCELLED' });
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {
          code: 'DETAIL_CANCELLED',
        })), { once: true });
        fallbackFinish.promise.then(resolve, reject);
      });
    },
    cancel: async () => ({ legacyCancel: true }),
  };
  const route = createWorkerRouter({ session, detail, send: (message) => sent.push(message) });

  const running = route({
    kind: 'request', id: 'run', type: 'detail.run',
    payload: { accountId: 'default', taskId: 'task-1' },
  });
  await runStarted.promise;
  const cancelling = route({
    kind: 'request', id: 'cancel', type: 'detail.cancel',
    payload: { accountId: 'default', taskId: 'task-1' },
  });
  const outcome = await Promise.race([
    cancelling.then(() => 'cancelled'),
    delay(20).then(() => 'blocked'),
  ]);
  fallbackFinish.resolve({ completed: true });
  await Promise.all([running, cancelling]);

  assert.equal(outcome, 'cancelled');
  assert.equal(lockCalls, 1);
  assert.equal(receivedSignal instanceof AbortSignal, true);
  assert.equal(receivedSignal.aborted, true);
  assert.deepEqual(sent.find((message) => message.id === 'cancel'), {
    kind: 'response', id: 'cancel', ok: true, result: { cancelled: true },
  });
  assert.deepEqual(sent.find((message) => message.id === 'run').error, {
    code: 'DETAIL_CANCELLED', message: '任务已取消',
  });
});

test('rejects a duplicate detail task key instead of replacing the running controller', async () => {
  const sent = [];
  const firstStarted = deferred();
  const firstFinish = deferred();
  let runs = 0;
  const session = { runExclusive: async (_accountId, fn) => fn() };
  const detail = {
    run: async () => {
      runs += 1;
      if (runs === 1) {
        firstStarted.resolve();
        return firstFinish.promise;
      }
      return { duplicateRan: true };
    },
  };
  const route = createWorkerRouter({ session, detail, send: (message) => sent.push(message) });
  const first = route({
    kind: 'request', id: 'first', type: 'detail.run',
    payload: { accountId: 'default', taskId: 'task-1' },
  });
  await firstStarted.promise;

  await route({
    kind: 'request', id: 'duplicate', type: 'detail.run',
    payload: { accountId: 'default', taskId: 'task-1' },
  });
  firstFinish.resolve({ completed: true });
  await first;

  assert.equal(runs, 1);
  assert.deepEqual(sent.find((message) => message.id === 'duplicate'), {
    kind: 'response', id: 'duplicate', ok: false,
    error: { code: 'ACCOUNT_BUSY', message: '该账号正忙' },
  });
});

test('transport cancellation aborts the matching routed request without sending a second response', async () => {
  const sent = [];
  const started = deferred();
  const fallbackFinish = deferred();
  let receivedSignal;
  const session = {
    status: async (_accountId, { signal } = {}) => {
      receivedSignal = signal;
      started.resolve();
      if (!signal) return fallbackFinish.promise;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {
          code: 'WORKER_REQUEST_CANCELLED',
        })), { once: true });
        fallbackFinish.promise.then(resolve, reject);
      });
    },
  };
  const route = createWorkerRouter({ session, send: (message) => sent.push(message) });
  const pending = route({
    kind: 'request', id: 'probe', type: 'session.status', payload: { accountId: 'default' },
  });
  await started.promise;
  await route({ kind: 'cancel', id: 'probe' });
  const outcome = await Promise.race([
    pending.then(() => 'cancelled'),
    delay(20).then(() => 'blocked'),
  ]);
  fallbackFinish.resolve({ status: 'ready' });
  await pending;

  assert.equal(outcome, 'cancelled');
  assert.equal(receivedSignal instanceof AbortSignal, true);
  assert.equal(receivedSignal.aborted, true);
  assert.deepEqual(sent, [{
    kind: 'response', id: 'probe', ok: false,
    error: { code: 'WORKER_REQUEST_CANCELLED', message: '请求已取消' },
  }]);
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
