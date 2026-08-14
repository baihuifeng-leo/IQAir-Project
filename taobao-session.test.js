'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { TaobaoSession } = require('./taobao-session');

async function fixture() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'taobao-session-'));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeLocator {
  constructor({ visible = false, screenshot } = {}) {
    this.visible = visible;
    this.screenshotImpl = screenshot;
    this.screenshotCalls = 0;
  }

  async count() {
    return this.visible ? 1 : 0;
  }

  async isVisible() {
    return this.visible;
  }

  async screenshot() {
    this.screenshotCalls += 1;
    if (!this.screenshotImpl) throw new Error('不是二维码元素');
    return this.screenshotImpl();
  }
}

class FakePage {
  constructor({ afterGoto = 'https://i.taobao.com/my_taobao.htm', gotoError = null, locators = {}, responseStatus = 200 } = {}) {
    this.currentUrl = 'about:blank';
    this.afterGoto = afterGoto;
    this.gotoError = gotoError;
    this.locators = locators;
    this.gotoCalls = [];
    this.closed = false;
    this.responseStatus = responseStatus;
  }

  async goto(url) {
    this.gotoCalls.push(url);
    if (this.gotoError) throw this.gotoError;
    this.currentUrl = this.afterGoto;
    return { status: () => this.responseStatus, ok: () => this.responseStatus >= 200 && this.responseStatus < 300 };
  }

  url() {
    return this.currentUrl;
  }

  locator(selector) {
    return this.locators[selector] || new FakeLocator();
  }

  async close() {
    this.closed = true;
  }
}

class FakeContext extends EventEmitter {
  constructor(page) {
    super();
    this.page = page;
    this.closed = false;
    this.newPageCalls = 0;
  }

  pages() {
    return [this.page];
  }

  async newPage() {
    this.newPageCalls += 1;
    return this.page;
  }

  async close() {
    this.closed = true;
    this.emit('close');
  }
}

function fakeChromium(pageFactory) {
  const launches = [];
  return {
    launches,
    chromium: {
      async launchPersistentContext(accountDir, options) {
        const page = pageFactory(launches.length);
        const context = new FakeContext(page);
        launches.push({ accountDir, options, page, context });
        return context;
      },
    },
  };
}

function fakeStatusStore() {
  const calls = [];
  return {
    calls,
    async setStatus(platform, accountId, status, patch = {}) {
      const record = { platform, accountId, status, ...patch };
      calls.push(record);
      return record;
    },
  };
}

test('reuses exactly one persistent context for an account directory', async (t) => {
  const dataDir = await fixture();
  const { chromium, launches } = fakeChromium(() => new FakePage());
  const statusStore = fakeStatusStore();
  const session = new TaobaoSession({ dataDir, chromium, statusStore, emit: () => {} });
  t.after(() => session.clear('default'));

  assert.equal((await session.status('default')).status, 'ready');
  assert.equal((await session.status('default')).status, 'ready');

  assert.equal(launches.length, 1);
  assert.equal(launches[0].accountDir, path.join(dataDir, 'default'));
  assert.deepEqual(launches[0].options, {
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  assert.ok(launches[0].page.gotoCalls.every((url) => url === 'https://i.taobao.com/my_taobao.htm'));
  assert.deepEqual(statusStore.calls.map((call) => call.status), ['ready', 'ready']);
});

test('serializes operations for one account and releases the lock after completion', async () => {
  const dataDir = await fixture();
  const { chromium } = fakeChromium(() => new FakePage());
  const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });
  const entered = [];
  const firstMayFinish = deferred();
  const firstEntered = deferred();

  const first = session.runExclusive('default', async () => {
    entered.push('first');
    firstEntered.resolve();
    await firstMayFinish.promise;
  });
  await firstEntered.promise;
  const second = session.runExclusive('default', async () => { entered.push('second'); });

  await Promise.resolve();
  assert.deepEqual(entered, ['first']);
  firstMayFinish.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(entered, ['first', 'second']);
});

