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
const QR_TTL_MS = 120_000;

function sessionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cancelledRequestError() {
  return sessionError('WORKER_REQUEST_CANCELLED', '请求已取消');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledRequestError();
}

async function lstatOrNull(filePath) {
  try {
    return await fsp.lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
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

function isFatalBrowserError(error, page) {
  try {
    if (typeof page?.isClosed === 'function' && page.isClosed()) return true;
  } catch { /* Playwright 对象可能已失效 */ }
  if (error?.name === 'TargetClosedError' || error?.code === 'ERR_CLOSED') return true;
  return /(?:target page|browser|context|page).*(?:has been |is )?closed|page crashed/i.test(String(error?.message || ''));
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
    this._poisonedContexts = new Map();
    this._qrBytes = new Map();
    this._active = new Set();
    this._waiters = new Map();
    this._rootIdentity = null;
    this.maxQueue = 8;
  }

  runExclusive(accountId, fn, { signal, allowPoisoned = false } = {}) {
    let id;
    try {
      id = safeAccountId(accountId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (typeof fn !== 'function') return Promise.reject(new Error('账号操作必须是函数'));
    if (signal?.aborted) return Promise.reject(cancelledRequestError());
    if (!allowPoisoned && this._poisonedContexts.has(id)) {
      return Promise.reject(sessionError('CLEANUP_FAILED', '账号清理失败'));
    }
    const waiters = this._waiters.get(id) || [];
    if (this._active.has(id) && waiters.length >= this.maxQueue) {
      return Promise.reject(sessionError('ACCOUNT_BUSY', '该账号正忙'));
    }

    return new Promise((resolve, reject) => {
      const entry = { fn, resolve, reject, signal, allowPoisoned, onAbort: null };
      if (!this._active.has(id)) {
        this._startExclusive(id, entry);
        return;
      }
      entry.onAbort = () => {
        const queue = this._waiters.get(id);
        const index = queue?.indexOf(entry) ?? -1;
        if (index === -1) return;
        queue.splice(index, 1);
        if (queue.length === 0) this._waiters.delete(id);
        reject(cancelledRequestError());
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      waiters.push(entry);
      this._waiters.set(id, waiters);
    });
  }

  _startExclusive(accountId, entry) {
    this._active.add(accountId);
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
    Promise.resolve().then(() => {
      throwIfAborted(entry.signal);
      if (!entry.allowPoisoned && this._poisonedContexts.has(accountId)) {
        throw sessionError('CLEANUP_FAILED', '账号清理失败');
      }
      return entry.fn();
    }).then(entry.resolve, entry.reject).finally(() => {
      const waiters = this._waiters.get(accountId);
      const next = waiters?.shift();
      if (waiters?.length === 0) this._waiters.delete(accountId);
      if (next) this._startExclusive(accountId, next);
      else this._active.delete(accountId);
    });
  }

  status(accountId = 'default', { signal } = {}) {
    return this.runExclusive(accountId, async () => {
      const id = safeAccountId(accountId);
      let page;
      try {
        throwIfAborted(signal);
        page = await this._pageFor(id);
        const response = await page.goto(PROTECTED_PAGE_URL, { waitUntil: 'domcontentloaded' });
        throwIfAborted(signal);
        return this._setDetectedStatus(id, page, 'logged_out', response, signal);
      } catch (error) {
        if (signal?.aborted) throw cancelledRequestError();
        await this._evictFatalContext(id, error, page);
        return this._setStatus(id, 'unavailable', { errorCode: 'PROBE_FAILED' });
      }
    }, { signal });
  }

  beginLogin(accountId = 'default', { signal } = {}) {
    return this.runExclusive(accountId, async () => {
      const id = safeAccountId(accountId);
      let page;
      try {
        throwIfAborted(signal);
        page = await this._pageFor(id);
        await page.goto(LOGIN_PAGE_URL, { waitUntil: 'domcontentloaded' });
        throwIfAborted(signal);
      } catch (error) {
        if (signal?.aborted) throw cancelledRequestError();
        await this._evictFatalContext(id, error, page);
        return this._setStatus(id, 'unavailable', { errorCode: 'LOGIN_OPEN_FAILED' });
      }

      throwIfAborted(signal);
      if (!LOGIN_HOSTS.has(hostnameFor(page))) {
        return this._setStatus(id, 'unavailable', { errorCode: 'LOGIN_REDIRECTED' });
      }

      if (await findVisibleLocator(page, CHALLENGE_SELECTORS)) {
        throwIfAborted(signal);
        return this._setStatus(id, 'challenge_required', { errorCode: 'CHALLENGE_REQUIRED' });
      }
      const qr = await findVisibleLocator(page, QR_SELECTORS);
      throwIfAborted(signal);
      if (!qr) {
        await this._setStatus(id, 'logged_out', { errorCode: 'QR_UNAVAILABLE' });
        throw sessionError('QR_UNAVAILABLE', '未找到淘宝登录二维码');
      }
      let bytes;
      try {
        bytes = Buffer.from(await qr.screenshot({ type: 'png' }));
      } catch {
        if (signal?.aborted) throw cancelledRequestError();
        await this._setStatus(id, 'logged_out', { errorCode: 'QR_UNAVAILABLE' });
        throw sessionError('QR_UNAVAILABLE', '无法读取淘宝登录二维码');
      }
      throwIfAborted(signal);
      if (bytes.length === 0) {
        await this._setStatus(id, 'logged_out', { errorCode: 'QR_UNAVAILABLE' });
        throw sessionError('QR_UNAVAILABLE', '淘宝登录二维码为空');
      }
      this._qrBytes.set(id, { bytes, generation: `${Date.now()}-${Math.random()}`, expiresAt: Date.now() + QR_TTL_MS });
      return this._setStatus(id, 'waiting_for_scan');
    }, { signal });
  }

  qr(accountId = 'default', { signal } = {}) {
    return this.runExclusive(accountId, async () => {
      const id = safeAccountId(accountId);
      throwIfAborted(signal);
      const qr = this._qrBytes.get(id);
      if (!qr || qr.expiresAt <= Date.now()) { this._qrBytes.delete(id); throw sessionError('QR_UNAVAILABLE', '当前没有可用的登录二维码'); }
      return Buffer.from(qr.bytes);
    }, { signal });
  }

  verify(accountId = 'default', { signal } = {}) {
    return this.runExclusive(accountId, async () => {
      const id = safeAccountId(accountId);
      throwIfAborted(signal);
      await this._setStatus(id, 'verifying');
      let page;
      try {
        throwIfAborted(signal);
        page = await this._pageFor(id);
        const response = await page.goto(PROTECTED_PAGE_URL, { waitUntil: 'domcontentloaded' });
        throwIfAborted(signal);
        const status = await this._setDetectedStatus(id, page, 'expired', response, signal);
        if (status.status === 'ready') this._qrBytes.delete(id);
        return status;
      } catch (error) {
        if (signal?.aborted) throw cancelledRequestError();
        await this._evictFatalContext(id, error, page);
        return this._setStatus(id, 'unavailable', { errorCode: 'PROBE_FAILED' });
      }
    }, { signal });
  }

  clear(accountId = 'default', { signal } = {}) {
    return this.runExclusive(accountId, async () => {
      const id = safeAccountId(accountId);
      throwIfAborted(signal);
      const context = this._poisonedContexts.get(id) || this._contexts.get(id);
      if (context) {
        try { await this._closeContext(context); } catch {
          if (this._contexts.get(id) === context) this._poisonedContexts.set(id, context);
          await this._setStatus(id, 'unavailable', { errorCode: 'CLEANUP_FAILED' });
          throw sessionError('CLEANUP_FAILED', '账号清理失败');
        }
      }
      if (this._contexts.get(id) === context) this._contexts.delete(id);
      if (this._poisonedContexts.get(id) === context) this._poisonedContexts.delete(id);
      this._qrBytes.delete(id);
      try {
        const accountDir = await this._validatedAccountDir(id, { allowMissing: true });
        if (accountDir) {
          await this._validatedAccountDir(id);
          await fsp.rm(accountDir, { recursive: true, force: true });
        }
      } catch {
        await this._setStatus(id, 'unavailable', { errorCode: 'CLEANUP_FAILED' });
        throw sessionError('CLEANUP_FAILED', '账号清理失败');
      }
      return this._setStatus(id, 'logged_out');
    }, { signal, allowPoisoned: true });
  }

  async _setDetectedStatus(accountId, page, loginStatus, response, signal) {
    throwIfAborted(signal);
    if (await findVisibleLocator(page, CHALLENGE_SELECTORS)) {
      throwIfAborted(signal);
      return this._setStatus(accountId, 'challenge_required', { errorCode: 'CHALLENGE_REQUIRED' });
    }
    const host = hostnameFor(page);
    if (LOGIN_HOSTS.has(host) || await findVisibleLocator(page, LOGIN_SELECTORS)) {
      throwIfAborted(signal);
      return this._setStatus(accountId, loginStatus);
    }
    throwIfAborted(signal);
    if (host !== 'i.taobao.com') {
      return this._setStatus(accountId, 'unavailable', { errorCode: 'PROBE_REDIRECTED' });
    }
    const url = page.url();
    if (!response || !(typeof response.ok === 'function' ? response.ok() : response.status?.() >= 200 && response.status?.() < 300) || url !== PROTECTED_PAGE_URL) {
      return this._setStatus(accountId, 'unavailable', { errorCode: 'PROBE_FAILED' });
    }
    return this._setStatus(accountId, 'ready', { lastVerifiedAt: Date.now() });
  }

  async _setStatus(accountId, status, patch = {}) {
    if (status !== 'waiting_for_scan') this._qrBytes.delete(accountId);
    const record = await this.statusStore.setStatus(PLATFORM, accountId, status, patch);
    this.emit('session.status', record);
    return record;
  }

  async _pageFor(accountId) {
    const context = await this._contextFor(accountId);
    const pages = typeof context.pages === 'function' ? context.pages() : [];
    for (const page of pages || []) {
      try {
        if (typeof page?.isClosed !== 'function' || !page.isClosed()) return page;
      } catch { /* 跳过已失效的 page */ }
    }
    if (typeof context.newPage !== 'function') throw sessionError('PAGE_UNAVAILABLE', '淘宝浏览器页面不可用');
    return context.newPage();
  }

  async _contextFor(accountId) {
    if (this._poisonedContexts.has(accountId)) {
      throw sessionError('CLEANUP_FAILED', '账号清理失败');
    }
    const existing = this._contexts.get(accountId);
    if (existing) return existing;

    const accountDir = await this._prepareAccountDir(accountId);
    const context = await this.chromium.launchPersistentContext(accountDir, {
      headless: true,
      viewport: { width: 1440, height: 1000 },
    });
    this._contexts.set(accountId, context);
    const onClose = () => {
      if (this._contexts.get(accountId) === context) this._contexts.delete(accountId);
      if (this._poisonedContexts.get(accountId) === context) this._poisonedContexts.delete(accountId);
      this._qrBytes.delete(accountId);
    };
    if (typeof context.once === 'function') context.once('close', onClose);
    else if (typeof context.on === 'function') context.on('close', onClose);
    return context;
  }

  async _evictFatalContext(accountId, error, page) {
    if (!isFatalBrowserError(error, page)) return false;
    const context = this._poisonedContexts.get(accountId) || this._contexts.get(accountId);
    if (!context) return true;
    this._qrBytes.delete(accountId);
    try {
      await this._closeContext(context);
    } catch {
      if (this._contexts.get(accountId) !== context) return true;
      this._poisonedContexts.set(accountId, context);
      await this._setStatus(accountId, 'unavailable', { errorCode: 'CLEANUP_FAILED' });
      throw sessionError('CLEANUP_FAILED', '账号清理失败');
    }
    if (this._contexts.get(accountId) === context) this._contexts.delete(accountId);
    if (this._poisonedContexts.get(accountId) === context) this._poisonedContexts.delete(accountId);
    return true;
  }

  _accountDir(accountId) {
    const id = safeAccountId(accountId);
    const accountDir = path.resolve(this.dataDir, id);
    if (path.dirname(accountDir) !== this.dataDir) {
      throw sessionError('ACCOUNT_ID_INVALID', '账号目录不安全');
    }
    return accountDir;
  }

  async _sessionRoot() {
    await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const before = await fsp.lstat(this.dataDir);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw sessionError('PROFILE_UNSAFE', '账号目录不安全');
    }
    const realPath = await fsp.realpath(this.dataDir);
    if (this._rootIdentity && (
      !sameFileIdentity(before, this._rootIdentity) || realPath !== this._rootIdentity.realPath
    )) {
      throw sessionError('PROFILE_UNSAFE', '账号目录不安全');
    }
    await fsp.chmod(this.dataDir, 0o700);
    const after = await fsp.lstat(this.dataDir);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameFileIdentity(before, after)) {
      throw sessionError('PROFILE_UNSAFE', '账号目录不安全');
    }
    const identity = { dev: after.dev, ino: after.ino, realPath };
    if (!this._rootIdentity) this._rootIdentity = identity;
    return this._rootIdentity;
  }

  async _validatedAccountDir(accountId, { allowMissing = false } = {}) {
    const root = await this._sessionRoot();
    const accountDir = this._accountDir(accountId);
    const before = await lstatOrNull(accountDir);
    if (!before) {
      if (allowMissing) return null;
      throw sessionError('PROFILE_UNSAFE', '账号目录不安全');
    }
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw sessionError('PROFILE_UNSAFE', '账号目录不安全');
    }
    const realPath = await fsp.realpath(accountDir);
    if (path.dirname(realPath) !== root.realPath) {
      throw sessionError('PROFILE_UNSAFE', '账号目录不安全');
    }
    const after = await fsp.lstat(accountDir);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameFileIdentity(before, after)) {
      throw sessionError('PROFILE_UNSAFE', '账号目录不安全');
    }
    await this._sessionRoot();
    return accountDir;
  }

  async _prepareAccountDir(accountId) {
    await this._sessionRoot();
    const accountDir = this._accountDir(accountId);
    const existing = await lstatOrNull(accountDir);
    if (!existing) await fsp.mkdir(accountDir, { mode: 0o700 });
    await this._validatedAccountDir(accountId);
    await fsp.chmod(accountDir, 0o700);
    return this._validatedAccountDir(accountId);
  }

  async _closeContext(context) {
    const pages = typeof context.pages === 'function' ? context.pages() : [];
    let pageFailure;
    for (const page of pages || []) {
      try { await page.close?.(); } catch (error) { pageFailure ||= error; }
    }
    if (typeof context.close === 'function') {
      await context.close();
      return;
    }
    if (pageFailure) throw pageFailure;
  }
}

module.exports = {
  TaobaoSession,
  PROTECTED_PAGE_URL,
  LOGIN_PAGE_URL,
};
