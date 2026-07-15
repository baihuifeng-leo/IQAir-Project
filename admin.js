/* ═══════════════════════════════════════════════════════════
   admin.js — 变更日志 / 备份与恢复（仅管理员可见）
   ═══════════════════════════════════════════════════════════ */
const Admin = (() => {
  let A, mask, title, bodyEl;

  const ACTION = {
    login: ['登录', 'act-login'],
    'doc.save': ['编辑', 'act-edit'],
    'user.create': ['加人', 'act-user'],
    'user.update': ['改用户', 'act-user'],
    'user.delete': ['删人', 'act-danger'],
    upload: ['上传', 'act-edit'],
    'backup.manual': ['手动备份', 'act-backup'],
    'backup.auto': ['自动备份', 'act-backup'],
    'backup.restore': ['恢复备份', 'act-danger']
  };

  const DOCNAME = { matrix: '价格带沙盘', compare: '竞品对位' };

  async function call(url, opts = {}) {
    const r = A.guard(await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '请求失败');
    return j;
  }

  function when(iso) {
    const d = new Date(iso);
    const diff = (Date.now() - d) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function build() {
    mask = document.createElement('div');
    mask.className = 'sheet-mask';
    mask.hidden = true;
    mask.innerHTML = `
      <div class="sheet sheet-wide" role="dialog">
        <div class="sheet-head">
          <h2 id="adm-title"></h2>
          <button class="kill" id="adm-close" title="关闭">×</button>
        </div>
        <div class="sheet-body" id="adm-body"></div>
      </div>`;
    document.body.appendChild(mask);
    title = mask.querySelector('#adm-title');
    bodyEl = mask.querySelector('#adm-body');
    mask.querySelector('#adm-close').onclick = close;
    mask.onclick = (e) => { if (e.target === mask) close(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mask.hidden) close(); });
  }

  const close = () => (mask.hidden = true);
  function open(t) { if (!mask) build(); title.textContent = t; mask.hidden = false; }

  /* ── 变更日志 ───────────────────────────────────────── */
  async function openLogs() {
    open('变更日志');
    bodyEl.innerHTML = '<p class="rail-hint">读取中…</p>';
    let rows;
    try { rows = await call('/api/logs?limit=400'); }
    catch (e) { bodyEl.innerHTML = ''; return A.toast(e.message, 'bad'); }

    bodyEl.innerHTML = '';
    const bar = document.createElement('div');
    bar.className = 'log-filter';
    const q = document.createElement('input');
    q.placeholder = '按用户名或内容过滤…';
    q.spellcheck = false;
    bar.appendChild(q);
    bodyEl.appendChild(bar);

    const list = document.createElement('div');
    list.className = 'log-list';
    bodyEl.appendChild(list);

    const draw = (filter = '') => {
      list.innerHTML = '';
      const f = filter.trim().toLowerCase();
      const shown = rows.filter((r) => !f || JSON.stringify(r).toLowerCase().includes(f));
      if (!shown.length) { list.innerHTML = '<p class="rail-hint">没有匹配的记录。</p>'; return; }

      shown.forEach((r) => {
        const [label, cls] = ACTION[r.action] || [r.action, ''];
        const el = document.createElement('div');
        el.className = 'log-row';

        const badge = `<span class="log-act ${cls}">${label}</span>`;
        const doc = r.doc ? `<span class="log-doc">${DOCNAME[r.doc] || r.doc}</span>` : '';
        const merged = r.merged ? '<span class="log-doc">合并</span>' : '';

        el.innerHTML = `
          <div class="log-top">
            <b>${r.u}</b>${badge}${doc}${merged}
            <time title="${new Date(r.t).toLocaleString('zh-CN')}">${when(r.t)}</time>
          </div>`;

        if (r.detail?.length) {
          const ul = document.createElement('ul');
          ul.className = 'log-detail';
          const items = r.detail.slice(0, 6);
          items.forEach((d) => {
            const li = document.createElement('li');
            li.textContent = d;
            ul.appendChild(li);
          });
          if (r.detail.length > 6) {
            const li = document.createElement('li');
            li.className = 'more';
            li.textContent = `…另有 ${r.detail.length - 6} 处改动`;
            ul.appendChild(li);
          }
          el.appendChild(ul);
        }
        list.appendChild(el);
      });
    };

    draw();
    q.addEventListener('input', () => draw(q.value));
  }

  /* ── 备份与恢复 ─────────────────────────────────────── */
  async function openBackups() {
    open('备份与恢复');
    bodyEl.innerHTML = '<p class="rail-hint">读取中…</p>';
    let rows;
    try { rows = await call('/api/backups'); }
    catch (e) { bodyEl.innerHTML = ''; return A.toast(e.message, 'bad'); }

    bodyEl.innerHTML = '';
    const hint = document.createElement('p');
    hint.className = 'rail-hint';
    hint.textContent = '每天 00:00 自动备份一次，最多保留 30 份。恢复会覆盖所有人当前看到的内容，但恢复前会先把现状另存一份，随时能退回来。';
    bodyEl.appendChild(hint);

    const now = document.createElement('button');
    now.className = 'solid';
    now.textContent = '立刻备份一次';
    now.onclick = async () => {
      try { const j = await call('/api/snapshot', { method: 'POST' }); A.toast('已备份：' + j.file); openBackups(); }
      catch (e) { A.toast(e.message, 'bad'); }
    };
    bodyEl.appendChild(now);

    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'rail-hint';
      p.style.marginTop = '16px';
      p.textContent = '还没有任何备份。今晚 00:00 会自动生成第一份。';
      bodyEl.appendChild(p);
      return;
    }

    const list = document.createElement('div');
    list.className = 'bk-list';
    rows.forEach((b) => {
      const el = document.createElement('div');
      el.className = 'bk-row';
      const kind = b.file.includes('before-restore') ? '恢复前存档' : b.file.includes('manual') ? '手动' : '每日自动';
      el.innerHTML = `
        <div class="bk-meta">
          <b>${new Date(b.time).toLocaleString('zh-CN')}</b>
          <span>${kind} · ${(b.size / 1024).toFixed(0)} KB</span>
        </div>`;
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = '恢复到这里';
      btn.onclick = async () => {
        if (!confirm(`把所有人的数据恢复到 ${new Date(b.time).toLocaleString('zh-CN')} 的状态？\n\n恢复前会自动把现状另存一份。`)) return;
        try {
          const j = await call('/api/backups/restore', { method: 'POST', body: JSON.stringify({ file: b.file }) });
          A.toast('已恢复。现状已另存为 ' + j.safety);
          close();
        } catch (e) { A.toast(e.message, 'bad'); }
      };
      el.appendChild(btn);
      list.appendChild(el);
    });
    bodyEl.appendChild(list);
  }

  function init(api) { A = api; }

  return { init, openLogs, openBackups };
})();