test('bounds waiting operations without counting the active operation as queued', async () => {
  const dataDir = await fixture();
  const { chromium } = fakeChromium(() => new FakePage());
  const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });
  session.maxQueue = 1;
  const firstEntered = deferred();
  const firstFinish = deferred();
  const secondEntered = deferred();
  const secondFinish = deferred();
  const entered = [];

  const first = session.runExclusive('default', async () => {
    entered.push('first');
    firstEntered.resolve();
    await firstFinish.promise;
  });
  await firstEntered.promise;
  const second = session.runExclusive('default', async () => {
    entered.push('second');
    secondEntered.resolve();
    await secondFinish.promise;
  }).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  const secondState = await Promise.race([
    secondEntered.promise.then(() => 'entered'),
    second.then((result) => result.ok ? 'completed' : 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('queued'), 5)),
  ]);
  if (secondState !== 'queued') {
    firstFinish.resolve();
    await first;
    assert.equal(secondState, 'queued');
    return;
  }
  const overflow = session.runExclusive('default', async () => { entered.push('overflow'); });
  await assert.rejects(overflow, (error) => (
    error.code === 'ACCOUNT_BUSY' && error.message === '该账号正忙'
  ));

  firstFinish.resolve();
  await secondEntered.promise;
  const third = session.runExclusive('default', async () => { entered.push('third'); });
  secondFinish.resolve();
  const [, secondResult] = await Promise.all([first, second, third]);

  assert.equal(secondResult.ok, true);
  assert.deepEqual(entered, ['first', 'second', 'third']);
});

test('removes an aborted waiter immediately and reopens its bounded queue slot', async () => {
  const dataDir = await fixture();
  const { chromium } = fakeChromium(() => new FakePage());
  const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });
  session.maxQueue = 1;
  const activeEntered = deferred();
  const activeFinish = deferred();
  const entered = [];
  const active = session.runExclusive('default', async () => {
    entered.push('active');
    activeEntered.resolve();
    await activeFinish.promise;
  });
  await activeEntered.promise;

  const controller = new AbortController();
  const abandoned = session.runExclusive('default', async () => {
    entered.push('abandoned');
  }, { signal: controller.signal });
  controller.abort();
  const abortOutcome = Promise.race([
    abandoned.then(() => 'resolved', (error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 20)),
  ]);
  const replacement = session.runExclusive('default', async () => { entered.push('replacement'); });
  const settled = Promise.allSettled([active, abandoned, replacement]);
  const beforeRelease = await abortOutcome;
  activeFinish.resolve();
  await settled;

  assert.equal(beforeRelease, 'WORKER_REQUEST_CANCELLED');
  assert.deepEqual(entered, ['active', 'replacement']);
});

test('propagates request cancellation through a queued session command before browser access', async () => {
  const dataDir = await fixture();
  const { chromium, launches } = fakeChromium(() => new FakePage());
  const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });
  const blockerEntered = deferred();
  const blockerFinish = deferred();
  const blocker = session.runExclusive('default', async () => {
    blockerEntered.resolve();
    await blockerFinish.promise;
  });
  await blockerEntered.promise;

  const controller = new AbortController();
  const probe = session.status('default', { signal: controller.signal });
  controller.abort();
  const outcome = await Promise.race([
    probe.then(() => 'resolved', (error) => error.code),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 20)),
  ]);
  blockerFinish.resolve();
  await Promise.allSettled([blocker, probe]);

  assert.equal(outcome, 'WORKER_REQUEST_CANCELLED');
  assert.equal(launches.length, 0);
});

test('captures only the QR element and keeps the screenshot bytes in memory', async (t) => {
  const dataDir = await fixture();
  const qrBytes = Buffer.from('fake-png-qr');
  const qr = new FakeLocator({ visible: true, screenshot: () => qrBytes });
  const { chromium } = fakeChromium(() => new FakePage({
    afterGoto: 'https://login.taobao.com/member/login.jhtml',
    locators: { '.qrcode-img': qr },
  }));
  const statusStore = fakeStatusStore();
  const session = new TaobaoSession({ dataDir, chromium, statusStore, emit: () => {} });
  t.after(() => session.clear('default'));

  const state = await session.beginLogin('default');

  assert.equal(state.status, 'waiting_for_scan');
  assert.equal(qr.screenshotCalls, 1);
  assert.deepEqual(await session.qr('default'), qrBytes);
  assert.equal(statusStore.calls.at(-1).qr, undefined);
  assert.deepEqual(await fsp.readdir(dataDir), ['default']);
  assert.equal((await fsp.stat(path.join(dataDir, 'default'))).mode & 0o777, 0o700);
  assert.deepEqual(await fsp.readdir(path.join(dataDir, 'default')), []);
});

