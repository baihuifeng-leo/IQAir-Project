'use strict';

const path = require('node:path');
const { PlatformSessionStore } = require('./platform-session-store');
const { TaobaoSession } = require('./taobao-session');

function safeCode(value, fallback = 'WORKER_ERROR') {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(String(value || '')) ? value : fallback;
}

function serializeError(error) {
  return {
    code: safeCode(error?.code),
    message: (String(error?.message || '').split(/\r?\n/, 1)[0].trim() || '详情 Worker 请求失败').slice(0, 500),
  };
}

function accountIdFrom(payload) {
  return payload && Object.prototype.hasOwnProperty.call(payload, 'accountId') ? payload.accountId : 'default';
}

function unavailableDetailCommand() {
  const error = new Error('详情长图任务暂不可用');
  error.code = 'DETAIL_UNAVAILABLE';
  throw error;
}

function withAccountLock(session, payload, fn) {
  return session.runExclusive(accountIdFrom(payload), fn);
}

function createWorkerRouter({ session, detail, send }) {
  if (!session) throw new Error('淘宝会话未初始化');
  if (typeof send !== 'function') throw new Error('Worker IPC 发送器不可用');
  const routes = Object.assign(Object.create(null), {
    'session.status': (payload) => session.status(accountIdFrom(payload)),
    'session.beginLogin': (payload) => session.beginLogin(accountIdFrom(payload)),
    'session.qr': (payload) => session.qr(accountIdFrom(payload)),
    'session.verify': (payload) => session.verify(accountIdFrom(payload)),
    'session.clear': (payload) => session.clear(accountIdFrom(payload)),
    'detail.run': (payload) => withAccountLock(session, payload, () => (
      detail?.run ? detail.run(payload || {}) : unavailableDetailCommand()
    )),
    'detail.cancel': (payload) => withAccountLock(session, payload, () => (
      detail?.cancel ? detail.cancel(payload || {}) : unavailableDetailCommand()
    )),
  });

  return async function route(envelope) {
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
    try {
      const result = await command(envelope.payload);
      send({ kind: 'response', id: envelope.id, ok: true, result });
    } catch (error) {
      send({ kind: 'response', id: envelope.id, ok: false, error: serializeError(error) });
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
  const route = createWorkerRouter({ session, detail, send });
  process.on('message', route);
  return { session, route };
}

if (require.main === module) {
  startWorker().catch((error) => {
    console.error(`[detail-worker] ${serializeError(error).message}`);
    process.exitCode = 1;
  });
}

module.exports = { createWorkerRouter, serializeError, startWorker };
