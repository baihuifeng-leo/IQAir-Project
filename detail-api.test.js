'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const { handleDetailApi } = require('./detail-api');

function fakeJson() {
  const calls = [];
  const json = (res, status, obj, extra = {}) => calls.push({ status, obj, extra });
  return { json, calls };
}

function fakeRunner(overrides = {}) {
  return {
    accountStatuses: async () => [{ platform: 'taobao', accountId: 'default', status: 'ready' }],
    beginLogin: async () => ({ status: 'waiting_for_scan' }),
    qrPng: async () => Buffer.from('png-bytes'),
    verify: async () => ({ status: 'ready' }),
    clearAccount: async () => ({ status: 'logged_out' }),
    listTasksFor: () => [{ id: 't1' }],
    createTask: async () => ({ id: 't1', phase: 'queued' }),
    getTaskAuthorized: () => { throw Object.assign(new Error('找不到任务'), {}); },
    cancelTask: async () => ({ id: 't1', phase: 'cancelled' }),
    ...overrides,
  };
}

const admin = { id: 'u_admin', admin: true };
const member = { id: 'u_member', admin: false };
const body = async () => ({ url: 'https://detail.tmall.com/item.htm?id=1' });

test('GET /api/platform-accounts is readable by an ordinary logged-in user', async () => {
  const { json, calls } = fakeJson();
  const handled = await handleDetailApi({ method: 'GET' }, {}, {
    p: '/api/platform-accounts', me: member, json, body, runner: fakeRunner(),
  });
  assert.equal(handled, true);
  assert.equal(calls[0].status, 200);
  assert.deepEqual(calls[0].obj.accounts, [{ platform: 'taobao', accountId: 'default', status: 'ready' }]);
});

for (const [action, method] of [['login', 'POST'], ['verify', 'POST'], ['session', 'DELETE']]) {
  test(`${method} platform-accounts .../${action} is admin-only`, async () => {
    const { json, calls } = fakeJson();
    const handled = await handleDetailApi({ method }, {}, {
      p: `/api/platform-accounts/taobao/default/${action}`, me: member, json, body, runner: fakeRunner(),
    });
    assert.equal(handled, true);
    assert.equal(calls[0].status, 403);
  });
}

test('admin login/verify/clear reach the runner and return its result', async () => {
  const { json, calls } = fakeJson();
  const runner = fakeRunner();
  await handleDetailApi({ method: 'POST' }, {}, { p: '/api/platform-accounts/taobao/default/login', me: admin, json, body, runner });
  await handleDetailApi({ method: 'POST' }, {}, { p: '/api/platform-accounts/taobao/default/verify', me: admin, json, body, runner });
  await handleDetailApi({ method: 'DELETE' }, {}, { p: '/api/platform-accounts/taobao/default/session', me: admin, json, body, runner });
  assert.deepEqual(calls.map((c) => c.obj.status), ['waiting_for_scan', 'ready', 'logged_out']);
});

test('QR endpoint is admin-only and serves the PNG with no-store', async () => {
  const { json, calls } = fakeJson();
  const memberHandled = await handleDetailApi({ method: 'GET' }, {}, {
    p: '/api/platform-accounts/taobao/default/qr', me: member, json, body, runner: fakeRunner(),
  });
  assert.equal(memberHandled, true);
  assert.equal(calls[0].status, 403);

  const headers = [];
  let ended = null;
  const res = {
    writeHead: (status, h) => headers.push({ status, h }),
    end: (buf) => { ended = buf; },
  };
  const handled = await handleDetailApi({ method: 'GET' }, res, {
    p: '/api/platform-accounts/taobao/default/qr', me: admin, json, body, runner: fakeRunner(),
  });
  assert.equal(handled, true);
  assert.equal(headers[0].status, 200);
  assert.equal(headers[0].h['Content-Type'], 'image/png');
  assert.equal(headers[0].h['Cache-Control'], 'no-store');
  assert.deepEqual(ended, Buffer.from('png-bytes'));
});