test('locks the session root to 0700 before launching a profile', async () => {
  const dataDir = await fixture();
  await fsp.chmod(dataDir, 0o777);
  const { chromium } = fakeChromium(() => new FakePage());
  const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });

  assert.equal((await session.status('default')).status, 'ready');
  assert.equal((await fsp.stat(dataDir)).mode & 0o777, 0o700);
  await session.clear('default');
});

test('rejects a symlinked account profile before Chromium can access its target', async () => {
  const dataDir = await fixture();
  const outsideDir = await fixture();
  await fsp.writeFile(path.join(outsideDir, 'session-secret'), 'private');
  await fsp.symlink(outsideDir, path.join(dataDir, 'default'));
  const { chromium, launches } = fakeChromium(() => new FakePage());
  const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });

  assert.equal((await session.status('default')).status, 'unavailable');
  assert.equal(launches.length, 0);
  assert.equal(await fsp.readFile(path.join(outsideDir, 'session-secret'), 'utf8'), 'private');
  assert.equal((await fsp.lstat(path.join(dataDir, 'default'))).isSymbolicLink(), true);
});

test('marks a session ready only after a successful protected-page probe', async (t) => {
  const dataDir = await fixture();
  const { chromium } = fakeChromium(() => new FakePage({ gotoError: new Error('network offline') }));
  const statusStore = fakeStatusStore();
  const session = new TaobaoSession({ dataDir, chromium, statusStore, emit: () => {} });
  t.after(() => session.clear('default'));

  const state = await session.status('default');

  assert.equal(state.status, 'unavailable');
  assert.notEqual(state.status, 'ready');
  assert.equal(statusStore.calls.at(-1).status, 'unavailable');
});

test('evicts a context after a fatal page error and rebuilds it on retry', async () => {
  const dataDir = await fixture();
  const fatal = Object.assign(new Error('Target page, context or browser has been closed'), {
    name: 'TargetClosedError',
  });
  const { chromium, launches } = fakeChromium((index) => (
    index === 0 ? new FakePage({ gotoError: fatal }) : new FakePage()
  ));
  const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });

  assert.equal((await session.status('default')).status, 'unavailable');
  assert.equal(launches[0].context.closed, true);
  assert.equal((await session.status('default')).status, 'ready');
  assert.equal(launches.length, 2);
  await session.clear('default');
});

test('evicts and rebuilds a context after Playwright reports a crashed page', async () => {
  const dataDir = await fixture();
  const { chromium, launches } = fakeChromium((index) => (
    index === 0 ? new FakePage({ gotoError: new Error('page.goto: Page crashed') }) : new FakePage()
  ));
  const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });

  assert.equal((await session.status('default')).status, 'unavailable');
  assert.equal(launches[0].context.closed, true);
  assert.equal((await session.status('default')).status, 'ready');
  assert.equal(launches.length, 2);
  await session.clear('default');
});

test('evicts a cached context when Playwright reports its close event', async () => {
  const dataDir = await fixture();
  const { chromium, launches } = fakeChromium(() => new FakePage());
  const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });

  assert.equal((await session.status('default')).status, 'ready');
  launches[0].context.closed = true;
  launches[0].context.emit('close');
  assert.equal((await session.status('default')).status, 'ready');
  assert.equal(launches.length, 2);
  await session.clear('default');
});

test('requires exact HTTPS protected URL and a successful response before ready', async () => {
  const cases = [
    { afterGoto: 'https://i.taobao.com/my_taobao.htm', responseStatus: 500 },
    { afterGoto: 'http://i.taobao.com/my_taobao.htm', responseStatus: 200 },
    { afterGoto: 'https://i.taobao.com:444/my_taobao.htm', responseStatus: 200 },
    { afterGoto: 'https://i.taobao.com/unrelated', responseStatus: 200 },
  ];
  for (const options of cases) {
    const dataDir = await fixture();
    const { chromium } = fakeChromium(() => new FakePage(options));
    const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });
    assert.equal((await session.status('default')).status, 'unavailable');
    await session.clear('default');
  }
});

