'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

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
  constructor({ afterGoto = 'https://i.taobao.com/my_taobao.htm', gotoError = null, locators = {} } = {}) {
    this.currentUrl = 'about:blank';
    this.afterGoto = afterGoto;
    this.gotoError = gotoError;
    this.locators = locators;
    this.gotoCalls = [];
    this.closed = false;
  }

  async goto(url) {
    this.gotoCalls.push(url);
    if (this.gotoError) throw this.gotoError;
    this.currentUrl = this.afterGoto;
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

class FakeContext {
  constructor(page) {
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
