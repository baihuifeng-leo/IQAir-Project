'use strict';

const https = require('node:https');
const path = require('node:path');
const { PlatformSessionStore } = require('./platform-session-store');
const { TaobaoSession } = require('./taobao-session');
const { assertAllowedNavigation } = require('./detail-url');
const { extractDetail } = require('./taobao-detail-adapter');
const { resolveAllImages } = require('./detail-image-resolver');
const { composeDetailPng } = require('./detail-png-composer');

function safeCode(value, fallback = 'WORKER_ERROR') {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(String(value || '')) ? value : fallback;
}

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  WORKER_ERROR: '详情服务发生错误',
  WORKER_REQUEST_CANCELLED: '请求已取消',
  WORKER_REQUEST_INVALID: 'Worker 请求不合法',
  WORKER_COMMAND_UNKNOWN: '不支持的详情 Worker 命令',
  CLEANUP_FAILED: '账号清理失败',
  ACCOUNT_BUSY: '该账号正忙',
  DETAIL_CANCELLED: '任务已取消',
  DETAIL_UNAVAILABLE: '详情长图任务暂不可用',
  QR_UNAVAILABLE: '登录二维码不可用',
  ACCOUNT_ID_INVALID: '账号标识不安全',
  PROFILE_UNSAFE: '账号目录不安全',
});

function serializeError(error) {
  const code = safeCode(error?.code);
  return {
    code,
    message: PUBLIC_ERROR_MESSAGES[code] || '详情服务发生错误',
  };
}

function accountIdFrom(payload) {
  return payload && Object.prototype.hasOwnProperty.call(payload, 'accountId') ? payload.accountId : 'default';
}

// resolveAllImages() 需要一个 (url, {signal}) => Promise<{ok, status, headers: Promise, stream}>
// 形状的下载器；alicdn.com 上的详情图是公开资源，不需要携带登录态 cookie，
// 用零依赖的 node:https 实现即可，不需要引入完整的 HTTP 客户端库。
function httpsImageRequest(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { signal }, (res) => {
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: Promise.resolve(res.headers),
        stream: res,
      });
    });
    req.on('error', reject);
  });
}

function createDetailRunner(session, {
  request = httpsImageRequest,
  sharp = require('sharp'),
  extract = extractDetail,
  resolve = resolveAllImages,
  compose = composeDetailPng,
} = {}) {
  return {
    async run(payload, { signal, emit = () => {} } = {}) {
      const { accountId = 'default', url, outputPath } = payload || {};
      if (typeof outputPath !== 'string' || !outputPath) {
        throw Object.assign(new Error('输出路径不合法'), { code: 'DETAIL_UNAVAILABLE' });
      }
      const target = assertAllowedNavigation(url);

      emit('phase', { phase: 'opening' });
      const page = await session.pageForDetail(accountId, target.toString(), { signal });

      emit('phase', { phase: 'detecting' });
      const { blocks } = await extract(page, {
        emit: (event) => emit('phase', { phase: 'detecting', ...event }),
      });
      if (signal?.aborted) throw Object.assign(new Error('任务已取消'), { code: 'DETAIL_CANCELLED' });

      const assetTotal = blocks.filter((block) => block?.kind === 'image' || block?.kind === 'video').length;
      emit('phase', { phase: 'resolving', assets: { total: assetTotal, current: 0 } });
      const resolved = await resolve(blocks, {
        request, sharp, signal,
        emit: (event) => emit('phase', {
          phase: 'resolving',
          assets: { total: assetTotal, current: Number.isInteger(event?.assetIndex) ? event.assetIndex + 1 : 0 },
        }),
      });

      emit('phase', { phase: 'composing' });
      return compose(resolved, {
        outputPath, signal,
        emit: (event) => emit('phase', { phase: 'composing', ...event }),
      });
    },
  };
}

function unavailableDetailCommand() {
  const error = new Error('详情长图任务暂不可用');
  error.code = 'DETAIL_UNAVAILABLE';
  throw error;
}

function withAccountLock(session, payload, fn, options) {
  return session.runExclusive(accountIdFrom(payload), fn, options);
}

function detailTaskKey(payload) {
  const taskId = payload && Object.prototype.hasOwnProperty.call(payload, 'taskId') ? payload.taskId : '';
  return JSON.stringify([String(accountIdFrom(payload)), String(taskId)]);
}

function cancelledDetailCommand() {
  const error = new Error('任务已取消');
  error.code = 'DETAIL_CANCELLED';
  return error;
}

function accountBusyCommand() {
  const error = new Error('该账号正忙');
  error.code = 'ACCOUNT_BUSY';
  return error;
}

