'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { DetailJobRunner } = require('./detail-job-runner');

async function fixture() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'detail-job-runner-'));
}

class FakeWorkerClient extends EventEmitter {
  constructor() {
    super();
    this.requests = [];
    this.closed = false;
    this.responder = async () => ({});
  }
  request(type, payload, opts) {
    this.requests.push({ type, payload, opts });
    return this.responder(type, payload, opts);
  }
  close() { this.closed = true; }
}

const URL_A = 'https://detail.tmall.com/item.htm?id=1';

test('createTask persists a queued task and reaches completed as worker events arrive', async () => {
  const dataDir = await fixture();
  const worker = new FakeWorkerClient();
  const events = [];
  const runner = new DetailJobRunner({ dataDir, workerClient: worker, broadcast: (name, data) => events.push({ name, data }) });
  await runner.start();

  // 真实 worker 的阶段事件之间隔着秒级的实际工作（开浏览器、等 DOM 稳定、逐张下载图片、
  // 逐条带合成），不会背靠背同步触发。DetailTaskStore.transition() 在 await 落盘期间
  // 会先同步更新内存里的 task 对象，如果测试背靠背触发多个阶段事件，clone(task) 在
  // 落盘 resolve 时读到的会是后续阶段已经写入的最新值而不是触发那一刻的阶段——这是存储
  // 层"广播即最新状态"的合理行为，不是 bug，只是要求测试用真实间隔来模拟，而不是零延迟连发。
  const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
  worker.responder = async (type, payload) => {
    if (type !== 'detail.run') return {};
    worker.emit('event', { type: 'phase', payload: { taskId: payload.taskId, phase: 'opening' } });
    await tick();
    worker.emit('event', { type: 'phase', payload: { taskId: payload.taskId, phase: 'detecting' } });
    await tick();
    worker.emit('event', { type: 'phase', payload: { taskId: payload.taskId, phase: 'resolving', assets: { total: 2, current: 1 } } });
    await tick();
    worker.emit('event', { type: 'phase', payload: { taskId: payload.taskId, phase: 'composing', writtenRows: 512, totalHeight: 1024 } });
    await tick();
    return { size: 12345, sha256: 'deadbeef' };
  };

  const task = await runner.createTask({ id: 'alice' }, { url: URL_A });
  assert.equal(task.phase, 'queued');

  // 用广播事件本身（而不是轮询任务存储）作为"任务已完成"的信号：transition() 会在
  // 落盘完成、返回给 _runTask 之前就已经同步更新了内存里的 task 对象，轮询存储会在
  // broadcast('completed') 真正调用之前就提前看到 completed，导致断言时事件还没到。
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (events.some((e) => e.data.phase === 'completed')) { clearInterval(check); resolve(); }
    }, 5);
  });

  const finalTask = runner.getTaskAuthorized(task.id, { id: 'alice' });
  assert.equal(finalTask.resultBytes, 12345);
  assert.equal(finalTask.resultMime, 'image/png');
  assert.equal(finalTask.assets.total, 2);
  assert.equal(finalTask.progress, 50);

  const runRequest = worker.requests.find((r) => r.type === 'detail.run');
  assert.equal(runRequest.payload.accountId, 'default');
  assert.equal(runRequest.payload.url, URL_A);
  assert.ok(runRequest.payload.outputPath.includes(task.id));

  const broadcastPhases = events.filter((e) => e.name === 'detail-job').map((e) => e.data.phase);
  assert.deepEqual(broadcastPhases, ['opening', 'detecting', 'resolving', 'composing', 'completed']);

  await runner.stop();
});

test('a worker rejection marks the task failed with a safe error and still broadcasts', async () => {
  const dataDir = await fixture();
  const worker = new FakeWorkerClient();
  const events = [];
  const runner = new DetailJobRunner({ dataDir, workerClient: worker, broadcast: (name, data) => events.push({ name, data }) });
  await runner.start();
  worker.responder = async () => { throw Object.assign(new Error('详情服务发生错误'), { code: 'WORKER_ERROR' }); };

  const task = await runner.createTask({ id: 'alice' }, { url: URL_A });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const finalTask = runner.getTaskAuthorized(task.id, { id: 'alice' });
  assert.equal(finalTask.phase, 'failed');
  assert.equal(finalTask.error.code, 'WORKER_ERROR');
  assert.ok(events.some((e) => e.data.phase === 'failed'));
  await runner.stop();
});

test('cancelTask asks the worker to cancel and marks the task cancelled', async () => {
  const dataDir = await fixture();
  const worker = new FakeWorkerClient();
  const runner = new DetailJobRunner({ dataDir, workerClient: worker });
  await runner.start();
  worker.responder = async (type) => (type === 'detail.run' ? new Promise(() => {}) : { cancelled: true });

  const task = await runner.createTask({ id: 'alice' }, { url: URL_A });
  const cancelled = await runner.cancelTask(task.id, { id: 'alice' });

  assert.equal(cancelled.phase, 'cancelled');
  const cancelRequest = worker.requests.find((r) => r.type === 'detail.cancel');
  assert.equal(cancelRequest.payload.taskId, task.id);
  await runner.stop();
});

test('another user cannot cancel or read someone else\'s task', async () => {
  const dataDir = await fixture();
  const worker = new FakeWorkerClient();
  const runner = new DetailJobRunner({ dataDir, workerClient: worker });
  await runner.start();
  worker.responder = async () => new Promise(() => {});

  const task = await runner.createTask({ id: 'alice' }, { url: URL_A });
  assert.throws(() => runner.getTaskAuthorized(task.id, { id: 'mallory' }), /无权/);
  await assert.rejects(() => runner.cancelTask(task.id, { id: 'mallory' }), /无权/);
  await runner.stop();
});

test('createTask refuses new work once the runner has stopped accepting', async () => {
  const dataDir = await fixture();
  const worker = new FakeWorkerClient();
  const runner = new DetailJobRunner({ dataDir, workerClient: worker });
  await runner.start();
  await runner.stop();

  await assert.rejects(() => runner.createTask({ id: 'alice' }, { url: URL_A }), (error) => error.status === 503);
  assert.equal(worker.closed, true);
});

test('accountStatuses reflects a session record written by the worker via disk', async () => {
  const dataDir = await fixture();
  const worker = new FakeWorkerClient();
  const runner = new DetailJobRunner({ dataDir, workerClient: worker });
  await runner.start();

  const before = await runner.accountStatuses();
  assert.deepEqual(before.map((a) => a.status), ['logged_out']);

  const { PlatformSessionStore } = require('./platform-session-store');
  const writer = new PlatformSessionStore(path.join(dataDir, 'platform-sessions'));
  await writer.load();
  await writer.setStatus('taobao', 'default', 'ready', { accountName: 'shop-1' });

  const after = await runner.accountStatuses();
  assert.equal(after[0].status, 'ready');
  assert.equal(after[0].accountName, 'shop-1');
  await runner.stop();
});
