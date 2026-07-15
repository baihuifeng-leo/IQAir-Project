/**
 * 电商工作台 · E-commerce Workbench
 * 零依赖 Node 服务：静态托管 + 协同编辑 + 用户管理 + 图片上传
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { merge3, deepEqual } = require('./merge.js');
const { diffSummary } = require('./audit.js');
const { ReviewStore } = require('./reviews-store.js');
const { Preview3DStore } = require('./preview3d-store.js');
const { ReportStore } = require('./report-store.js');
const { pipeline } = require('stream/promises');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, '.session-secret');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
const REVIEWS_DIR = path.join(DATA_DIR, 'reviews');
const PRODUCTS3D_DIR = path.join(DATA_DIR, 'products3d');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SEED_FILE = path.join(PUBLIC_DIR, 'seed.json');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PIN = process.env.ADMIN_PIN || '123456';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const COOKIE = 'wb_session';
const DOCS = ['matrix', 'compare'];

const MAX_BODY = 24 * 1024 * 1024;
const MAX_IMAGE = 40 * 1024 * 1024;   // 原图直传，不重编码，所以放宽
const MAX_XLSX = 60 * 1024 * 1024;
const MAX_BACKUPS = 30;
const MAX_AUDIT_BYTES = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
};
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const PALETTE = ['#4ee0c1', '#5b8cff', '#f4a63b', '#e2679a', '#9b7ff0', '#3fbf6f', '#ef6b5e', '#3fc0d8'];

/* ═══ 会话密钥 ═══════════════════════════════════════════ */
let SECRET = null;
const b64u = (b) => Buffer.from(b).toString('base64url');
const sign = (d) => crypto.createHmac('sha256', SECRET).update(d).digest('base64url');

