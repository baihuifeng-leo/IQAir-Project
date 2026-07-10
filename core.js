/* ═══════════════════════════════════════════════════════════
   core.js — 状态、协同同步、撤销栈、图片处理、视图切换
   ═══════════════════════════════════════════════════════════ */
const App = (() => {
  const DOCS = ['matrix', 'compare'];
  let state = { matrix: null, compare: null };
  let base = {};   // 上一次和服务器对齐的版本，合并时当共同祖先
  let revs = {};
  let me = null;
  let tabId = Math.random().toString(36).slice(2, 10);

  let view = 'matrix';
  const past = [], future = [];
  const MAX_HISTORY = 80;

  const timers = {}, inflight = {}, dirty = {}, pending = {};

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const uid = (p) => p + Math.random().toString(36).slice(2, 9);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const anyDirty = () => DOCS.some((d) => dirty[d]);

  /* ── 提示条 ─────────────────────────────────────────── */
  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('#toaster').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, kind === 'bad' ? 4200 : 2400);
  }

  function flag(mode, text) {
    const f = $('#saveflag');
    f.dataset.state = mode;
    f.querySelector('span').textContent = text;
  }

  /* ── 同步：每份文档独立 rev，冲突交给服务端三方合并 ──── */
  function save(doc) {
    const target = doc === 'both' ? DOCS : [doc || view];
    target.forEach((d) => {
      dirty[d] = true;
      clearTimeout(timers[d]);
      timers[d] = setTimeout(() => flush(d), 700);
    });
    flag('saving', '保存中');
  }

  async function flush(name) {
    if (inflight[name]) { timers[name] = setTimeout(() => flush(name), 300); return; }
    inflight[name] = true;
    const sent = clone(state[name]);
    try {
      const r = guard(await fetch('/api/doc/' + name, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rev: revs[name], base: base[name], doc: sent, tab: tabId })
      }));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '服务器拒绝了这次保存');

      revs[name] = j.rev;
      if (j.merged && j.doc) {
        state[name] = j.doc;
        base[name] = clone(j.doc);
        renderDoc(name);
        if (name === 'compare') Compare.syncHeads(); else syncTitles();
        toast('刚才有人同时在改，已经把两边的改动合到一起了');
      } else {
        base[name] = sent;
      }
      // 提交期间又打了字 → 保持 dirty，等下一轮
      dirty[name] = JSON.stringify(state[name]) !== JSON.stringify(sent);
      if (dirty[name]) timers[name] = setTimeout(() => flush(name), 300);
      else if (!anyDirty()) flag('idle', '已同步');

      const p = pending[name];
      if (p && !dirty[name]) { pending[name] = null; adopt(name, p.rev, p.doc, p.by); }
    } catch (e) {
      if (e.expired) return;
      flag('error', '保存失败');
      toast('保存失败：' + e.message + '。改动还在页面里，会自动重试。', 'bad');
      setTimeout(() => { if (dirty[name]) flush(name); }, 5000);
    } finally {
      inflight[name] = false;
    }
  }

  function guard(r) {
    if (r.status === 401) {
      flag('error', '登录已过期');
      toast('登录已过期，3 秒后回登录页。', 'bad');
      setTimeout(() => location.replace('/login'), 3000);
      throw Object.assign(new Error('登录已过期'), { expired: true });
    }
    return r;
  }

  const renderDoc = (name) => (name === 'matrix' ? Matrix.render() : Compare.render());

  /* ── 实时通道 ───────────────────────────────────────── */
  function connect() {
    const es = new EventSource('/api/events?tab=' + tabId);

    es.addEventListener('presence', (e) => renderPresence(JSON.parse(e.data).online));
    es.addEventListener('hello', (e) => renderPresence(JSON.parse(e.data).online));

    es.addEventListener('doc', (e) => {
      const { name, rev, doc, by } = JSON.parse(e.data);
      if (by.id === me.id && !dirty[name]) { revs[name] = rev; base[name] = clone(doc); state[name] = doc; return; }
      // 自己正在改这份文档 → 先不动，等我们提交时服务端会合并
      if (dirty[name]) return;
      // 光标停在这份文档的输入框里 → 别把字吞了，等失焦再应用
      if (focusedDoc() === name) { pending[name] = { rev, doc, by }; showPendingHint(by); return; }
      adopt(name, rev, doc, by);
    });

    es.addEventListener('reviews', (e) => {
      const { by } = JSON.parse(e.data);
      if (by.id !== me.id) toast(`${by.name} 更新了评论数据`, 'live');
      Reviews.refresh();
    });

    es.onerror = () => flag('error', '连接断开');
    es.onopen = () => { if (!anyDirty()) flag('idle', '已同步'); };
  }

  function adopt(name, rev, doc, by) {
    revs[name] = rev;
    state[name] = doc;
    base[name] = clone(doc);
    renderDoc(name);
    if (name === 'compare') Compare.syncHeads(); else syncTitles();
    toast(`${by.name} 更新了${name === 'matrix' ? '价格带沙盘' : '竞品对位'}`, 'live');
  }

  function focusedDoc() {
    const a = document.activeElement;
    if (!a || !a.closest) return null;
    const v = a.closest('.view');
    return v ? v.dataset.view : null;
  }

  let hintTimer = null;
  function showPendingHint(by) {
    flag('live', `${by.name} 有新改动`);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { if (!anyDirty()) flag('idle', '已同步'); }, 4000);
  }

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      DOCS.forEach((d) => {
        const p = pending[d];
        if (p && focusedDoc() !== d && !dirty[d]) { pending[d] = null; adopt(d, p.rev, p.doc, p.by); }
      });
    }, 60);
  });

  /* ── 在线成员 ───────────────────────────────────────── */
  function renderPresence(online) {
    const box = $('#presence');
    box.innerHTML = '';
    online.forEach((u) => {
      const a = document.createElement('span');
      a.className = 'who' + (u.id === me.id ? ' self' : '');
      a.style.setProperty('--who', u.color || '#4ee0c1');
      a.textContent = [...u.name][0].toUpperCase();
      a.title = u.name + (u.id === me.id ? '（你）' : ' 正在线上');
      box.appendChild(a);
    });
    box.title = `在线 ${online.length} 人`;
  }

  /* ── 撤销栈 ─────────────────────────────────────────── */
  const snap = () => JSON.stringify({ matrix: state.matrix, compare: state.compare });
  function mark() {
    past.push(snap());
    if (past.length > MAX_HISTORY) past.shift();
    future.length = 0;
  }
  function trackable(el, onCommit) {
    let before = null;
    el.addEventListener('focus', () => { before = snap(); });
    el.addEventListener('blur', () => {
      if (before && before !== snap()) { past.push(before); if (past.length > MAX_HISTORY) past.shift(); future.length = 0; }
      before = null;
      onCommit && onCommit();
    });
  }
  function restore(s) {
    const o = JSON.parse(s);
    state.matrix = o.matrix; state.compare = o.compare;
    renderAll(); save('both');
  }
  function undo() {
    document.activeElement?.blur?.();
    if (!past.length) return toast('没有可以撤销的操作了');
    future.push(snap());
    restore(past.pop());
  }
  function redo() {
    document.activeElement?.blur?.();
    if (!future.length) return toast('没有可以重做的操作了');
    past.push(snap());
    restore(future.pop());
  }

  /* ── 编辑模式：默认只读，防误改 ───────────────────────── */
  let editing = false;
  const isEditing = () => editing;

  function setEditing(on) {
    editing = on;
    document.body.classList.toggle('readonly', !on);
    const b = $('#btn-edit');
    b.textContent = on ? '完成编辑' : '开启编辑';
    b.classList.toggle('is-on', on);
    if (!on) {
      document.activeElement?.blur?.();
      Matrix.clearSelection();
      document.querySelector('.tagmenu')?.remove();
    }
    Matrix.render();
    Compare.render();
    localStorage.setItem('wb.editing', on ? '1' : '0');
  }

  /* ── 原图查看 ─────────────────────────────────────────── */
  function lightbox(src, caption) {
    const d = document.createElement('dialog');
    d.className = 'lightbox';
    d.innerHTML = `
      <img src="${src}" alt="">
      <div class="lb-bar">
        <span class="lb-cap"></span>
        <button class="lb-btn" data-act="fit">适应窗口</button>
        <button class="lb-btn" data-act="raw">100% 原图</button>
        <a class="lb-btn" href="${src}" target="_blank" rel="noopener">新标签打开</a>
        <button class="lb-btn lb-close">关闭</button>
      </div>`;
    d.querySelector('.lb-cap').textContent = caption || '';
    const img = d.querySelector('img');

    d.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (act === 'raw') { img.classList.add('raw'); d.classList.add('scrollable'); }
      if (act === 'fit') { img.classList.remove('raw'); d.classList.remove('scrollable'); }
      if (e.target === d || e.target.classList.contains('lb-close')) d.close();
    });
    d.addEventListener('close', () => d.remove());
    img.addEventListener('load', () => {
      const cap = `${img.naturalWidth} × ${img.naturalHeight}`;
      d.querySelector('.lb-cap').textContent = caption ? `${caption} · ${cap}` : cap;
    });
    document.body.appendChild(d);
    d.showModal();   // Esc 关闭、焦点陷阱、遮罩，浏览器全都自带
  }

  /* ── 图片 ───────────────────────────────────────────── */
  function pickImage() {
    return new Promise((resolve) => {
      const input = $('#filepick');
      input.value = '';
      input.onchange = () => resolve(input.files[0] || null);
      input.click();
    });
  }

  /** 仅在需要裁剪比例时才走 canvas。默认不走 —— 原图不重编码。 */
  function processImage(file, { crop = null, max = 1600 } = {}) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let sx = 0, sy = 0, sw = img.width, sh = img.height;
        if (crop) {
          const want = crop[0] / crop[1];
          const have = sw / sh;
          if (have > want) { const w = sh * want; sx = (sw - w) / 2; sw = w; }
          else { const h = sw / want; sy = (sh - h) / 2; sh = h; }
        }
        const scale = Math.min(1, max / Math.max(sw, sh));
        const cw = Math.round(sw * scale), ch = Math.round(sh * scale);
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        const keepAlpha = /png|webp/i.test(file.type);
        if (!keepAlpha) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch); }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
        resolve(c.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.92));
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => reject(new Error('这张图读不出来，换一张试试'));
      img.src = URL.createObjectURL(file);
    });
  }

  /**
   * 原图直传：裸二进制 PUT，不经 canvas、不转 base64。
   * 之前那套 toDataURL(0.92) 必然重编码，字再也清晰不了。
   */
  async function uploadImage() {
    const file = await pickImage();
    if (!file) return null;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('只支持 PNG、JPG、WebP');
    if (file.size > 40 * 1024 * 1024) throw new Error('单张不要超过 40MB');

    toast(`上传中 ${(file.size / 1048576).toFixed(1)} MB…`);
    const r = guard(await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file
    }));
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || '上传失败');
    return j.url;
  }

  /* ── 小工具 ─────────────────────────────────────────── */
  function bindInput(el, obj, key, after, doc) {
    el.value = obj[key] ?? '';
    el.readOnly = !editing;
    el.addEventListener('input', () => { obj[key] = el.value; save(doc); after && after(); });
    trackable(el);
    return el;
  }
  function mkKill(title, fn) {
    const b = document.createElement('button');
    b.className = 'kill'; b.type = 'button'; b.title = title; b.textContent = '×';
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  }

  /* ── 视图 ───────────────────────────────────────────── */
  function moveInk() {
    const a = $('.tab.is-active'), ink = $('.tab-ink');
    ink.style.left = a.offsetLeft + 12 + 'px';
    ink.style.width = a.offsetWidth - 24 + 'px';
  }
  function go(next) {
    view = next;
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === next));
    $$('.view').forEach((v) => (v.hidden = v.dataset.view !== next));
    moveInk();
    location.hash = next;
  }

  function bindTitles() {
    $$('[data-bind]').forEach((el) => {
      const [sec, key] = el.dataset.bind.split('.');
      el.addEventListener('input', () => { state[sec][key] = el.textContent.trim(); save(sec); });
      trackable(el);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    });
  }
  function syncTitles() {
    $$('[data-bind]').forEach((el) => {
      const [sec, key] = el.dataset.bind.split('.');
      const v = state[sec][key] || '';
      if (el.textContent !== v && el !== document.activeElement) el.textContent = v;
    });
  }

  /* ── 图片悬停预览：按原始分辨率呈现，不做 CSS 拉伸 ───── */
  const peek = (() => {
    let box, imgEl, timer = null, current = null;

    function ensure() {
      if (box) return;
      box = document.createElement('div');
      box.className = 'imgpeek';
      box.hidden = true;
      imgEl = document.createElement('img');
      box.appendChild(imgEl);
      document.body.appendChild(box);
      box.addEventListener('mouseenter', () => clearTimeout(timer));
    }

    function place(anchor) {
      const a = anchor.getBoundingClientRect();
      const w = box.offsetWidth, h = box.offsetHeight;
      const pad = 14;
      // 优先放右边，放不下就放左边；垂直居中对齐锚点，超出视口再夹回来
      let left = a.right + pad;
      if (left + w > innerWidth - 8) left = a.left - w - pad;
      if (left < 8) left = Math.max(8, (innerWidth - w) / 2);
      let top = a.top + a.height / 2 - h / 2;
      top = Math.min(Math.max(8, top), innerHeight - h - 8);
      box.style.left = left + 'px';
      box.style.top = top + 'px';
    }

    function show(anchor, src) {
      if (!src) return;
      ensure();
      clearTimeout(timer);
      timer = setTimeout(() => {
        current = src;
        imgEl.onload = () => {
          if (current !== src) return;
          // 用图片的真实像素定尺寸，最多铺到视口的 82%，绝不放大超过原始尺寸
          const maxW = innerWidth * 0.42, maxH = innerHeight * 0.82;
          const k = Math.min(1, maxW / imgEl.naturalWidth, maxH / imgEl.naturalHeight);
          imgEl.style.width = Math.round(imgEl.naturalWidth * k) + 'px';
          imgEl.style.height = 'auto';
          box.hidden = false;
          place(anchor);
          requestAnimationFrame(() => box.classList.add('in'));
        };
        imgEl.src = src;
        if (imgEl.complete && imgEl.naturalWidth) imgEl.onload();
      }, 140);
    }

    function hide() {
      clearTimeout(timer);
      current = null;
      if (box) { box.classList.remove('in'); box.hidden = true; }
    }

    return { show, hide };
  })();

  /* ── 侧栏折叠 ───────────────────────────────────────── */
  function wireRails() {
    const KEY = 'wb.rail.collapsed';
    const apply = (on) => {
      $$('.view').forEach((v) => v.classList.toggle('rail-off', on));
      $$('.rail-toggle').forEach((b) => { b.title = on ? '展开工作台' : '收起工作台，腾出阅读空间'; });
    };
    let on = localStorage.getItem(KEY) === '1';
    apply(on);
    $$('.rail-toggle').forEach((b) => (b.onclick = () => {
      on = !on;
      localStorage.setItem(KEY, on ? '1' : '0');
      apply(on);
      setTimeout(moveInk, 320);
    }));
    document.addEventListener('keydown', (e) => {
      if (e.key === '\\' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('.view:not([hidden]) .rail-toggle')?.click(); }
    });
  }
  function renderAll() { Matrix.render(); Compare.render(); syncTitles(); Compare.syncHeads(); }

  /* ── 顶栏菜单 ───────────────────────────────────────── */
  function wireMenu() {
    const btn = $('#btn-more'), menu = $('#more-menu');
    btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    document.addEventListener('click', () => (menu.hidden = true));
    menu.onclick = (e) => e.stopPropagation();

    menu.querySelectorAll('button').forEach((b) => {
      b.onclick = async () => {
        menu.hidden = true;
        const act = b.dataset.act;

        if (act === 'users') Users.open();
        if (act === 'logs') Admin.openLogs();
        if (act === 'backups') Admin.openBackups();

        if (act === 'export') {
          const blob = new Blob([JSON.stringify({ matrix: state.matrix, compare: state.compare }, null, 1)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `workbench-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          toast('备份已下载');
        }
        if (act === 'import') {
          const inp = $('#jsonpick');
          inp.value = '';
          inp.onchange = async () => {
            const f = inp.files[0]; if (!f) return;
            try {
              const o = JSON.parse(await f.text());
              if (!o.matrix || !o.compare) throw new Error('这个文件里没有 matrix / compare');
              if (!confirm('这会覆盖所有人当前看到的内容。确定吗？')) return;
              mark();
              state.matrix = o.matrix; state.compare = o.compare;
              renderAll(); save('both');
              toast('已从备份恢复。不对劲就按 Ctrl+Z');
            } catch (e) { toast('恢复失败：' + e.message, 'bad'); }
          };
          inp.click();
        }
        if (act === 'print') window.print();
        if (act === 'logout') {
          if (anyDirty() && !confirm('还有改动没同步完，现在退出可能会丢。确定退出吗？')) return;
          await fetch('/api/logout', { method: 'POST' }).catch(() => {});
          DOCS.forEach((d) => (dirty[d] = false));
          location.replace('/login');
        }
        if (act === 'reset') {
          if (!confirm('恢复出厂数据会覆盖所有人当前看到的内容。确定吗？')) return;
          const r = await fetch('/seed.json');
          if (!r.ok) return toast('读不到出厂数据', 'bad');
          const seed = await r.json();
          mark();
          state.matrix = seed.matrix; state.compare = seed.compare;
          renderAll(); save('both');
          toast('已恢复出厂数据');
        }
      };
    });
  }

  /* ── 启动 ───────────────────────────────────────────── */
  async function boot() {
    try {
      const mr = await fetch('/api/me');
      if (mr.status === 401) return location.replace('/login');
      me = await mr.json();
      const s = await (await fetch('/api/state')).json();
      revs = s.revs;
      state.matrix = s.matrix;
      state.compare = s.compare;
      DOCS.forEach((d) => { base[d] = clone(state[d]); dirty[d] = false; });
    } catch {
      flag('error', '离线');
      return toast('连不上服务，页面暂时只读。', 'bad');
    }

    $('#whoami').textContent = me.name;

    Matrix.init(api);
    Compare.init(api);
    Reviews.init(api);
    Users.init(api);
    Admin.init(api);
    bindTitles();
    renderAll();
    wireRails();

    $$('.tab').forEach((t) => (t.onclick = () => go(t.dataset.view)));
    $('#btn-edit').onclick = () => setEditing(!editing);
    setEditing(localStorage.getItem('wb.editing') === '1');
    const hash = location.hash.slice(1);
    go(['compare', 'reviews'].includes(hash) ? hash : 'matrix');
    window.addEventListener('resize', moveInk);

    $('#btn-undo').onclick = undo;
    $('#btn-redo').onclick = redo;
    if (!me.admin) ['reset', 'logs', 'backups'].forEach((a) => $(`[data-act="${a}"]`)?.remove());
    wireMenu();
    connect();

    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
      else if (k === 's') { e.preventDefault(); DOCS.forEach((d) => dirty[d] && flush(d)); }
    });

    window.addEventListener('beforeunload', (e) => { if (anyDirty()) { e.preventDefault(); e.returnValue = ''; } });

    flag('idle', '已同步');
    if (me.defaultPin) setTimeout(() => toast('你还在用默认 PIN 123456，去「⋯ → 用户管理」改一个。', 'bad'), 900);
  }

  const api = {
    get state() { return state; },
    get me() { return me; },
    view: () => view,
    peek, lightbox, isEditing,
    $, $$, uid, clone, toast, save, mark, trackable, bindInput, mkKill, uploadImage, renderAll, guard
  };

  return { boot, ...api };
})();
