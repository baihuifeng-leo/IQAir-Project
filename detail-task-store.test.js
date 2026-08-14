'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { DetailTaskStore } = require('./detail-task-store');

async function fixture() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'detail-task-store-'));
}

const input = {
  platform: 'taobao',
  accountId: 'default',
  url: 'https://detail.tmall.com/item.htm?id=123',
  productId: '123'
};

test('creates a queued task, persists safe fields, and enforces legal phase transitions', async () => {
  const root = await fixture();
  const tasks = new DetailTaskStore(root, { now: () => 1_700_000_000_000 });
  await tasks.load();
  await assert.rejects(() => tasks.create('alice', { ...input, cookie: 'secret' }), /敏感/);
  const task = await tasks.create('alice', input);

  assert.equal(task.userId, 'alice');
  assert.equal(task.phase, 'queued');
  assert.equal(task.progress, 0);
  assert.deepEqual(task.assets, { total: 0, current: 0 });
  assert.equal(task.cookie, undefined);

  await assert.rejects(() => tasks.transition(task.id, 'composing'), /阶段|转换/);
  const opening = await tasks.transition(task.id, 'opening', { progress: 10 });
  assert.equal(opening.progress, 10);
  const detecting = await tasks.transition(task.id, 'detecting', { assets: { total: 4, current: 1 } });
  assert.deepEqual(detecting.assets, { total: 4, current: 1 });
  await tasks.transition(task.id, 'resolving');
  await tasks.transition(task.id, 'composing');
  const completed = await tasks.transition(task.id, 'completed', { progress: 100 });
  assert.equal(completed.phase, 'completed');
  assert.equal(completed.progress, 100);
  await assert.rejects(() => tasks.transition(task.id, 'failed'), /终态|阶段/);

  const raw = JSON.parse(await fsp.readFile(path.join(root, 'tasks.json'), 'utf8'));
  assert.equal(raw.tasks[0].cookie, undefined);
  await assert.rejects(() => fsp.access(path.join(root, 'tasks.json.tmp')));
});

test('restricts task visibility to its owner while admins can access all tasks', async () => {
  const root = await fixture();
  const tasks = new DetailTaskStore(root);
  await tasks.load();
  const own = await tasks.create('alice', input);
  await tasks.create('bob', { ...input, productId: '456' });

  assert.equal(tasks.listFor({ id: 'alice', admin: false }).length, 1);
  assert.equal(tasks.listFor({ id: 'admin', admin: true }).length, 2);
  assert.throws(() => tasks.getAuthorized(own.id, { id: 'other', admin: false }), /无权/);
  assert.equal(tasks.getAuthorized(own.id, { id: 'admin', admin: true }).id, own.id);
});

test('contains result files under the configured root and permits owner cancellation', async () => {
  const root = await fixture();
  const tasks = new DetailTaskStore(root);
  await tasks.load();
  const task = await tasks.create('alice', input);
  const resultPath = path.join(root, 'results', `${task.id}.png`);
  await fsp.mkdir(path.dirname(resultPath), { recursive: true });
  await fsp.writeFile(resultPath, 'png');

  await assert.rejects(
    () => tasks.transition(task.id, 'opening', { resultPath: path.join(root, '..', 'secret.png') }),
    /路径|目录/
  );
  await tasks.cancel(task.id, { id: 'alice', admin: false });
  assert.equal(tasks.getAuthorized(task.id, { id: 'alice', admin: false }).phase, 'cancelled');
  await assert.rejects(() => tasks.cancel(task.id, { id: 'alice', admin: false }), /终态|取消/);
});

test('cleans result files and terminal task metadata older than the retention window', async () => {
  const now = 1_700_000_000_000;
  const root = await fixture();
  const tasks = new DetailTaskStore(root, { now, retentionMs: 86_400_000 });
  await tasks.load();
  const task = await tasks.create('alice', input);
  const resultPath = path.join(root, 'results', `${task.id}.png`);
  await fsp.mkdir(path.dirname(resultPath), { recursive: true });
  await fsp.writeFile(resultPath, 'png');
  await fsp.utimes(resultPath, new Date(now - 86_400_001), new Date(now - 86_400_001));
  await tasks.transition(task.id, 'opening');
  await tasks.transition(task.id, 'detecting');
  await tasks.transition(task.id, 'resolving');
  await tasks.transition(task.id, 'composing');
  await tasks.transition(task.id, 'completed', { resultPath });

  await tasks.cleanupExpired();
  await assert.rejects(() => fsp.access(resultPath));
  assert.equal(tasks.listFor({ id: 'alice', admin: false }).length, 0);
});