function issueToken(uid) {
  const payload = b64u(JSON.stringify({ uid, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return payload + '.' + sign(payload);
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  const expect = sign(payload);
  if (!mac || mac.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return o.exp > Date.now() ? o : null;
  } catch { return null; }
}

/* ═══ PIN：scrypt 加盐存储，绝不存明文 ═══════════════════ */
const hashPin = (pin, salt = crypto.randomBytes(16).toString('hex')) => ({
  salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex')
});
function checkPin(pin, rec) {
  if (!rec?.salt) return false;
  const a = Buffer.from(crypto.scryptSync(String(pin), rec.salt, 32).toString('hex'));
  const b = Buffer.from(rec.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const validPin = (p) => /^\d{6}$/.test(String(p || ''));

/* ═══ 用户表 ═════════════════════════════════════════════ */
let users = [];
async function loadUsers() {
  try {
    users = JSON.parse(await fsp.readFile(USERS_FILE, 'utf8'));
  } catch {
    users = [{
      id: 'u_' + crypto.randomBytes(4).toString('hex'),
      name: ADMIN_USER, admin: true, color: PALETTE[0],
      pin: hashPin(ADMIN_PIN), defaultPin: ADMIN_PIN === '123456'
    }];
    await saveUsers();
    console.log(`[init] 已创建管理员「${ADMIN_USER}」，PIN：${ADMIN_PIN}`);
    if (ADMIN_PIN === '123456') console.warn('[init] 正在使用默认 PIN 123456，登录后请立刻改掉。');
  }
}
const saveUsers = () => writeAtomic(USERS_FILE, JSON.stringify(users, null, 1));
const pubUser = (u) => ({ id: u.id, name: u.name, admin: !!u.admin, color: u.color, defaultPin: !!u.defaultPin, hiddenModules: u.hiddenModules || [] });
const MODULES = ['matrix', 'compare', 'reviews', 'preview3d', 'reports'];

/* ═══ 文档：每份独立 rev，冲突走三方合并 ═════════════════ */
/* ═══ 变更日志：JSONL 追加写，超过 8MB 轮转一次 ═════════ */
async function audit(user, action, detail = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), u: user ? user.name : '系统', uid: user?.id || '', action, ...detail }) + '\n';
  try {
    await fsp.appendFile(AUDIT_FILE, line);
    const st = await fsp.stat(AUDIT_FILE);
    if (st.size > MAX_AUDIT_BYTES) await fsp.rename(AUDIT_FILE, AUDIT_FILE + '.1');
  } catch (e) { console.error('[audit]', e.message); }
}

async function readAudit(limit = 300) {
  let text = '';
  try { text = await fsp.readFile(AUDIT_FILE, 'utf8'); } catch { return []; }
  const lines = text.trim().split('\n').filter(Boolean);
  return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

let db = null;
async function loadDb() {
  try {
    db = JSON.parse(await fsp.readFile(DB_FILE, 'utf8'));
  } catch {
    db = JSON.parse(await fsp.readFile(SEED_FILE, 'utf8'));
    console.log('[init] 已用种子数据创建 db.json');
  }
  db.revs = db.revs || {};
  DOCS.forEach((d) => (db.revs[d] = db.revs[d] || 1));
  if (await migrateEnglish()) console.log('[init] 已为竞品对位补齐英文字段');
  await persist();
}

/** 老数据没有英文字段：按中文原文去种子里查一遍，查不到的留空（界面会标"待更新"） */
async function migrateEnglish() {
  const c = db.compare;
  if (!c || c.title_en !== undefined) return false;
  let seed = {};
  try { seed = JSON.parse(await fsp.readFile(SEED_FILE, 'utf8')).compare; } catch {}

  const dict = new Map();
  const learn = (zh, en) => { if (zh && en) dict.set(zh, en); };
  (seed.groups || []).forEach((g) => {
    learn(g.name, g.name_en);
    (g.rows || []).forEach((r) => {
      learn(r.label, r.label_en);
      Object.values(r.cells || {}).forEach((cell) => (cell.lines || []).forEach((ln) => { learn(ln.v, ln.ev); learn(ln.s, ln.es); }));
    });
  });
  learn(seed.title, seed.title_en);
  learn(seed.subtitle, seed.subtitle_en);

  const look = (zh) => dict.get(zh) || '';
  c.title_en = look(c.title);
  c.subtitle_en = look(c.subtitle);
  c.lang = c.lang || 'zh';
  (c.brands || []).forEach((b) => { if (b.image34 === undefined) b.image34 = ''; });
  (c.groups || []).forEach((g) => {
    if (g.name_en === undefined) g.name_en = look(g.name);
    (g.rows || []).forEach((r) => {
      if (r.label_en === undefined) r.label_en = look(r.label);
      Object.values(r.cells || {}).forEach((cell) => (cell.lines || []).forEach((ln) => {
        if (ln.ev === undefined) ln.ev = look(ln.v);
        if (ln.es === undefined) ln.es = look(ln.s);
        if (ln.stale === undefined) ln.stale = false;
      }));
    });
  });
  return true;
}
const persist = () => writeAtomic(DB_FILE, JSON.stringify(db, null, 1));

/* ═══ SSE：在线成员 + 实时推送 ═══════════════════════════ */
const clients = new Set(); // { res, user, tabId }

function broadcast(event, data, exceptTab) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (c.tabId === exceptTab) continue;
    try { c.res.write(frame); } catch {}
  }
}
function presence() {
  const seen = new Map();
  for (const c of clients) seen.set(c.user.id, pubUser(c.user));
  return [...seen.values()];
}
const announcePresence = () => broadcast('presence', { online: presence() });

/* ═══ 工具 ═══════════════════════════════════════════════ */
async function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}
async function rotateBackup(tag = '') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `db-${stamp}${tag ? '-' + tag : ''}.json`;
  await fsp.writeFile(path.join(BACKUP_DIR, file), JSON.stringify(db, null, 1));
  const files = (await fsp.readdir(BACKUP_DIR)).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
    await fsp.unlink(path.join(BACKUP_DIR, f)).catch(() => {});
  }
  return file;
}
/** 每天本地时间 00:00 自动备份一次，滚动保留 30 份 */
function scheduleNightly() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0); // 下一个午夜
  const wait = next - now;
  setTimeout(async () => {
    try {
      const file = await rotateBackup();
      await audit(null, 'backup.auto', { file });
      console.log('[backup] 每日自动备份完成：' + file);
    } catch (e) { console.error('[backup]', e.message); }
    scheduleNightly();
  }, wait).unref?.();
  console.log(`[backup] 下次自动备份：${next.toLocaleString('zh-CN')}`);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('内容太大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const body = async (req, limit) => { try { return JSON.parse((await readBody(req, limit)) || '{}'); } catch { return {}; } };

/** 收裸二进制（图片、xlsx）。不解码、不转 base64，内存里只过一遍。 */
function readBinary(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error(`内容超过 ${Math.round(limit / 1048576)}MB`), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const HEADERS = { 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' };

function json(res, status, obj, extra = {}) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { ...HEADERS, ...extra, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(b) });
  res.end(b);
}

async function serveStatic(res, root, rel, immutable = false) {
  const file = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(root)) return json(res, 403, { error: '路径越界' });
  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) throw new Error('dir');
    res.writeHead(200, {
      ...HEADERS,
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 找不到这个文件');
  }
}

