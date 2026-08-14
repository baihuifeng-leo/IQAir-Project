'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { normalizeProductUrl } = require('./detail-url');

const PHASES = new Set(['queued', 'opening', 'detecting', 'resolving', 'composing', 'completed', 'failed', 'cancelled']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SENSITIVE = /cookie|token|secret|password|authorization|credential|qr|browser|context|html/i;
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']);
const DEFAULT_RETENTION_MS = 86_400_000;
const NEXT_PHASES = {
  queued: new Set(['queued', 'opening', 'failed', 'cancelled']),
  opening: new Set(['opening', 'detecting', 'failed', 'cancelled']),
  detecting: new Set(['detecting', 'resolving', 'failed', 'cancelled']),
  resolving: new Set(['resolving', 'composing', 'failed', 'cancelled']),
  composing: new Set(['composing', 'completed', 'failed', 'cancelled']),
  completed: new Set(), failed: new Set(), cancelled: new Set()
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function safeId(value, name) {
  const id = String(value || '');
  if (!SAFE_ID.test(id) || RESERVED_IDS.has(id)) throw new Error(`${name}标识不安全`);
  return id;
}

function text(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function numberOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanAssets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { total: 0, current: 0 };
  return {
    total: Math.max(0, Math.floor(numberOr(value.total))),
    current: Math.max(0, Math.floor(numberOr(value.current)))
  };
}

function cleanProgress(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      current: Math.max(0, Math.floor(numberOr(value.current))),
      total: Math.max(0, Math.floor(numberOr(value.total))),
      percent: Math.max(0, Math.min(100, numberOr(value.percent)))
    };
  }
  return Math.max(0, Math.min(100, numberOr(value)));
}

function cleanError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (hasSensitiveValue(value)) return null;
  const code = text(value.code, 80);
  const message = text(value.message, 500);
  return code || message ? { code, message } : null;
}

function hasSensitiveValue(value, key = '') {
  if (SENSITIVE.test(key)) return true;
  if (typeof value === 'string') return SENSITIVE.test(value);
  if (Array.isArray(value)) return value.some((item) => hasSensitiveValue(item));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([childKey, childValue]) => hasSensitiveValue(childValue, childKey));
  }
  return false;
}

async function writeAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(value, null, 1));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
}

class DetailTaskStore {
  constructor(rootDir, { now = () => Date.now(), retentionMs = DEFAULT_RETENTION_MS } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.file = path.join(this.rootDir, 'tasks.json');
    this.now = typeof now === 'function' ? now : () => Number(now);
    this.retentionMs = Number.isFinite(Number(retentionMs)) && Number(retentionMs) > 0
      ? Number(retentionMs) : DEFAULT_RETENTION_MS;
    this.tasks = new Map();
    this._writeChain = Promise.resolve();
  }

