'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const SESSION_STATES = new Set([
  'logged_out',
  'waiting_for_scan',
  'verifying',
  'ready',
  'challenge_required',
  'expired',
  'unavailable'
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SENSITIVE = /cookie|token|secret|password|authorization|credential|qr|browser|context|html/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeId(value, name) {
  const id = String(value || '');
  if (!SAFE_ID.test(id)) throw new Error(`${name}标识不安全`);
  return id;
}

function cleanText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function cleanRecord(platform, accountId, input) {
  const status = SESSION_STATES.has(input?.status) ? input.status : 'logged_out';
  const result = {
    platform,
    accountId,
    status,
    updatedAt: Number.isFinite(input?.updatedAt) ? input.updatedAt : 0,
    lastVerifiedAt: Number.isFinite(input?.lastVerifiedAt) ? input.lastVerifiedAt : null,
    accountName: cleanText(input?.accountName, 120),
    errorCode: input?.errorCode ? cleanText(input.errorCode, 80) : null,
    currentTaskId: input?.currentTaskId ? cleanText(input.currentTaskId, 128) : null
  };
  return result;
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

class PlatformSessionStore {
  constructor(rootDir, { now = () => Date.now() } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.file = path.join(this.rootDir, 'sessions.json');
    this.now = typeof now === 'function' ? now : () => Number(now);
    this.sessions = {};
    this._writeChain = Promise.resolve();
  }

  async load() {
    await fsp.mkdir(this.rootDir, { recursive: true });
    let raw = {};
    let hadFile = false;
    try {
      raw = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      hadFile = true;
    } catch { /* 首次运行或损坏文件按空存储启动 */ }

    const source = Array.isArray(raw) ? raw : [];
    this.sessions = {};
    if (Array.isArray(raw)) {
      for (const item of source) {
        try {
          const platform = safeId(item.platform, '平台');
          const accountId = safeId(item.accountId, '账号');
          this._put(cleanRecord(platform, accountId, item));
        } catch { /* 丢弃无法安全恢复的记录 */ }
      }
    } else if (raw && typeof raw === 'object') {
      for (const [platformKey, accounts] of Object.entries(raw)) {
        try { safeId(platformKey, '平台'); } catch { continue; }
        if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) continue;
        for (const [accountKey, item] of Object.entries(accounts)) {
          try {
            const platform = safeId(platformKey, '平台');
            const accountId = safeId(accountKey, '账号');
            this._put(cleanRecord(platform, accountId, item));
          } catch { /* 丢弃无法安全恢复的记录 */ }
        }
      }
    }
    // 读到旧版本或被污染的文件时也立即用白名单重写，避免敏感字段继续留在磁盘。
    if (hadFile) await this._persist();
    return this;
  }

  _put(record) {
    if (!this.sessions[record.platform]) this.sessions[record.platform] = {};
    this.sessions[record.platform][record.accountId] = record;
  }

  get(platform, accountId) {
    const p = safeId(platform, '平台');
    const a = safeId(accountId, '账号');
    const record = this.sessions[p]?.[a];
    return record ? clone(record) : null;
  }

  async setStatus(platform, accountId, status, patch = {}) {
    const p = safeId(platform, '平台');
    const a = safeId(accountId, '账号');
    if (!SESSION_STATES.has(status)) throw new Error('平台账号状态不合法');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('状态补丁不合法');
    for (const key of Object.keys(patch)) {
      if (SENSITIVE.test(key)) throw new Error('敏感字段不允许持久化');
    }

    const previous = this.sessions[p]?.[a] || {};
    const record = cleanRecord(p, a, { ...previous, ...patch, status, updatedAt: this.now() });
    this._put(record);
    await this._persist();
    return clone(record);
  }

  async _persist() {
    const snapshot = clone(this.sessions);
    this._writeChain = this._writeChain.catch(() => {}).then(() => writeAtomic(this.file, snapshot));
    return this._writeChain;
  }
}

module.exports = { PlatformSessionStore, SESSION_STATES };
