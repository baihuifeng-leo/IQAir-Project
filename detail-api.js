'use strict';

const fs = require('node:fs');

const HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' };
const ACCOUNT_PREFIX = '/api/platform-accounts/taobao/default/';
const JOBS_PREFIX = '/api/detail-jobs/';

const NOT_FOUND_MESSAGES = new Set(['找不到任务', '无权访问任务']);

function errorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (NOT_FOUND_MESSAGES.has(error?.message)) return 404;
  return 400;
}

async function handleDetailApi(req, res, { p, me, json, body, runner }) {
  if (p === '/api/platform-accounts' && req.method === 'GET') {
    json(res, 200, { accounts: await runner.accountStatuses() });
    return true;
  }

  if (p.startsWith(ACCOUNT_PREFIX)) {
    const action = p.slice(ACCOUNT_PREFIX.length);
    if (!me.admin) { json(res, 403, { error: '只有管理员能管理平台账号' }); return true; }

    if (action === 'login' && req.method === 'POST') {
      json(res, 200, await runner.beginLogin('default'));
      return true;
    }
    if (action === 'qr' && req.method === 'GET') {
      let png;
      try { png = await runner.qrPng('default'); }
      catch (error) { json(res, errorStatus(error), { error: error.message }); return true; }
      res.writeHead(200, { ...HEADERS, 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': png.length });
      res.end(png);
      return true;
    }
    if (action === 'verify' && req.method === 'POST') {
      json(res, 200, await runner.verify('default'));
      return true;
    }
    if (action === 'session' && req.method === 'DELETE') {
      json(res, 200, await runner.clearAccount('default'));
      return true;
    }
    return false;
  }

  if (p === '/api/detail-jobs' && req.method === 'GET') {
    json(res, 200, { tasks: runner.listTasksFor(me) });
    return true;
  }

  if (p === '/api/detail-jobs' && req.method === 'POST') {
    const { url } = await body(req, 8192);
    try {
      const task = await runner.createTask(me, { url });
      json(res, 200, task);
    } catch (error) { json(res, errorStatus(error), { error: error.message }); }
    return true;
  }

  if (p.startsWith(JOBS_PREFIX)) {
    const rest = p.slice(JOBS_PREFIX.length);
    const [id, action] = rest.split('/');
    if (!id) return false;

    if (!action && req.method === 'GET') {
      try { json(res, 200, runner.getTaskAuthorized(id, me)); }
      catch (error) { json(res, errorStatus(error), { error: error.message }); }
      return true;
    }
    if (action === 'cancel' && req.method === 'POST') {
      try { json(res, 200, await runner.cancelTask(id, me)); }
      catch (error) { json(res, errorStatus(error), { error: error.message }); }
      return true;
    }
    if (action === 'download' && req.method === 'GET') {
      let task;
      try { task = runner.getTaskAuthorized(id, me); }
      catch (error) { json(res, errorStatus(error), { error: error.message }); return true; }
      if (task.phase !== 'completed' || !task.resultPath) {
        json(res, 409, { error: '任务尚未完成，暂不能下载' });
        return true;
      }
      let stat;
      try { stat = await fs.promises.stat(task.resultPath); }
      catch { json(res, 404, { error: '结果文件不存在' }); return true; }
      res.writeHead(200, {
        ...HEADERS,
        'Content-Type': task.resultMime || 'image/png',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${task.id}.png"`,
      });
      fs.createReadStream(task.resultPath).pipe(res);
      return true;
    }
  }

  return false;
}

module.exports = { handleDetailApi };