const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function parseCookies(h = '') {
  const out = {};
  h.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

const OPEN = new Set([
  '/login', '/login.html', '/styles.css', '/api/login', '/api/health', '/robots.txt', '/favicon.ico',
  // 登录页自带的 3D 背景（Three.js），未登录也要能加载
  '/login-scene.js', '/three.module.min.js', '/three-orbitcontrols.js', '/three-css2drenderer.js',
  '/three-effectcomposer.js', '/three-renderpass.js', '/three-shaderpass.js', '/three-outputpass.js',
  '/three-unrealbloompass.js', '/three-pass.js', '/three-maskpass.js', '/three-copyshader.js',
  '/three-luminosityhighpassshader.js', '/three-outputshader.js'
]);

/* ═══ 路由 ═══════════════════════════════════════════════ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  try {
    if (p === '/robots.txt') { res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /\n'); }
    if (p === '/api/health') return json(res, 200, { ok: true });

    if (p === '/api/login' && req.method === 'POST') {
      const { name, pin } = await body(req, 4096);
      const u = users.find((x) => x.name === String(name || '').trim());
      if (!u || !checkPin(pin, u.pin)) {
        await new Promise((r) => setTimeout(r, 300));
        return json(res, 401, { error: '用户名或 PIN 不对' });
      }
      const cookie = [`${COOKIE}=${issueToken(u.id)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
        `Max-Age=${SESSION_DAYS * 86400}`, isHttps(req) ? 'Secure' : ''].filter(Boolean).join('; ');
      audit(u, 'login');
      return json(res, 200, { user: pubUser(u) }, { 'Set-Cookie': cookie });
    }

    if (p === '/api/logout' && req.method === 'POST')
      return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });

    if (p === '/login' || p === '/login.html') return serveStatic(res, PUBLIC_DIR, 'login.html');

    /* ── 闸门 ────────────────────────────────────────── */
    const sess = verifyToken(parseCookies(req.headers.cookie || '')[COOKIE]);
    const me = sess && users.find((u) => u.id === sess.uid);
    if (!me && !OPEN.has(p)) {
      if (p.startsWith('/api/') || p.startsWith('/uploads/')) return json(res, 401, { error: '请先登录' });
      res.writeHead(302, { ...HEADERS, Location: '/login' });
      return res.end();
    }

    if (p === '/api/me') return json(res, 200, pubUser(me));

    /* ── 用户管理 ────────────────────────────────────── */
    if (p === '/api/users' && req.method === 'GET') return json(res, 200, users.map(pubUser));

    if (p === '/api/users' && req.method === 'POST') {
      if (!me.admin) return json(res, 403, { error: '只有管理员能加人' });
      const { name, pin, admin } = await body(req, 4096);
      const nm = String(name || '').trim();
      if (!nm) return json(res, 400, { error: '用户名不能为空' });
      if (users.some((u) => u.name === nm)) return json(res, 409, { error: '这个用户名已经有人用了' });
      if (!validPin(pin)) return json(res, 400, { error: 'PIN 必须是 6 位数字' });
      const u = { id: 'u_' + crypto.randomBytes(4).toString('hex'), name: nm, admin: !!admin, color: PALETTE[users.length % PALETTE.length], pin: hashPin(pin) };
      users.push(u);
      await saveUsers();
      audit(me, 'user.create', { detail: [`新增成员「${nm}」`] });
      return json(res, 200, pubUser(u));
    }

    if (p.startsWith('/api/users/')) {
      const id = p.slice('/api/users/'.length);
      const u = users.find((x) => x.id === id);
      if (!u) return json(res, 404, { error: '没有这个用户' });

      if (req.method === 'PATCH') {
        const isSelf = u.id === me.id;
        if (!isSelf && !me.admin) return json(res, 403, { error: '只能改自己的 PIN' });
        const { pin, name, admin, hiddenModules } = await body(req, 4096);
        if (pin !== undefined) {
          if (!validPin(pin)) return json(res, 400, { error: 'PIN 必须是 6 位数字' });
          u.pin = hashPin(pin);
          delete u.defaultPin;
        }
        if (name !== undefined && me.admin) {
          const nm = String(name).trim();
          if (!nm) return json(res, 400, { error: '用户名不能为空' });
          if (users.some((x) => x.name === nm && x.id !== u.id)) return json(res, 409, { error: '这个用户名已经有人用了' });
          u.name = nm;
        }
        if (admin !== undefined && me.admin) {
          if (u.id === me.id && !admin) return json(res, 400, { error: '不能取消自己的管理员身份' });
          u.admin = !!admin;
        }
        // 界面显示偏好，只能改自己的——就算是管理员也不能帮别人关模块，这跟账号安全无关
        if (hiddenModules !== undefined) {
          if (!isSelf) return json(res, 403, { error: '只能改自己的显示设置' });
          if (!Array.isArray(hiddenModules) || hiddenModules.some((m) => !MODULES.includes(m))) {
            return json(res, 400, { error: '模块列表不对' });
          }
          if (hiddenModules.length >= MODULES.length) return json(res, 400, { error: '至少要留一个模块显示' });
          u.hiddenModules = hiddenModules;
        }
        await saveUsers();
        announcePresence();
        const what = [];
        if (pin !== undefined) what.push(u.id === me.id ? '改了自己的 PIN' : `重置了「${u.name}」的 PIN`);
        if (name !== undefined) what.push(`改名为「${u.name}」`);
        if (admin !== undefined) what.push(`${u.name} ${u.admin ? '设为' : '取消'}管理员`);
        if (what.length) audit(me, 'user.update', { detail: what }); // hiddenModules 是个人偏好，不进变更日志
        return json(res, 200, pubUser(u));
      }

      if (req.method === 'DELETE') {
        if (!me.admin) return json(res, 403, { error: '只有管理员能删人' });
        if (u.id === me.id) return json(res, 400, { error: '不能删掉自己' });
        if (u.admin && users.filter((x) => x.admin).length <= 1) return json(res, 400, { error: '至少要留一个管理员' });
        users = users.filter((x) => x.id !== u.id);
        await saveUsers();
        audit(me, 'user.delete', { detail: [`删除成员「${u.name}」`] });
        return json(res, 200, { ok: true });
      }
    }

    /* ── 协同：实时通道 ──────────────────────────────── */
    if (p === '/api/events') {
      res.writeHead(200, {
        ...HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no' // 让 Lucky / nginx 不要缓冲
      });
      const tabId = url.searchParams.get('tab') || crypto.randomBytes(4).toString('hex');
      const client = { res, user: me, tabId };
      clients.add(client);
      res.write(`event: hello\ndata: ${JSON.stringify({ tabId, online: presence() })}\n\n`);
      announcePresence();

      const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
      req.on('close', () => { clearInterval(beat); clients.delete(client); announcePresence(); });
      return;
    }

    /* ── 文档读写 ────────────────────────────────────── */
    if (p === '/api/state' && req.method === 'GET')
      return json(res, 200, { revs: db.revs, matrix: db.matrix, compare: db.compare });

    if (p.startsWith('/api/doc/') && req.method === 'PUT') {
      const name = p.slice('/api/doc/'.length);
      if (!DOCS.includes(name)) return json(res, 404, { error: '没有这份文档' });

      const { rev, base, doc, tab } = await body(req);
      if (!doc || typeof doc !== 'object') return json(res, 400, { error: '文档内容不对，本次没有保存' });

      let merged = false;
      let next = doc;
      if (rev !== db.revs[name]) {
        // 期间有人改过：拿 base 做三方合并，谁也不覆盖谁
        next = merge3(base, doc, db[name]);
        merged = true;
      }
      if (deepEqual(next, db[name])) return json(res, 200, { rev: db.revs[name], merged: false });

      const detail = diffSummary(db[name], next);
      db[name] = next;
      db.revs[name] = db.revs[name] + 1;
      db.updatedAt = new Date().toISOString();
      await persist();
      audit(me, 'doc.save', { doc: name, merged, detail });

      broadcast('doc', { name, rev: db.revs[name], doc: next, by: pubUser(me) }, tab);
      return json(res, 200, { rev: db.revs[name], merged, doc: merged ? next : undefined });
    }

    if (p === '/api/snapshot' && req.method === 'POST') {
      const file = await rotateBackup('manual');
      audit(me, 'backup.manual', { detail: [file] });
      return json(res, 200, { ok: true, file });
    }

    /* ── 变更日志（仅管理员）───────────────────────────── */
    if (p === '/api/logs') {
      if (!me.admin) return json(res, 403, { error: '只有管理员能看变更日志' });
      const limit = Math.min(1000, Number(url.searchParams.get('limit')) || 300);
      return json(res, 200, await readAudit(limit));
    }

    /* ── 备份与恢复（仅管理员）─────────────────────────── */
    if (p === '/api/backups' && req.method === 'GET') {
      if (!me.admin) return json(res, 403, { error: '只有管理员能管备份' });
      const files = (await fsp.readdir(BACKUP_DIR)).filter((f) => f.endsWith('.json')).sort().reverse();
      const out = [];
      for (const f of files) {
        const st = await fsp.stat(path.join(BACKUP_DIR, f));
        out.push({ file: f, size: st.size, time: st.mtime.toISOString(), auto: !f.includes('-manual') });
      }
      return json(res, 200, out);
    }

    if (p === '/api/backups/restore' && req.method === 'POST') {
      if (!me.admin) return json(res, 403, { error: '只有管理员能恢复备份' });
      const { file } = await body(req, 4096);
      if (!/^db-[\w.-]+\.json$/.test(String(file || ''))) return json(res, 400, { error: '备份文件名不对' });
      const full = path.join(BACKUP_DIR, file);
      if (!full.startsWith(BACKUP_DIR)) return json(res, 403, { error: '路径越界' });

      let snap;
      try { snap = JSON.parse(await fsp.readFile(full, 'utf8')); }
      catch { return json(res, 404, { error: '这个备份读不出来' }); }
      if (!snap.matrix || !snap.compare) return json(res, 400, { error: '这个备份里没有完整数据' });

      const safety = await rotateBackup('before-restore'); // 先给现状留个后路
      DOCS.forEach((d) => { db[d] = snap[d]; db.revs[d] = (db.revs[d] || 1) + 1; });
      db.updatedAt = new Date().toISOString();
      await persist();
      audit(me, 'backup.restore', { detail: [`恢复自 ${file}`, `恢复前已存 ${safety}`] });
      DOCS.forEach((d) => broadcast('doc', { name: d, rev: db.revs[d], doc: db[d], by: pubUser(me) }, null));
      return json(res, 200, { ok: true, safety });
    }

    if (p === '/api/upload' && req.method === 'POST') {
      // 原图直传：不经 canvas 重编码、不转 base64，字节原样落盘
      const ct = (req.headers['content-type'] || '').split(';')[0].trim();
      const ext = IMAGE_EXT[ct];
      if (!ext) return json(res, 415, { error: '只支持 PNG、JPG、WebP 三种格式' });
      const buf = await readBinary(req, MAX_IMAGE);
      if (!buf.length) return json(res, 400, { error: '收到的是空文件' });
      const name = crypto.randomBytes(9).toString('hex') + ext;
      await fsp.writeFile(path.join(UPLOAD_DIR, name), buf);
      audit(me, 'upload', { detail: [`上传原图 ${(buf.length / 1048576).toFixed(2)} MB`] });
      return json(res, 200, { url: '/uploads/' + name, bytes: buf.length });
    }

    /* ── 评论风向标 ──────────────────────────────────── */
    if (p === '/api/reviews/summary') return json(res, 200, reviews.summary);

    if (p === '/api/reviews/brands') return json(res, 200, reviews.brands);

    if (p === '/api/reviews/keyword') {
      const term = url.searchParams.get('term') || '';
      const aspect = url.searchParams.get('aspect') || '';
      const polarity = url.searchParams.get('polarity') === 'neg' ? 'neg' : 'pos';
      const brandId = url.searchParams.get('brand') || '';
      const productId = url.searchParams.get('product') || '';
      // 不给 term 就是查一整类（维度和/或品牌/产品下的所有差评句），条数天然更多，limit 放宽一些
      return json(res, 200, reviews.contexts({ term, aspect, polarity, brandId, productId, limit: term ? 30 : 80 }));
    }

    if (p === '/api/reviews/import' && req.method === 'POST') {
      const brandName = (url.searchParams.get('brand') || '').trim();
      const productId = (url.searchParams.get('product') || '').trim();
      if (!brandName && !productId) return json(res, 400, { error: '要先填品牌名，或者选一个产品' });
      const buf = await readBinary(req, MAX_XLSX);
      let report;
      try { report = await reviews.import(buf, brandName, productId || undefined); }
      catch (e) { return json(res, 400, { error: e.message }); }
      audit(me, 'reviews.import', {
        detail: [`${report.brand}${report.product ? ' · ' + report.product : ''}：新增 ${report.added} 条，跳过 ${report.skipped} 条已存在，文件内重复 ${report.dupInFile} 条`]
      });
      broadcast('reviews', { by: pubUser(me) }, null);
      return json(res, 200, report);
    }

    if (p.startsWith('/api/reviews/brand/') && req.method === 'DELETE') {
      if (!me.admin) return json(res, 403, { error: '只有管理员能删除品牌数据' });
      const id = p.slice('/api/reviews/brand/'.length);
      const b = reviews.brands.find((x) => x.id === id);
      if (!b) return json(res, 404, { error: '没有这个品牌' });
      await reviews.removeBrand(id);
      audit(me, 'reviews.delete', { detail: [`删除品牌「${b.name}」的全部评论`] });
      broadcast('reviews', { by: pubUser(me) }, null);
      return json(res, 200, { ok: true });
    }

    /* ── 本品分析：产品是「本品分析」专属的一层，挂在 IQAir 这个品牌之下 ── */
    if (p === '/api/reviews/products' && req.method === 'POST') {
      const input = await body(req, 1024);
      const name = String(input.name || '').trim();
      if (!name) return json(res, 400, { error: '产品名称不能为空' });
      const brand = reviews.ensureBrand('IQAir');
      await reviews.saveBrands();
      let product;
      try { product = await reviews.ensureProduct(brand.id, name); }
      catch (e) { return json(res, 400, { error: e.message }); }
      audit(me, 'reviews.product.create', { detail: [`新建产品「${product.name}」`] });
      broadcast('reviews', { by: pubUser(me) }, null);
      return json(res, 200, { product });
    }

    if (p.startsWith('/api/reviews/product/') && req.method === 'DELETE') {
      if (!me.admin) return json(res, 403, { error: '只有管理员能删除产品数据' });
      const id = p.slice('/api/reviews/product/'.length);
      const prod = reviews.products.find((x) => x.id === id);
      if (!prod) return json(res, 404, { error: '没有这个产品' });
      await reviews.removeProduct(id);
      audit(me, 'reviews.delete', { detail: [`删除产品「${prod.name}」的全部评论`] });
      broadcast('reviews', { by: pubUser(me) }, null);
      return json(res, 200, { ok: true });
    }

    /* ── 竞品 3D 预览 ────────────────────────────────────── */
    if (p === '/api/products3d/summary') return json(res, 200, preview3d.summary);

    if (p === '/api/products3d/import' && req.method === 'POST') {
      const buf = await readBinary(req, MAX_XLSX);
      let report;
      try { report = await preview3d.import(buf); }
      catch (e) { return json(res, 400, { error: e.message }); }
      audit(me, 'products3d.import', {
        detail: [`导入 ${report.total} 款产品，覆盖 ${report.brands} 个品牌，跳过 ${report.skipped} 行`]
      });
      broadcast('products3d', { by: pubUser(me) }, null);
      return json(res, 200, report);
    }

    /* ── 报告管理 · 个人报告 ─────────────────────────────── */
    if (p === '/api/reports/personal/summary') return json(res, 200, await reports.summary(me.id));

    if (p === '/api/reports/personal/import' && req.method === 'POST') {
      const buf = await readBinary(req, MAX_XLSX);
      let report;
      try { report = await reports.import(me.id, buf); }
      catch (e) { return json(res, 400, { error: e.message }); }
      audit(me, 'reports.import', { detail: [`个人报告：新增 ${report.added} 天，更新 ${report.updated} 天`] });
      return json(res, 200, report);
    }

    if (p === '/api/reports/personal/weimeng/save' && req.method === 'POST') {
      const input = await body(req, 8192);
      let result;
      try { result = await reports.weimengSave(me.id, input); }
      catch (e) { return json(res, 400, { error: e.message }); }
      audit(me, 'reports.weimeng.save', { detail: [`微盟数据：${result.entry.weekStart} 周${result.isNew ? '新增' : '更新'}`] });
      return json(res, 200, result);
    }

    if (p.startsWith('/uploads/')) return serveStatic(res, UPLOAD_DIR, p.slice('/uploads/'.length), true);

    if (req.method === 'GET' || req.method === 'HEAD')
      return serveStatic(res, PUBLIC_DIR, p === '/' ? 'index.html' : p);

    json(res, 404, { error: '没有这个接口' });
  } catch (err) {
    console.error('[error]', err);
    json(res, err.status || 500, { error: err.message || '服务器出错' });
  }
});

const reviews = new ReviewStore(REVIEWS_DIR);
const preview3d = new Preview3DStore(PRODUCTS3D_DIR);
const reports = new ReportStore(REPORTS_DIR);

(async () => {
  for (const d of [DATA_DIR, UPLOAD_DIR, BACKUP_DIR, REVIEWS_DIR, PRODUCTS3D_DIR, REPORTS_DIR]) await fsp.mkdir(d, { recursive: true });
  try { SECRET = await fsp.readFile(SECRET_FILE); }
  catch { SECRET = crypto.randomBytes(32); await fsp.writeFile(SECRET_FILE, SECRET, { mode: 0o600 }); }
  await loadUsers();
  await loadDb();
  await reviews.load();
  await preview3d.load();
  scheduleNightly();
  server.listen(PORT, '0.0.0.0', () => console.log(`电商工作台已启动 → 端口 ${PORT}，数据目录 ${DATA_DIR}`));
})();