  async load() {
    await fsp.mkdir(this.rootDir, { recursive: true });
    let raw = {};
    let hadFile = false;
    try {
      raw = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      hadFile = true;
    } catch { /* 首次运行 */ }
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.tasks) ? raw.tasks : []);
    this.tasks = new Map();
    for (const item of list) {
      try {
        const task = this._sanitizeLoaded(item);
        if (task) this.tasks.set(task.id, task);
      } catch { /* 丢弃无法安全恢复的记录 */ }
    }
    if (hadFile) await this._persist();
    return this;
  }

  _sanitizeLoaded(item) {
    if (!item || typeof item !== 'object') return null;
    const legacySensitive = hasSensitiveValue(item);
    const id = safeId(item.id, '任务');
    const userId = safeId(item.userId || item.ownerId, '用户');
    const platform = safeId(item.platform, '平台');
    const accountId = safeId(item.accountId, '账号');
    if (!PHASES.has(item.phase)) return null;
    const task = {
      id, userId, platform, accountId,
      url: legacySensitive ? '' : text(item.url, 4096),
      productId: text(item.productId, 128),
      phase: legacySensitive ? 'failed' : item.phase,
      progress: cleanProgress(item.progress),
      assets: cleanAssets(item.assets),
      createdAt: numberOr(item.createdAt),
      updatedAt: numberOr(item.updatedAt),
      resultPath: null,
      resultBytes: numberOr(item.resultBytes, 0),
      resultMime: text(item.resultMime, 80),
      error: legacySensitive
        ? { code: 'legacy_sensitive_data', message: '任务数据已清理' }
        : cleanError(item.error)
    };
    if (item.resultPath != null) task.resultPath = this._safeResultPath(item.resultPath);
    return task;
  }

  _safeResultPath(candidate) {
    if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('结果路径不合法');
    const resolved = path.resolve(this.rootDir, candidate);
    const relative = path.relative(this.rootDir, resolved);
    if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('结果路径必须位于任务目录内');
    }
    // 词法路径检查挡住 ../；对已存在的父目录再做 realpath 检查，避免
    // 通过 root 内的符号链接把结果写到 root 外。
    const rootReal = fs.realpathSync.native(this.rootDir);
    let probe = resolved;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const realProbe = fs.realpathSync.native(probe);
    const probeRelative = path.relative(rootReal, realProbe);
    if (probeRelative.startsWith(`..${path.sep}`) || path.isAbsolute(probeRelative)) {
      throw new Error('结果路径必须位于任务目录内');
    }
    return resolved;
  }

  _newId() {
    let id;
    do { id = `dt_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`; }
    while (this.tasks.has(id));
    return id;
  }

  async create(userId, input = {}) {
    const owner = safeId(userId, '用户');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('任务参数不合法');
    for (const key of Object.keys(input)) {
      if (SENSITIVE.test(key)) throw new Error('敏感字段不允许持久化');
    }
    if (hasSensitiveValue(input.error) || hasSensitiveValue(input.url || input.normalizedUrl)) {
      throw new Error('敏感字段不允许持久化');
    }
    const platform = safeId(input.platform, '平台');
    const accountId = safeId(input.accountId, '账号');
    const stamp = numberOr(this.now());
    const rawUrl = text(input.url || input.normalizedUrl, 4096);
    let canonicalUrl = rawUrl;
    if (rawUrl) {
      try { canonicalUrl = normalizeProductUrl(rawUrl).url; }
      catch { throw new Error('商品 URL 不合法'); }
    }
    const task = {
      id: this._newId(), userId: owner, platform, accountId,
      url: canonicalUrl,
      productId: text(input.productId, 128),
      phase: 'queued', progress: 0, assets: { total: 0, current: 0 },
      createdAt: stamp, updatedAt: stamp,
      resultPath: null, resultBytes: 0, resultMime: '', error: null
    };
    this.tasks.set(task.id, task);
    await this._persist();
    return clone(task);
  }

  async transition(id, phase, patch = {}) {
    const task = this._task(id);
    if (!PHASES.has(phase)) throw new Error('任务阶段不合法');
    if (!NEXT_PHASES[task.phase].has(phase)) throw new Error('任务阶段转换不合法或已处于终态');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('任务补丁不合法');
    for (const key of Object.keys(patch)) {
      if (SENSITIVE.test(key)) throw new Error('敏感字段不允许持久化');
    }
    if (hasSensitiveValue(patch.error)) throw new Error('敏感字段不允许持久化');
    if (Object.prototype.hasOwnProperty.call(patch, 'resultPath')) {
      task.resultPath = patch.resultPath == null ? null : this._safeResultPath(patch.resultPath);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'progress')) task.progress = cleanProgress(patch.progress);
    if (Object.prototype.hasOwnProperty.call(patch, 'assets')) task.assets = cleanAssets(patch.assets);
    if (Object.prototype.hasOwnProperty.call(patch, 'resultBytes')) task.resultBytes = Math.max(0, numberOr(patch.resultBytes));
    if (Object.prototype.hasOwnProperty.call(patch, 'resultMime')) task.resultMime = text(patch.resultMime, 80);
    if (Object.prototype.hasOwnProperty.call(patch, 'error')) task.error = cleanError(patch.error);
    task.phase = phase;
    task.updatedAt = numberOr(this.now());
    await this._persist();
    return clone(task);
  }

  _task(id) {
    const key = safeId(id, '任务');
    const task = this.tasks.get(key);
    if (!task) throw new Error('找不到任务');
    return task;
  }

  listFor(user) {
    if (!user || typeof user !== 'object') throw new Error('用户身份不合法');
    if (user.admin === true) return [...this.tasks.values()].map(clone);
    const id = safeId(user.id, '用户');
    return [...this.tasks.values()].filter((task) => task.userId === id).map(clone);
  }

  getAuthorized(id, user) {
    const task = this._task(id);
    if (!user || typeof user !== 'object') throw new Error('无权访问任务');
    if (user.admin !== true && task.userId !== user.id) throw new Error('无权访问任务');
    return clone(task);
  }

  async cancel(id, user) {
    const task = this._task(id);
    this.getAuthorized(id, user);
    if (TERMINAL.has(task.phase)) throw new Error('任务已处于终态，不能取消');
    task.phase = 'cancelled';
    task.updatedAt = numberOr(this.now());
    if (task.resultPath) await fsp.rm(task.resultPath, { force: true });
    task.resultPath = null;
    task.resultBytes = 0;
    task.resultMime = '';
    await this._persist();
    return clone(task);
  }

  async cleanupExpired() {
    const cutoff = numberOr(this.now()) - this.retentionMs;
    let changed = false;
    for (const [id, task] of this.tasks) {
      if (!TERMINAL.has(task.phase)) continue;
      const taskExpired = task.updatedAt <= cutoff;
      if (!taskExpired) continue;
      if (task.resultPath) await fsp.rm(task.resultPath, { force: true });
      this.tasks.delete(id);
      changed = true;
    }
    if (changed) await this._persist();
    return changed;
  }

  async _persist() {
    const snapshot = { tasks: [...this.tasks.values()].map(clone) };
    this._writeChain = this._writeChain.catch(() => {}).then(() => writeAtomic(this.file, snapshot));
    return this._writeChain;
  }
}

module.exports = { DetailTaskStore, PHASES, DEFAULT_RETENTION_MS };
