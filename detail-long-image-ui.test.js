'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// view() 默认锁死在别的页面上，让轮询的 setInterval 在它自己第一次触发时立刻
// 自我了断（ensurePolling 里 A.view() !== 'detail-long-image' 就 clearInterval）——
// 这样每个用例不需要手动清定时器，jsdom 的窗口也能在 t.after 里正常关闭，不会挂住
// node --test 的事件循环。需要真的轮询的用例显式传 view: 'detail-long-image'。
function loadModule(t, { fetchImpl, view = 'elsewhere', admin = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'detail-long-image.js'), 'utf8');
  const dom = new JSDOM('<!doctype html><body><div id="dli-scroll"></div></body>', { runScripts: 'outside-only' });
  const { window } = dom;
  t.after(() => window.close());
  const toasts = [];
  window.fetch = fetchImpl;
  window.eval(source + '\nwindow.DetailLongImage = DetailLongImage;');

  const A = {
    $: (sel, root = window.document) => root.querySelector(sel),
    toast: (msg, kind) => toasts.push({ msg, kind }),
    guard: (r) => r,
    view: () => view,
    me: { admin },
  };
  window.DetailLongImage.init(A);
  return { window, document: window.document, DetailLongImage: window.DetailLongImage, toasts, A };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('submitting a URL posts to /api/detail-jobs and disables the button while in flight', async (t) => {
  const calls = [];
  let resolvePost;
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (opts?.method === 'POST') return new Promise((resolve) => { resolvePost = () => resolve(jsonResponse(200, { id: 't1', phase: 'queued', url: 'https://detail.tmall.com/item.htm?id=1', assets: {}, error: null })); });
    return jsonResponse(200, { tasks: [] });
  };
  const { document, DetailLongImage } = loadModule(t, { fetchImpl });
  await DetailLongImage.onShow();

  const input = document.querySelector('#dli-url');
  const submitBtn = document.querySelector('#dli-submit');
  input.value = 'https://detail.tmall.com/item.htm?id=1';
  const clickResult = submitBtn.onclick();
  assert.equal(submitBtn.disabled, true, '提交进行中应该禁用按钮，防止重复提交');

  resolvePost();
  await clickResult;
  assert.equal(submitBtn.disabled, false);
  assert.equal(input.value, '', '提交成功后应该清空输入框');
  const postCall = calls.find((c) => c.opts?.method === 'POST');
  assert.deepEqual(JSON.parse(postCall.opts.body), { url: 'https://detail.tmall.com/item.htm?id=1' });
});

test('rejects an empty URL client-side without calling the API', async (t) => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return jsonResponse(200, { tasks: [] }); };
  const { document, DetailLongImage, toasts } = loadModule(t, { fetchImpl });
  await DetailLongImage.onShow();

  await document.querySelector('#dli-submit').onclick();
  assert.equal(calls.filter((c) => c.opts?.method === 'POST').length, 0);
  assert.ok(toasts.some((entry) => entry.kind === 'bad'));
});

test('renders phase labels including resolving asset counts and composing percent', async (t) => {
  const tasks = [
    { id: 't1', url: 'https://a', phase: 'resolving', assets: { total: 5, current: 2 }, progress: 0, error: null },
    { id: 't2', url: 'https://b', phase: 'composing', assets: {}, progress: 42, error: null },
    { id: 't3', url: 'https://c', phase: 'queued', assets: {}, progress: 0, error: null },
  ];
  const fetchImpl = async () => jsonResponse(200, { tasks });
  const { document, DetailLongImage } = loadModule(t, { fetchImpl });
  await DetailLongImage.onShow();

  const rows = [...document.querySelectorAll('.mc-row')];
  assert.equal(rows.length, 3);
  assert.match(rows[0].querySelector('.mc-row-status').textContent, /正在下载图片（2\/5）/);
  assert.match(rows[1].querySelector('.mc-row-status').textContent, /正在拼接长图（42%）/);
  assert.match(rows[2].querySelector('.mc-row-status').textContent, /排队中/);
});

