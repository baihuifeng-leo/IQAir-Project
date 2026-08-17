'use strict';

const path = require('node:path');
const { DetailTaskStore } = require('./detail-task-store');
const { PlatformSessionStore } = require('./platform-session-store');
const { DetailWorkerClient } = require('./detail-worker-client');

const DETAIL_RUN_TIMEOUT_MS = 600_000;
const CLEANUP_INTERVAL_MS = 3_600_000;
const KNOWN_ACCOUNTS = Object.freeze(['default']);

function serviceUnavailable(message) {
  return Object.assign(new Error(message), { status: 503 });
}

class DetailJobRunner {
  constructor({ dataDir, broadcast = () => {}, workerClient, retentionMs } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw new Error('dataDir 不能为空');
    this.tasks = new DetailTaskStore(path.join(dataDir, 'detail-jobs'), { retentionMs });
    this.sessions = new PlatformSessionStore(path.join(dataDir, 'platform-sessions'));
    this.worker = workerClient || new DetailWorkerClient();
    this.broadcast = broadcast;
    this.accepting = true;
    this._cleanupTimer = null;
    this._onEvent = (message) => this._handleWorkerEvent(message);
    this.worker.on('event', this._onEvent);
  }

  async start() {
    await this.tasks.load();
    await this.sessions.load();
    await this.tasks.cleanupExpired();
    this._cleanupTimer = setInterval(() => {
      this.tasks.cleanupExpired().catch((error) => console.error('[detail-jobs] 清理过期任务失败：' + error.message));
    }, CLEANUP_INTERVAL_MS);
    this._cleanupTimer.unref?.();
  }

  async stop() {
    this.accepting = false;
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this.worker.removeListener('event', this._onEvent);
    this.worker.close();
  }

  async accountStatuses() {
    await this.sessions.load();
    return KNOWN_ACCOUNTS.map((accountId) => this.sessions.get('taobao', accountId) || {
      platform: 'taobao', accountId, status: 'logged_out',
      updatedAt: 0, lastVerifiedAt: null, accountName: '', errorCode: null, currentTaskId: null,
    });
  }

  beginLogin(accountId) {
    return this.worker.request('session.beginLogin', { accountId });
  }

  qrPng(accountId) {
    return this.worker.request('session.qr', { accountId });
  }

  verify(accountId) {
    return this.worker.request('session.verify', { accountId });
  }

  clearAccount(accountId) {
    return this.worker.request('session.clear', { accountId });
  }

  listTasksFor(user) {
    return this.tasks.listFor(user);
  }

  getTaskAuthorized(id, user) {
    return this.tasks.getAuthorized(id, user);
  }

  async createTask(user, { url, accountId = 'default' }) {
    if (!this.accepting) throw serviceUnavailable('服务正在关闭，暂不接受新任务');
    const task = await this.tasks.create(user.id, { platform: 'taobao', accountId, url });
    this._runTask(task).catch(() => { /* 失败已经在 _runTask 内落盘为 failed，这里只是防止未处理拒绝 */ });
    return task;
  }

  async cancelTask(id, user) {
    const task = this.tasks.getAuthorized(id, user);
    await this.worker.request('detail.cancel', { accountId: task.accountId, taskId: task.id }).catch(() => {});
    return this.tasks.cancel(id, user);
  }

  async _runTask(task) {
    const outputPath = path.join(this.tasks.rootDir, task.id, 'result.png');
    try {
      const result = await this.worker.request('detail.run', {
        accountId: task.accountId, taskId: task.id, url: task.url, outputPath,
      }, { timeoutMs: DETAIL_RUN_TIMEOUT_MS });
      const finished = await this.tasks.transition(task.id, 'completed', {
        resultPath: outputPath, resultBytes: result.size, resultMime: 'image/png',
      });
      this.broadcast('detail-job', finished);
    } catch (error) {
      const phase = error?.code === 'DETAIL_CANCELLED' ? 'cancelled' : 'failed';
      try {
        const failed = await this.tasks.transition(task.id, phase, { error: { code: error?.code, message: error?.message } });
        this.broadcast('detail-job', failed);
      } catch { /* 任务可能已经处于终态（比如用户同时点了取消），忽略二次落盘 */ }
    }
  }

  _handleWorkerEvent({ type, payload } = {}) {
    if (type !== 'phase' || !payload) return;
    const { taskId, phase, assets, writtenRows, totalHeight } = payload;
    if (!taskId || !phase) return;
    const patch = {};
    if (assets && Number.isFinite(assets.total)) patch.assets = assets;
    if (Number.isFinite(writtenRows) && Number.isFinite(totalHeight) && totalHeight > 0) {
      patch.progress = Math.round((writtenRows / totalHeight) * 100);
    }
    this.tasks.transition(taskId, phase, patch)
      .then((task) => this.broadcast('detail-job', task))
      .catch(() => { /* 阶段乱序或任务已到终态（例如刚被取消），忽略这一条过期事件 */ });
  }
}

module.exports = { DetailJobRunner };
