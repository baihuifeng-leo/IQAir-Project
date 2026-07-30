/* ═══════════════════════════════════════════════════════════
   settings.js — 个人功能显示设置

   跟"编辑模式"那种全局开关不同，这里是每个用户自己的偏好：
   关掉某个模块只影响自己顶栏看到的标签页，不影响其他人、不删数据，
   服务端按用户存（users.json 里每个人的 hiddenModules 字段），
   换设备登录也是同一套设置。
   ═══════════════════════════════════════════════════════════ */
const Settings = (() => {
  let A, box;

  const MODULES = [
    { key: 'matrix', label: '价格带沙盘' },
    { key: 'compare', label: '竞品对位' },
    { key: 'reviews', label: '评论风向标' },
    { key: 'preview3d', label: '竞品3D预览' },
    { key: 'reports', label: '报告管理' },
    { key: 'materialcheck', label: '素材质检' }
  ];

  async function call(url, opts = {}) {
    const r = A.guard(await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '操作没成功');
    return j;
  }

  function build() {
    box = document.createElement('div');
    box.className = 'sheet-mask';
    box.hidden = true;
    box.innerHTML = `
      <div class="sheet" role="dialog" aria-label="功能显示设置">
        <div class="sheet-head">
          <h2>功能显示设置</h2>
          <button class="kill" id="st-close" title="关闭">×</button>
        </div>
        <div class="sheet-body">
          <p class="rail-hint">关掉的模块不会出现在顶部标签栏——只影响你自己看到的界面，不影响其他人，也不会删除任何数据，随时可以再打开。</p>
          <div id="st-list" class="st-list"></div>
        </div>
      </div>`;
    document.body.appendChild(box);

    box.querySelector('#st-close').onclick = close;
    box.onclick = (e) => { if (e.target === box) close(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) close(); });

    const list = box.querySelector('#st-list');
    MODULES.forEach((m) => {
      const row = document.createElement('label');
      row.className = 'st-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !(A.me.hiddenModules || []).includes(m.key);
      cb.onchange = () => toggle(m.key, cb);
      const span = document.createElement('span');
      span.textContent = m.label;
      row.append(cb, span);
      list.appendChild(row);
    });
  }

  /** 勾选即生效，不用额外点保存——跟别的偏好类开关（比如编辑模式）体验一致 */
  async function toggle(key, cb) {
    const current = new Set(A.me.hiddenModules || []);
    if (cb.checked) current.delete(key); else current.add(key);

    if (current.size >= MODULES.length) {
      A.toast('至少要留一个模块显示', 'bad');
      cb.checked = true;
      return;
    }

    const next = [...current];
    try {
      await call('/api/users/' + A.me.id, { method: 'PATCH', body: JSON.stringify({ hiddenModules: next }) });
      A.me.hiddenModules = next;
      A.refreshModuleVisibility();
    } catch (e) {
      A.toast(e.message, 'bad');
      cb.checked = !cb.checked; // 请求失败，把勾选状态退回去
    }
  }

  function open() { if (!box) build(); box.hidden = false; }
  function close() { box.hidden = true; }

  function init(api) { A = api; }

  return { init, open };
})();