test('does not trust a protected-page probe redirected to an unapproved host', async (t) => {
  const dataDir = await fixture();
  const { chromium } = fakeChromium(() => new FakePage({ afterGoto: 'https://example.invalid/interstitial' }));
  const statusStore = fakeStatusStore();
  const session = new TaobaoSession({ dataDir, chromium, statusStore, emit: () => {} });
  t.after(() => session.clear('default'));

  const state = await session.status('default');

  assert.equal(state.status, 'unavailable');
  assert.equal(statusStore.calls.at(-1).errorCode, 'PROBE_REDIRECTED');
});

test('does not capture a login QR after navigation redirects outside official login hosts', async (t) => {
  const dataDir = await fixture();
  const qr = new FakeLocator({ visible: true, screenshot: () => Buffer.from('phishing-qr') });
  const { chromium } = fakeChromium(() => new FakePage({
    afterGoto: 'https://example.invalid/login', locators: { '.qrcode-img': qr },
  }));
  const statusStore = fakeStatusStore();
  const session = new TaobaoSession({ dataDir, chromium, statusStore, emit: () => {} });
  t.after(() => session.clear('default'));

  const state = await session.beginLogin('default');

  assert.equal(state.status, 'unavailable');
  assert.equal(statusStore.calls.at(-1).errorCode, 'LOGIN_REDIRECTED');
  assert.equal(qr.screenshotCalls, 0);
  await assert.rejects(() => session.qr('default'), (error) => error.code === 'QR_UNAVAILABLE');
});

test('maps login and challenge evidence to distinct session states', async (t) => {
  const dataDir = await fixture();
  const login = new FakeLocator({ visible: true });
  const challenge = new FakeLocator({ visible: true });
  let page;
  const { chromium } = fakeChromium(() => {
    page = new FakePage({ locators: { 'input[name="fm-login-id"]': login } });
    return page;
  });
  const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });
  t.after(() => session.clear('default'));

  assert.equal((await session.status('default')).status, 'logged_out');
  page.locators = { '#nocaptcha': challenge };
  assert.equal((await session.status('default')).status, 'challenge_required');
});

test('marks a previously logged-in session expired when verification reaches login', async (t) => {
  const dataDir = await fixture();
  const { chromium } = fakeChromium(() => new FakePage({
    locators: { 'input[name="fm-login-id"]': new FakeLocator({ visible: true }) },
  }));
  const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });
  t.after(() => session.clear('default'));

  assert.equal((await session.verify('default')).status, 'expired');
});

test('invalidates QR bytes on terminal state and after their short expiry', async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const dataDir = await fixture();
    const qr = new FakeLocator({ visible: true, screenshot: () => Buffer.from('generation-1') });
    const page = new FakePage({
      afterGoto: 'https://login.taobao.com/member/login.jhtml',
      locators: { '.qrcode-img': qr },
    });
    const { chromium } = fakeChromium(() => page);
    const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });

    await session.beginLogin('default');
    now += 120_001;
    await assert.rejects(() => session.qr('default'), (error) => error.code === 'QR_UNAVAILABLE');

    now += 1;
    await session.beginLogin('default');
    page.afterGoto = 'https://login.taobao.com/member/login.jhtml';
    page.locators = { 'input[name="fm-login-id"]': new FakeLocator({ visible: true }) };
    assert.equal((await session.status('default')).status, 'logged_out');
    await assert.rejects(() => session.qr('default'), (error) => error.code === 'QR_UNAVAILABLE');
    await session.clear('default');
  } finally {
    Date.now = originalNow;
  }
});

