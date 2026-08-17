/* ═══════════════════════════════════════════════════════════
   platform-accounts.js — 平台账号（淘宝/天猫登录会话）
   兼管顶栏“素材中心”下拉菜单的开合交互。
   ═══════════════════════════════════════════════════════════ */
const PlatformAccounts = (() => {
  let A, root, pollTimer = null, qrObjectUrl = null;

  const STATUS_LABEL = {
    logged_out: '未登录',
    waiting_for_scan: '等待扫码',
    verifying: '验证中',
    ready: '已登录',
    challenge_required: '需要人工验证',
    expired: '登录已过期',
    unavailable: '暂不可用',
  };
  const STATUS_CLASS = {
    ready: 'mc-row-ok',
    waiting_for_scan: 'mc-row-warn',
    verifying: 'mc-row-warn',
    challenge_required: 'mc-row-warn',
    expired: 'mc-row-warn',
    unavailable: 'mc-row-bad',
  };

  async function call(url, opts = {}) {
    const r = A.guard(await fetch(url, opts));
    if (r.status === 204) return {};
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '操作没成功');
    return j;
  }

  function fmtTime(ms) {
    if (!ms) return '从未';
    return new Date(ms).toLocaleString('zh-CN');
  }

  function revokeQr() {
    if (qrObjectUrl) { URL.revokeObjectURL(qrObjectUrl); qrObjectUrl = null; }
  }

  function accountRow(account) {
    const row = document.createElement('div');
    row.className = 'mc-row ' + (STATUS_CLASS[account.status] || '');

    const name = document.createElement('span');
    name.className = 'mc-row-name';
    name.textContent = account.accountName ? `淘宝/天猫 · ${account.accountName}` : '淘宝/天猫';

    const status = document.createElement('span');
    status.className = 'mc-row-status';
    status.textContent = `${STATUS_LABEL[account.status] || account.status} · 上次验证 ${fmtTime(account.lastVerifiedAt)}`;

    row.append(name, status);

    if (A.me.admin) {
      const acts = document.createElement('div');
      acts.className = 'pa-acts';

      const loginBtn = document.createElement('button');
      loginBtn.className = 'ghost';
      loginBtn.textContent = account.status === 'ready' ? '重新登录' : '开始登录';
      loginBtn.onclick = () => beginLogin(account.accountId, row);

      const clearBtn = document.createElement('button');
      clearBtn.className = 'ghost danger';
      clearBtn.textContent = '清除登录状态';
      clearBtn.disabled = account.status === 'logged_out';
      clearBtn.onclick = async () => {
        if (!confirm('清除后需要重新扫码登录，确定吗？')) return;
        try { await call(`/api/platform-accounts/taobao/${account.accountId}/session`, { method: 'DELETE' }); A.toast('已清除登录状态'); refresh(); }
        catch (e) { A.toast(e.message, 'bad'); }
      };

      acts.append(loginBtn, clearBtn);
      row.appendChild(acts);
    }

    return row;
  }

  async function beginLogin(accountId, row) {
    try {
      await call(`/api/platform-accounts/taobao/${accountId}/login`, { method: 'POST' });
    } catch (e) { A.toast(e.message, 'bad'); return; }
    await refresh();
    await showQr(accountId);
  }

  async function showQr(accountId) {
    let blob;
    try {
      const r = A.guard(await fetch(`/api/platform-accounts/taobao/${accountId}/qr`));
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || '二维码不可用'); }
      blob = await r.blob();
    } catch (e) { A.toast(e.message, 'bad'); return; }
    revokeQr();
    qrObjectUrl = URL.createObjectURL(blob);

    const box = document.createElement('div');
    box.className = 'pa-qr-box';
    const img = document.createElement('img');
    img.className = 'pa-qr-img';
    img.alt = '淘宝登录二维码';
    img.src = qrObjectUrl;
    const hint = document.createElement('p');
    hint.className = 'rail-hint';
    hint.textContent = '用手机淘宝/天猫扫码后，点击下面的按钮确认。';
    const verifyBtn = document.createElement('button');
    verifyBtn.className = 'solid';
    verifyBtn.textContent = '我已扫码，去验证';
    verifyBtn.onclick = async () => {
      try { await call(`/api/platform-accounts/taobao/${accountId}/verify`, { method: 'POST' }); A.toast('验证完成'); box.remove(); revokeQr(); refresh(); }
      catch (e) { A.toast(e.message, 'bad'); }
    };
    box.append(img, hint, verifyBtn);
    root.querySelector('#pa-qr-slot').replaceChildren(box);
  }

  async function refresh() {
    let accounts;
    try { ({ accounts } = await call('/api/platform-accounts')); }
    catch (e) { A.toast(e.message, 'bad'); return; }
    const list = root.querySelector('#pa-list');
    list.replaceChildren(...accounts.map(accountRow));
  }

  function mount() {
    root = A.$('#pa-scroll');
    root.innerHTML = `
      <div id="pa-list"></div>
      <div id="pa-qr-slot"></div>`;
  }

  function onShow() {
    if (!root) mount();
    refresh();
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (A.view() === 'platform-accounts') refresh(); else clearInterval(pollTimer); }, 4000);
  }

  /* ── 顶栏“素材中心”下拉：hover/focus/click 打开，Escape/外部点击/延迟离开关闭 ── */
  function wireMenu() {
    const group = A.$('#mc-group'), trigger = A.$('#mc-trigger'), submenu = A.$('#mc-submenu');
    if (!group || !trigger || !submenu) return;
    let closeTimer = null;

    const open = () => { clearTimeout(closeTimer); submenu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); };
    const close = () => { submenu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
    const scheduleClose = () => { clearTimeout(closeTimer); closeTimer = setTimeout(close, 260); };

    group.addEventListener('pointerenter', open);
    group.addEventListener('pointerleave', scheduleClose);
    trigger.addEventListener('focus', open);
    trigger.addEventListener('click', open);
    submenu.querySelectorAll('.tab-submenu-item').forEach((item) => {
      item.addEventListener('click', close);
      item.addEventListener('focus', () => clearTimeout(closeTimer));
    });
    group.addEventListener('focusout', (e) => { if (!group.contains(e.relatedTarget)) scheduleClose(); });
    document.addEventListener('click', (e) => { if (!submenu.hidden && !group.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || submenu.hidden) return;
      close();
      trigger.focus();
    });
    // roving focus：左右方向键在触发按钮和两个子项之间移动
    const roving = [trigger, ...submenu.querySelectorAll('.tab-submenu-item')];
    roving.forEach((el, i) => {
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        open();
        const next = roving[(i + (e.key === 'ArrowRight' ? 1 : -1) + roving.length) % roving.length];
        next.focus();
      });
    });
  }

  function init(api) { A = api; wireMenu(); }

  function onEvent() { /* 平台账号页目前没有独立 SSE 频道，靠轮询刷新即可 */ }

  return { init, onShow, onEvent };
})();
