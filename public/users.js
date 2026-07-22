/* ═══════════════════════════════════════════════════════════
   users.js — 用户管理（管理员管所有人，普通成员改自己的 PIN）
   ═══════════════════════════════════════════════════════════ */
const Users = (() => {
  let A, box, list;

  const pinOk = (v) => /^\d{6}$/.test(v);

  async function call(url, opts = {}) {
    const r = A.guard(await fetch(url, {
      headers: { 'Content-Type': 'application/json' }, ...opts
    }));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '操作没成功');
    return j;
  }

  function pinField(placeholder) {
    const i = document.createElement('input');
    i.type = 'password';
    i.inputMode = 'numeric';
    i.autocomplete = 'off';
    i.maxLength = 6;
    i.placeholder = placeholder;
    i.className = 'pin';
    i.addEventListener('input', () => (i.value = i.value.replace(/\D/g, '').slice(0, 6)));
    return i;
  }

  function row(u) {
    const el = document.createElement('div');
    el.className = 'urow';

    const av = document.createElement('span');
    av.className = 'who';
    av.style.setProperty('--who', u.color || '#4ee0c1');
    av.textContent = [...u.name][0].toUpperCase();

    const meta = document.createElement('div');
    meta.className = 'umeta';
    const nm = document.createElement('b');
    nm.textContent = u.name + (u.id === A.me.id ? '（你）' : '');
    const tag = document.createElement('span');
    tag.textContent = u.admin ? '管理员' : '成员';
    if (u.defaultPin) tag.textContent += ' · 仍是默认 PIN';
    meta.append(nm, tag);

    const acts = document.createElement('div');
    acts.className = 'uacts';

    const canEditPin = A.me.admin || u.id === A.me.id;
    if (canEditPin) {
      const p = pinField('新 PIN');
      const ok = document.createElement('button');
      ok.className = 'ghost';
      ok.textContent = '改 PIN';
      ok.onclick = async () => {
        if (!pinOk(p.value)) return A.toast('PIN 必须是 6 位数字', 'bad');
        try {
          await call('/api/users/' + u.id, { method: 'PATCH', body: JSON.stringify({ pin: p.value }) });
          p.value = '';
          A.toast(u.id === A.me.id ? 'PIN 已改，下次登录用新的' : `已重置 ${u.name} 的 PIN`);
          refresh();
        } catch (e) { A.toast(e.message, 'bad'); }
      };
      acts.append(p, ok);
    }

    if (A.me.admin && u.id !== A.me.id) {
      acts.appendChild(A.mkKill('删除这个用户', async () => {
        if (!confirm(`删除用户「${u.name}」？他的登录会立刻失效。`)) return;
        try { await call('/api/users/' + u.id, { method: 'DELETE' }); A.toast('已删除'); refresh(); }
        catch (e) { A.toast(e.message, 'bad'); }
      }));
    }

    el.append(av, meta, acts);
    return el;
  }

  async function refresh() {
    list.innerHTML = '<p class="rail-hint">读取中…</p>';
    try {
      const users = await call('/api/users');
      list.innerHTML = '';
      users.forEach((u) => list.appendChild(row(u)));
    } catch (e) {
      list.innerHTML = '';
      A.toast(e.message, 'bad');
    }
  }

  function build() {
    box = document.createElement('div');
    box.className = 'sheet-mask';
    box.hidden = true;
    box.innerHTML = `
      <div class="sheet" role="dialog" aria-label="用户管理">
        <div class="sheet-head">
          <h2>用户管理</h2>
          <button class="kill" id="u-close" title="关闭">×</button>
        </div>
        <div class="sheet-body">
          <div id="u-list"></div>
          <div id="u-add"></div>
        </div>
      </div>`;
    document.body.appendChild(box);
    list = box.querySelector('#u-list');

    box.querySelector('#u-close').onclick = close;
    box.onclick = (e) => { if (e.target === box) close(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) close(); });

    if (A.me.admin) {
      const add = box.querySelector('#u-add');
      add.className = 'uadd';
      const name = document.createElement('input');
      name.placeholder = '用户名';
      name.spellcheck = false;
      const pin = pinField('6 位数字 PIN');
      const btn = document.createElement('button');
      btn.className = 'solid';
      btn.textContent = '添加成员';
      btn.onclick = async () => {
        if (!name.value.trim()) return A.toast('用户名不能为空', 'bad');
        if (!pinOk(pin.value)) return A.toast('PIN 必须是 6 位数字', 'bad');
        try {
          await call('/api/users', { method: 'POST', body: JSON.stringify({ name: name.value.trim(), pin: pin.value }) });
          name.value = ''; pin.value = '';
          A.toast('成员已添加');
          refresh();
        } catch (e) { A.toast(e.message, 'bad'); }
      };
      const t = document.createElement('div');
      t.className = 'rail-sec';
      t.textContent = '添加成员';
      add.append(t, name, pin, btn);
    }
  }

  function open() { if (!box) build(); box.hidden = false; refresh(); }
  function close() { box.hidden = true; }

  function init(api) { A = api; }

  return { init, open };
})();