test('clear attempts every page and context close and never reports logged_out on failure', async () => {
  const dataDir = await fixture();
  const closeCalls = [];
  const firstPage = new FakePage();
  firstPage.close = async () => { closeCalls.push('first-page'); throw new Error('page close failed'); };
  const secondPage = new FakePage();
  secondPage.close = async () => { closeCalls.push('second-page'); };
  const context = {
    pages: () => [firstPage, secondPage],
    close: async () => { closeCalls.push('context'); throw new Error('context close failed'); },
  };
  const chromium = { launchPersistentContext: async () => context };
  const statusStore = fakeStatusStore();
  const session = new TaobaoSession({ dataDir, chromium, statusStore, emit: () => {} });
  await fsp.mkdir(path.join(dataDir, 'default'), { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'default', 'profile.txt'), 'private-session');
  await session.status('default');

  await assert.rejects(() => session.clear('default'), (error) => (
    error.code === 'CLEANUP_FAILED' && error.message === '账号清理失败'
  ));
  assert.deepEqual(closeCalls, ['first-page', 'second-page', 'context']);
  assert.equal(await fsp.readFile(path.join(dataDir, 'default', 'profile.txt'), 'utf8'), 'private-session');
  assert.equal(statusStore.calls.at(-1).status, 'unavailable');
});

test('clear succeeds when context termination is confirmed after a page close error', async () => {
  const dataDir = await fixture();
  const closeCalls = [];
  const page = new FakePage();
  page.close = async () => { closeCalls.push('page'); throw new Error('page already gone'); };
  const context = {
    pages: () => [page],
    close: async () => { closeCalls.push('context'); },
  };
  const chromium = { launchPersistentContext: async () => context };
  const session = new TaobaoSession({ dataDir, chromium, statusStore: fakeStatusStore(), emit: () => {} });
  assert.equal((await session.status('default')).status, 'ready');

  assert.equal((await session.clear('default')).status, 'logged_out');
  assert.deepEqual(closeCalls, ['page', 'context']);
  await assert.rejects(() => fsp.access(path.join(dataDir, 'default')));
});

test('clear revalidates a replaced profile directory before recursive deletion', async () => {
  const dataDir = await fixture();
  const outsideDir = await fixture();
  await fsp.writeFile(path.join(outsideDir, 'session-secret'), 'private');
  const { chromium } = fakeChromium(() => new FakePage());
  const statusStore = fakeStatusStore();
  const session = new TaobaoSession({ dataDir, chromium, statusStore, emit: () => {} });
  assert.equal((await session.status('default')).status, 'ready');

  const profileDir = path.join(dataDir, 'default');
  await fsp.rm(profileDir, { recursive: true });
  await fsp.symlink(outsideDir, profileDir);

  await assert.rejects(() => session.clear('default'), (error) => error.code === 'CLEANUP_FAILED');
  assert.equal(await fsp.readFile(path.join(outsideDir, 'session-secret'), 'utf8'), 'private');
  assert.equal((await fsp.lstat(profileDir)).isSymbolicLink(), true);
  assert.equal(statusStore.calls.at(-1).status, 'unavailable');
});

test('clearing closes pages and deletes only the exact account directory', async () => {
  const dataDir = await fixture();
  const { chromium, launches } = fakeChromium(() => new FakePage({
    afterGoto: 'https://login.taobao.com/member/login.jhtml',
    locators: { '.qrcode-img': new FakeLocator({ visible: true, screenshot: () => Buffer.from('qr') }) },
  }));
  const statusStore = fakeStatusStore();
  const session = new TaobaoSession({ dataDir, chromium, statusStore, emit: () => {} });
  await fsp.mkdir(path.join(dataDir, 'default'), { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'default', 'profile.txt'), 'default');
  await fsp.mkdir(path.join(dataDir, 'other'), { recursive: true });
  await fsp.writeFile(path.join(dataDir, 'other', 'profile.txt'), 'other');
  await session.beginLogin('default');

  const cleared = await session.clear('default');

  assert.equal(cleared.status, 'logged_out');
  assert.equal(launches[0].context.closed, true);
  assert.equal(launches[0].page.closed, true);
  await assert.rejects(() => fsp.access(path.join(dataDir, 'default')));
  assert.equal(await fsp.readFile(path.join(dataDir, 'other', 'profile.txt'), 'utf8'), 'other');
  await assert.rejects(() => session.qr('default'), (error) => error.code === 'QR_UNAVAILABLE');
  await assert.rejects(() => session.clear('../other'), /标识/);
  assert.equal(await fsp.readFile(path.join(dataDir, 'other', 'profile.txt'), 'utf8'), 'other');
});
