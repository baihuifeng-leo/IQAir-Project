'use strict';

const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 30_000;
const PUBLIC_MESSAGES = Object.freeze({
  WORKER_TIMEOUT: '详情处理超时',
  WORKER_EXITED: '详情服务暂不可用',
  WORKER_SEND_FAILED: '详情服务暂不可用',
  WORKER_START_FAILED: '详情服务暂不可用',
  WORKER_ERROR: '详情服务发生错误',
  WORKER_CLOSED: '详情服务已关闭',
  WORKER_REQUEST_INVALID: 'Worker 请求不合法',
  WORKER_REQUEST_CANCELLED: '请求已取消',
  ACCOUNT_BUSY: '该账号正忙',
  CLEANUP_FAILED: '账号清理失败',
  DETAIL_CANCELLED: '任务已取消',
  DETAIL_UNAVAILABLE: '详情长图任务暂不可用',
  QR_UNAVAILABLE: '登录二维码不可用',
});

function workerError(code, message) {
  const publicCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(String(code || '')) ? code : 'WORKER_ERROR';
  const error = new Error(PUBLIC_MESSAGES[publicCode] || '详情 Worker 请求失败');
  error.code = publicCode;
  return error;
}

function serializeWorkerError(error) {
  if (!error || typeof error !== 'object') return workerError('WORKER_ERROR');
  return workerError(error.code, error.message);
}

function reviveIpcResult(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
  return value;
}

class DetailWorkerClient extends EventEmitter {
  constructor({ fork, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super();
    if (fork !== undefined && typeof fork !== 'function') throw new Error('fork 必须是函数');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Worker 超时必须为正数');

    this.fork = fork || (() => childProcess.fork(path.join(__dirname, 'detail-worker.js'), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
    }));
    this.timeoutMs = timeoutMs;
    this._child = null;
    this._listeners = null;
    this._nextId = 1;
    this._pending = new Map();
  }

  get pendingCount() {
    return this._pending.size;
  }

  start() {
    if (this._child) return this._child;

    const child = this.fork();
    if (!child || typeof child.on !== 'function' || typeof child.send !== 'function') {
      throw workerError('WORKER_START_FAILED', '详情 Worker 无法启动');
    }

    const onMessage = (message) => this._handleMessage(child, message);
    const onExit = (code, signal) => this._handleExit(child, code, signal);
    const onError = () => this._handleExit(child, null, null, '详情 Worker 通信失败');
    const onDisconnect = () => this._handleExit(child, null, null, '详情 Worker 通信失败');
    this._child = child;
    this._listeners = { child, onMessage, onExit, onError, onDisconnect };
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);
    child.on('disconnect', onDisconnect);
    return child;
  }

  request(type, payload = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (typeof type !== 'string' || !type) {
      return Promise.reject(workerError('WORKER_REQUEST_INVALID', 'Worker 请求类型不合法'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(workerError('WORKER_REQUEST_INVALID', 'Worker 请求超时必须为正数'));
    }

    let child;
    try {
      child = this.start();
    } catch (error) {
      return Promise.reject(serializeWorkerError(error));
    }
    const id = String(this._nextId++);
    const envelope = { kind: 'request', id, type, payload };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._settle(id, false, workerError('WORKER_TIMEOUT', '详情 Worker 请求超时'))) {
          this._cancelRequest(child, id);
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });

      try {
        child.send(envelope, (error) => {
          if (error) this._handleExit(child, null, null, '详情 Worker 通信失败');
        });
      } catch {
        this._handleExit(child, null, null, '详情 Worker 通信失败');
      }
    });
  }

  close() {
    const child = this._child;
    if (child) {
      this._child = null;
      this._detach(child);
    }
    this._rejectAll(workerError('WORKER_CLOSED', '详情 Worker 已关闭'));
    if (!child) return;
    try { child.disconnect?.(); } catch { /* 子进程可能已经断开 */ }
    try { child.kill?.(); } catch { /* 子进程可能已经退出 */ }
  }

  _handleMessage(child, message) {
    if (child !== this._child || !message || typeof message !== 'object') return;
    if (message.kind === 'event') {
      this.emit('event', { type: message.type, payload: message.payload });
      return;
    }
    if (message.kind !== 'response' || typeof message.id !== 'string') return;
    if (message.ok) this._settle(message.id, true, reviveIpcResult(message.result));
    else this._settle(message.id, false, serializeWorkerError(message.error));
  }

  _handleExit(child, code, signal, message) {
    if (child !== this._child) return;
    this._child = null;
    this._detach(child);
    const reason = message || `详情 Worker 已退出${signal ? ` (${signal})` : code === null || code === undefined ? '' : ` (${code})`}`;
    this._rejectAll(workerError('WORKER_EXITED', reason));
    if (message) {
      try { child.disconnect?.(); } catch { /* IPC 可能已断开 */ }
      try { child.kill?.(); } catch { /* 子进程可能已退出 */ }
    }
  }

  _cancelRequest(child, id) {
    if (child !== this._child) return;
    try {
      child.send({ kind: 'cancel', id }, (error) => {
        if (error) this._handleExit(child, null, null, '详情 Worker 通信失败');
      });
    } catch {
      this._handleExit(child, null, null, '详情 Worker 通信失败');
    }
  }

  _detach(child) {
    const listeners = this._listeners;
    if (!listeners || listeners.child !== child) return;
    child.removeListener?.('message', listeners.onMessage);
    child.removeListener?.('exit', listeners.onExit);
    child.removeListener?.('error', listeners.onError);
    child.removeListener?.('disconnect', listeners.onDisconnect);
    this._listeners = null;
  }

  _settle(id, ok, value) {
    const pending = this._pending.get(id);
    if (!pending) return false;
    this._pending.delete(id);
    clearTimeout(pending.timer);
    if (ok) pending.resolve(value);
    else pending.reject(value);
    return true;
  }

  _rejectAll(error) {
    for (const id of [...this._pending.keys()]) this._settle(id, false, error);
  }
}

module.exports = { DetailWorkerClient, workerError };