test('POST /api/detail-jobs rejects an unsupported URL before it reaches the runner', async () => {
  const { json, calls } = fakeJson();
  const runner = fakeRunner({
    createTask: async () => { throw new TypeError('无效的 URL'); },
  });
  const handled = await handleDetailApi({ method: 'POST' }, {}, {
    p: '/api/detail-jobs', me: member, json, body: async () => ({ url: 'https://evil.example.com/' }), runner,
  });
  assert.equal(handled, true);
  assert.equal(calls[0].status, 400);
});

test('GET /api/detail-jobs/:id enforces ownership through the task store', async () => {
  const { json, calls } = fakeJson();
  const runner = fakeRunner({
    getTaskAuthorized: (id, user) => {
      if (user.id !== 'owner') throw Object.assign(new Error('无权访问任务'), {});
      return { id, phase: 'completed', userId: 'owner' };
    },
  });
  const denied = await handleDetailApi({ method: 'GET' }, {}, {
    p: '/api/detail-jobs/t1', me: { id: 'someone-else' }, json, body, runner,
  });
  assert.equal(denied, true);
  assert.equal(calls[0].status, 404);

  const allowed = await handleDetailApi({ method: 'GET' }, {}, {
    p: '/api/detail-jobs/t1', me: { id: 'owner' }, json, body, runner,
  });
  assert.equal(allowed, true);
  assert.equal(calls[1].status, 200);
  assert.equal(calls[1].obj.id, 't1');
});

test('admin can read any task through the same route', async () => {
  const { json, calls } = fakeJson();
  const runner = fakeRunner({
    getTaskAuthorized: (id, user) => {
      assert.equal(user.admin, true);
      return { id, phase: 'queued', userId: 'someone-else' };
    },
  });
  await handleDetailApi({ method: 'GET' }, {}, { p: '/api/detail-jobs/t1', me: admin, json, body, runner });
  assert.equal(calls[0].status, 200);
});

test('POST cancel delegates to the runner', async () => {
  const { json, calls } = fakeJson();
  const runner = fakeRunner();
  const handled = await handleDetailApi({ method: 'POST' }, {}, { p: '/api/detail-jobs/t1/cancel', me: member, json, body, runner });
  assert.equal(handled, true);
  assert.equal(calls[0].obj.phase, 'cancelled');
});

test('download refuses an incomplete task without touching the filesystem', async () => {
  const { json, calls } = fakeJson();
  const runner = fakeRunner({
    getTaskAuthorized: () => ({ id: 't1', phase: 'composing', resultPath: null, userId: 'owner' }),
  });
  const res = { writeHead: () => { throw new Error('should not write headers'); } };
  const handled = await handleDetailApi({ method: 'GET' }, res, { p: '/api/detail-jobs/t1/download', me: { id: 'owner' }, json, body, runner });
  assert.equal(handled, true);
  assert.equal(calls[0].status, 409);
});

test('download streams a completed task result with correct headers', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'detail-api-dl-'));
  const resultPath = path.join(dir, 'result.png');
  await fsp.writeFile(resultPath, Buffer.from('fake-png'));
  const { json } = fakeJson();
  const runner = fakeRunner({
    getTaskAuthorized: () => ({ id: 't1', phase: 'completed', resultPath, resultMime: 'image/png', userId: 'owner' }),
  });
  const headers = [];
  const res = new PassThrough();
  res.writeHead = (status, h) => headers.push({ status, h });

  const handled = await handleDetailApi({ method: 'GET' }, res, { p: '/api/detail-jobs/t1/download', me: { id: 'owner' }, json, body, runner });
  assert.equal(handled, true);

  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'fake-png');
  assert.equal(headers[0].status, 200);
  assert.equal(headers[0].h['Content-Type'], 'image/png');
  assert.equal(headers[0].h['Content-Disposition'], 'attachment; filename="t1.png"');
});

test('unrelated paths are left unhandled', async () => {
  const { json } = fakeJson();
  const handled = await handleDetailApi({ method: 'GET' }, {}, { p: '/api/other', me: member, json, body, runner: fakeRunner() });
  assert.equal(handled, false);
});