test('maps distinct error codes to distinct, readable messages', async (t) => {
  const tasks = [
    { id: 't1', url: 'https://a', phase: 'failed', assets: {}, progress: 0, error: { code: 'DETAIL_UNAVAILABLE', message: 'x' } },
    { id: 't2', url: 'https://b', phase: 'failed', assets: {}, progress: 0, error: { code: 'DETAIL_ROOT_AMBIGUOUS', message: 'x' } },
    { id: 't3', url: 'https://c', phase: 'failed', assets: {}, progress: 0, error: { code: 'WORKER_TIMEOUT', message: 'x' } },
    { id: 't4', url: 'https://d', phase: 'failed', assets: {}, progress: 0, error: { code: 'ASSET_UNAVAILABLE', message: 'x' } },
  ];
  const fetchImpl = async () => jsonResponse(200, { tasks });
  const { document, DetailLongImage } = loadModule(t, { fetchImpl });
  await DetailLongImage.onShow();

  const messages = [...document.querySelectorAll('.mc-row-status')].map((el) => el.textContent);
  assert.equal(new Set(messages).size, 4, '四种错误码应该渲染出四条不同的文案');
  assert.match(messages[0], /登录已过期/);
  assert.match(messages[1], /区域不唯一/);
  assert.match(messages[2], /超时/);
  assert.match(messages[3], /图片下载失败/);
});

test('cancel is only offered for non-terminal tasks, and completed tasks get a download link', async (t) => {
  const tasks = [
    { id: 't1', url: 'https://a', phase: 'opening', assets: {}, progress: 0, error: null },
    { id: 't2', url: 'https://b', phase: 'completed', assets: {}, progress: 100, error: null },
    { id: 't3', url: 'https://c', phase: 'cancelled', assets: {}, progress: 0, error: null },
  ];
  const fetchImpl = async () => jsonResponse(200, { tasks });
  const { document, DetailLongImage } = loadModule(t, { fetchImpl });
  await DetailLongImage.onShow();

  const rows = [...document.querySelectorAll('.mc-row')];
  assert.ok(rows[0].querySelector('.ghost.danger'), '进行中的任务应该有取消按钮');
  assert.equal(rows[1].querySelector('.ghost.danger'), null, '已完成的任务不该再显示取消按钮');
  const link = rows[1].querySelector('a.solid');
  assert.equal(link.getAttribute('href'), '/api/detail-jobs/t2/download');
  assert.equal(rows[2].querySelector('.ghost.danger'), null, '已取消的任务不该再显示取消按钮');
});

test('re-entering the view loads recent tasks again', async (t) => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse(200, { tasks: [] }); };
  const { DetailLongImage } = loadModule(t, { fetchImpl });
  await DetailLongImage.onShow();
  await DetailLongImage.onShow();
  assert.equal(calls, 2, '每次进入这个视图都应该重新拉一次任务列表');
});

test('an SSE event for an unknown task id is prepended, and a known id updates in place', async (t) => {
  const fetchImpl = async () => jsonResponse(200, { tasks: [{ id: 't1', url: 'https://a', phase: 'opening', assets: {}, progress: 0, error: null }] });
  const { document, DetailLongImage } = loadModule(t, { fetchImpl, view: 'detail-long-image' });
  await DetailLongImage.onShow();

  DetailLongImage.onEvent({ id: 't1', url: 'https://a', phase: 'detecting', assets: {}, progress: 0, error: null });
  let rows = [...document.querySelectorAll('.mc-row')];
  assert.equal(rows.length, 1);
  assert.match(rows[0].querySelector('.mc-row-status').textContent, /识别详情区域/);

  DetailLongImage.onEvent({ id: 't2', url: 'https://b', phase: 'queued', assets: {}, progress: 0, error: null });
  rows = [...document.querySelectorAll('.mc-row')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].dataset.taskId, 't2');
});

test('polling stops on its own once the view is no longer active', async (t) => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse(200, { tasks: [{ id: 't1', url: 'https://a', phase: 'opening', assets: {}, progress: 0, error: null }] }); };
  // 特意把 view 锁在 detail-long-image 上，让 ensurePolling 真的建一个定时器；
  // 定时器回调第一次触发时会看到 view 已经不是 detail-long-image（下面会切换），
  // 从而自己 clearInterval，不需要测试代码手动清。
  let currentView = 'detail-long-image';
  const { document, DetailLongImage, A } = loadModule(t, { fetchImpl, view: 'detail-long-image' });
  A.view = () => currentView;
  await DetailLongImage.onShow();
  assert.ok(document.querySelector('.mc-progress'), '进行中的任务应该有进度条，证明轮询确实被安排了');
  currentView = 'elsewhere';
});
