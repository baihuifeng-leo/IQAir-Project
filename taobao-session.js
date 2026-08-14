'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const PLATFORM = 'taobao';
const PROTECTED_PAGE_URL = 'https://i.taobao.com/my_taobao.htm';
const LOGIN_PAGE_URL = 'https://login.taobao.com/member/login.jhtml';
const LOGIN_HOSTS = new Set(['login.taobao.com', 'login.tmall.com']);
const SAFE_ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RESERVED_ACCOUNT_IDS = new Set(['__proto__', 'prototype', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']);
const CHALLENGE_SELECTORS = [
  '#nocaptcha',
  '.nc_wrapper',
  '.nc-container',
  '[data-testid*="captcha"]',
  'text=请完成安全验证',
  'text=安全验证',
];
const LOGIN_SELECTORS = [
  'input[name="fm-login-id"]',
  '#fm-login-id',
  'input[name="fm-login-password"]',
  '.login-box',
  'text=扫码登录',
  'text=密码登录',
];
const QR_SELECTORS = [
  '.qrcode-img',
  '[data-testid="qr-code"]',
  '.qrcode',
  '#login .qrcode',
];

function sessionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeAccountId(value) {
  const accountId = String(value || '');
  if (!SAFE_ACCOUNT_ID.test(accountId) || RESERVED_ACCOUNT_IDS.has(accountId)) {
    throw sessionError('ACCOUNT_ID_INVALID', '账号标识不安全');
  }
  return accountId;
}

function hostnameFor(page) {
  try { return new URL(page.url()).hostname; } catch { return ''; }
}

async function isVisible(locator) {
  if (!locator) return false;
  try {
    if (typeof locator.count === 'function' && await locator.count() === 0) return false;
    return typeof locator.isVisible === 'function' ? !!await locator.isVisible() : true;
  } catch {
    return false;
  }
}

async function findVisibleLocator(page, selectors) {
  if (!page || typeof page.locator !== 'function') return null;
  for (const selector of selectors) {
    const locator = page.locator(selector);
    if (await isVisible(locator)) return locator;
  }
  return null;
}

class TaobaoSession {
  constructor({ dataDir, chromium, statusStore, emit } = {}) {
    if (!dataDir || typeof dataDir !== 'string') throw new Error('淘宝会话目录不能为空');
    if (!chromium || typeof chromium.launchPersistentContext !== 'function') {
      throw new Error('Chromium 持久会话启动器不可用');
    }
    if (!statusStore || typeof statusStore.setStatus !== 'function') {
      throw new Error('平台账号状态存储不可用');
    }

    this.dataDir = path.resolve(dataDir);
    this.chromium = chromium;
    this.statusStore = statusStore;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this._contexts = new Map();
    this._qrBytes = new Map();
    this._locks = new Map();
  }

  runExclusive(accountId, fn) {
    let id;
    try {
      id = safeAccountId(accountId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (typeof fn !== 'function') return Promise.reject(new Error('账号操作必须是函数'));

    const previous = this._locks.get(id) || Promise.resolve();
    let release;
    const own = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => own);
    this._locks.set(id, tail);

    return previous.then(async () => {
      try {
        return await fn();
      } finally {
        release();
        if (this._locks.get(id) === tail) this._locks.delete(id);
      }
    });
  }

  status(accountId = 'default') {
    return this.runExclusive(accountId, async () => {
      const id = safeAccountId(accountId);
      try {
        const page = await this._pageFor(id);
        await page.goto(PROTECTED_PAGE_URL, { waitUntil: 'domcontentloaded' });
        return this._setDetectedStatus(id, page, 'logged_out');
      } catch {
        return this._setStatus(id, 'unavailable', { errorCode: 'PROBE_FAILED' });
      }
    });
  }

  beginLogin(accountId = 'default') {
    return this.runExclusive(accountId, async () => {
      const id = safeAccountId(accountId);
      let page;
      try {
        page = await this._pageFor(id);
        await page.goto(LOGIN_PAGE_URL, { waitUntil: 'domcontentloaded' });
      } catch {
        return this._setStatus(id, 'unavailable', { errorCode: 'LOGIN_OPEN_FAILED' });
      }

      if (!LOGIN_HOSTS.has(hostnameFor(page))) {
        return this._setStatus(id, 'unavailable', { errorCode: 'LOGIN_REDIRECTED' });
      }

      if (await findVisibleLocator(page, CHALLENGE_SELECTORS)) {
        return this._setStatus(id, 'challenge_required', { errorCode: 'CHALLENGE_REQUIRED' });
      }
      const qr = await findVisibleLocator(page, QR_SELECTORS);
      if (!qr) {
        await this._setStatus(id, 'logged_out', { errorCode: 'QR_UNAVAILABLE' });
        throw sessionError('QR_UNAVAILABLE', '未找到淘宝登录二维码');
      }
      let bytes;
      try {
        bytes = Buffer.from(await qr.screenshot({ type: 'png' }));
      } catch {
        await this._setStatus(id, 'logged_out', { errorCode: 'QR_UNAVAILABLE' });
        throw sessionError('QR_UNAVAILABLE', '无法读取淘宝登录二维码');
      }
      if (bytes.length === 0) {
        await this._setStatus(id, 'logged_out', { errorCode: 'QR_UNAVAILABLE' });
        throw sessionError('QR_UNAVAILABLE', '淘宝登录二维码为空');
      }
      this._qrBytes.set(id, bytes);
      return this._setStatus(id, 'waiting_for_scan');
    });
  }

  qr(accountId = 'default') {
    const id = safeAccountId(accountId);
    const bytes = this._qrBytes.get(id);
    if (!bytes) return Promise.reject(sessionError('QR_UNAVAILABLE', '当前没有可用的登录二维码'));
    return Promise.resolve(Buffer.from(bytes));
  }

  verify(accountId = 'default') {
    return this.runExclusive(accountId, async () => {
      const id = safeAccountId(accountId);
      await this._setStatus(id, 'verifying');
      try {
        const page = await this._pageFor(id);
        await page.goto(PROTECTED_PAGE_URL, { waitUntil: 'domcontentloaded' });
        const status = await this._setDetectedStatus(id, page, 'expired');
        if (status.status === 'ready') this._qrBytes.delete(id);
        return status;
      } catch {
        return this._setStatus(id, 'unavailable', { errorCode: 'PROBE_FAILED' });
      }
    });
  }

  clear(accountId = 'default') {
    return this.runExclusive(accountId, async () => {
      const id = safeAccountId(accountId);
      const context = this._contexts.get(id);
      this._contexts.delete(id);
      this._qrBytes.delete(id);
      if (context) await this._closeContext(context);
      await fsp.rm(this._accountDir(id), { recursive: true, force: true });
      return this._setStatus(id, 'logged_out');
    });
  }

  async _setDetectedStatus(accountId, page, loginStatus) {
    if (await findVisibleLocator(page, CHALLENGE_SELECTORS)) {
      return this._setStatus(accountId, 'challenge_required', { errorCode: 'CHALLENGE_REQUIRED' });
    }
    const host = hostnameFor(page);
    if (LOGIN_HOSTS.has(host) || await findVisibleLocator(page, LOGIN_SELECTORS)) {
      return this._setStatus(accountId, loginStatus);
    }
    if (host !== 'i.taobao.com') {
      return this._setStatus(accountId, 'unavailable', { errorCode: 'PROBE_REDIRECTED' });
    }
    return this._setStatus(accountId, 'ready', { lastVerifiedAt: Date.now() });
  }

  async _setStatus(accountId, status, patch = {}) {
    const record = await this.statusStore.setStatus(PLATFORM, accountId, status, patch);
    this.emit('session.status', record);
    return record;
  }

  async _pageFor(accountId) {
    const context = await this._contextFor(accountId);
    const pages = typeof context.pages === 'function' ? context.pages() : [];
    if (pages && pages.length) return pages[0];
    if (typeof context.newPage !== 'function') throw sessionError('PAGE_UNAVAILABLE', '淘宝浏览器页面不可用');
    return context.newPage();
  }

  async _contextFor(accountId) {
    const existing = this._contexts.get(accountId);
    if (existing) return existing;

    await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const accountDir = this._accountDir(accountId);
    await fsp.mkdir(accountDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(accountDir, 0o700);
    const context = await this.chromium.launchPersistentContext(accountDir, {
      headless: true,
      viewport: { width: 1440, height: 1000 },
    });
    this._contexts.set(accountId, context);
    return context;
  }

  _accountDir(accountId) {
    const id = safeAccountId(accountId);
    const accountDir = path.resolve(this.dataDir, id);
    if (path.dirname(accountDir) !== this.dataDir) {
      throw sessionError('ACCOUNT_ID_INVALID', '账号目录不安全');
    }
    return accountDir;
  }

  async _closeContext(context) {
    const pages = typeof context.pages === 'function' ? context.pages() : [];
    for (const page of pages || []) {
      try { await page.close?.(); } catch { /* 继续关闭其余页面和上下文 */ }
    }
    try { await context.close?.(); } catch { /* 关闭失败不扩大到相邻账号目录 */ }
  }
}

module.exports = {
  TaobaoSession,
  PROTECTED_PAGE_URL,
  LOGIN_PAGE_URL,
};