function createWorkerRouter({ session, detail, send }) {
  if (!session) throw new Error('淘宝会话未初始化');
  if (typeof send !== 'function') throw new Error('Worker IPC 发送器不可用');
  const activeDetails = new Map();
  const requestControllers = new Map();
  const runDetail = (payload, requestSignal) => {
    const key = detailTaskKey(payload);
    if (activeDetails.has(key)) throw accountBusyCommand();
    const controller = new AbortController();
    activeDetails.set(key, controller);
    const abortFromRequest = () => controller.abort();
    if (requestSignal?.aborted) controller.abort();
    else requestSignal?.addEventListener('abort', abortFromRequest, { once: true });
    return withAccountLock(session, payload, async () => {
      if (!detail?.run) unavailableDetailCommand();
      if (controller.signal.aborted) throw cancelledDetailCommand();
      const taskId = payload && Object.prototype.hasOwnProperty.call(payload, 'taskId') ? payload.taskId : null;
      const emit = (type, data) => send({ kind: 'event', type, payload: { ...data, taskId, accountId: accountIdFrom(payload) } });
      try {
        return await detail.run(payload || {}, { signal: controller.signal, emit });
      } catch (error) {
        if (controller.signal.aborted) throw cancelledDetailCommand();
        throw error;
      }
    }, { signal: controller.signal }).finally(() => {
      requestSignal?.removeEventListener?.('abort', abortFromRequest);
      if (activeDetails.get(key) === controller) activeDetails.delete(key);
    });
  };
  const cancelDetail = (payload) => {
    const controller = activeDetails.get(detailTaskKey(payload));
    if (!controller) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
  };
  const routes = Object.assign(Object.create(null), {
    'session.status': (payload, signal) => session.status(accountIdFrom(payload), { signal }),
    'session.beginLogin': (payload, signal) => session.beginLogin(accountIdFrom(payload), { signal }),
    'session.qr': (payload, signal) => session.qr(accountIdFrom(payload), { signal }),
    'session.verify': (payload, signal) => session.verify(accountIdFrom(payload), { signal }),
    'session.clear': (payload, signal) => session.clear(accountIdFrom(payload), { signal }),
    'detail.run': runDetail,
    'detail.cancel': cancelDetail,
  });

  return async function route(envelope) {
    if (envelope?.kind === 'cancel' && typeof envelope.id === 'string') {
      requestControllers.get(envelope.id)?.abort();
      return;
    }
    if (!envelope || envelope.kind !== 'request' || typeof envelope.id !== 'string' || typeof envelope.type !== 'string') {
      return;
    }
    const command = routes[envelope.type];
    if (!command) {
      send({
        kind: 'response', id: envelope.id, ok: false,
        error: { code: 'WORKER_COMMAND_UNKNOWN', message: '不支持的详情 Worker 命令' },
      });
      return;
    }
    if (requestControllers.has(envelope.id)) {
      send({
        kind: 'response', id: envelope.id, ok: false,
        error: { code: 'WORKER_REQUEST_INVALID', message: 'Worker 请求不合法' },
      });
      return;
    }
    const controller = new AbortController();
    requestControllers.set(envelope.id, controller);
    try {
      const result = await command(envelope.payload, controller.signal);
      send({ kind: 'response', id: envelope.id, ok: true, result });
    } catch (error) {
      send({ kind: 'response', id: envelope.id, ok: false, error: serializeError(error) });
    } finally {
      if (requestControllers.get(envelope.id) === controller) requestControllers.delete(envelope.id);
    }
  };
}

async function startWorker({ dataDir = process.env.DATA_DIR || path.join(__dirname, 'data'), detail } = {}) {
  const { chromium } = require('playwright');
  const sessionDir = path.join(path.resolve(dataDir), 'platform-sessions');
  const statusStore = new PlatformSessionStore(sessionDir);
  await statusStore.load();
  const send = (message) => { if (typeof process.send === 'function') process.send(message); };
  const session = new TaobaoSession({
    dataDir: path.join(sessionDir, 'taobao'),
    chromium,
    statusStore,
    emit: (type, payload) => send({ kind: 'event', type, payload }),
  });
  const route = createWorkerRouter({ session, detail: detail || createDetailRunner(session), send });
  process.on('message', route);
  return { session, route };
}

if (require.main === module) {
  startWorker().catch((error) => {
    console.error(`[detail-worker] ${serializeError(error).message}`);
    process.exitCode = 1;
  });
}

module.exports = { createWorkerRouter, serializeError, startWorker, createDetailRunner, httpsImageRequest };
