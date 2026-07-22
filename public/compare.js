/* ═══════════════════════════════════════════════════════════
   compare.js — 竞品对位表
   注意：所有 handler 里都必须现取 C()，不能在 init 里把
   state.compare 抓成局部变量 —— 协同合并会换掉整个对象。
   ═══════════════════════════════════════════════════════════ */
const Compare = (() => {
  let A;
  const C = () => A.state.compare;
  const MARKS = ['none', 'good', 'bad'];
  const EN = () => C().lang === 'en';

  const cols = () => `170px repeat(${C().brands.length}, minmax(196px, 1fr))`;
  const emptyCell = () => ({ lines: [{ v: '', s: '', mark: 'none', ev: '', es: '', stale: false }] });

  /* ── 双语字段：中文改了就把英文标记成待更新 ──────────── */
  function langPair(obj, zhKey, enKey) {
    return EN() ? { key: enKey, stale: obj.stale && !!obj[enKey] } : { key: zhKey, stale: false };
  }

  /** 绑一个双语输入框。中文模式写 zhKey，英文模式写 enKey。 */
  function bindI18n(el, obj, zhKey, enKey, after) {
    const en = EN();
    const key = en ? enKey : zhKey;
    el.value = obj[key] ?? '';
    el.readOnly = !A.isEditing();

    const missing = en && !!obj[zhKey] && !obj[key];
    const stale = en && !!obj[key] && obj.stale === true;
    if (missing) el.classList.add('need-en');
    if (stale) el.classList.add('stale-en');
    if (missing) el.placeholder = '待更新英文信息';

    el.addEventListener('input', () => {
      obj[key] = el.value;
      if (en) {
        obj.stale = false;                 // 手动改过英文 → 不再是过期的
        el.classList.remove('stale-en');
        if (el.value) el.classList.remove('need-en');
      } else if (obj[enKey]) {
        obj.stale = true;                  // 中文变了，英文就过期了
      }
      A.save('compare');
      after && after();
    });
    A.trackable(el);
    return el;
  }

  /* ── 图片：悬停出大图，不靠 CSS 放大，所以不糊；一直开着，不再需要开关 ── */
  function imgSlot(brand, kind) {
    const conf = {
      logo:    { cls: 'logo-slot', ph: '＋ LOGO',        label: 'Logo' },
      image:   { cls: 'pic-slot',  ph: '产品图\n1:1',    label: '1:1 产品图' },
      image34: { cls: 'pic-slot pic34', ph: '素材\n3:4', label: '3:4 素材' }
    }[kind];

    const box = document.createElement('div');
    box.className = 'slot-box';

    const el = document.createElement('div');
    el.className = conf.cls;

    const paint = () => {
      el.innerHTML = '';
      box.querySelector('.slot-acts')?.remove();

      if (brand[kind]) {
        const img = document.createElement('img');
        img.src = brand[kind];
        img.alt = `${brand.name} ${conf.label}`;
        img.loading = 'lazy';
        el.appendChild(img);
        el.title = '点击查看 100% 原图';
        // 点图 = 看原图。上传动作挪到下面的独立入口，避免手滑覆盖素材。
        el.onclick = () => A.lightbox(brand[kind], `${brand.name} · ${conf.label}`);
      } else {
        const ph = document.createElement('div');
        ph.className = 'ph';
        ph.style.whiteSpace = 'pre-line';
        ph.textContent = conf.ph;
        el.appendChild(ph);
        el.title = A.isEditing() ? '点击上传' : '还没有素材';
        el.onclick = A.isEditing() ? doUpload : null;
      }

      if (A.isEditing()) {
        const acts = document.createElement('div');
        acts.className = 'slot-acts';
        const up = document.createElement('button');
        up.className = 'slot-act';
        up.textContent = brand[kind] ? '⟳ 更换' : '↑ 上传';
        up.onclick = doUpload;
        acts.appendChild(up);
        if (brand[kind]) {
          const rm = document.createElement('button');
          rm.className = 'slot-act danger';
          rm.textContent = '移除';
          rm.onclick = () => { A.mark(); brand[kind] = ''; A.save('compare'); paint(); };
          acts.appendChild(rm);
        }
        box.appendChild(acts);
      }
    };

    async function doUpload(e) {
      e?.stopPropagation();
      try {
        const url = await A.uploadImage();
        if (!url) return;
        A.mark();
        brand[kind] = url;
        A.save('compare'); paint();
        A.toast('素材已更新，点图看原图');
      } catch (err) { A.toast(err.message, 'bad'); }
    }

    // 悬停仍给一个小预览，方便快速扫一眼；要看清字就点开原图
    el.addEventListener('mouseenter', () => { if (brand[kind]) A.peek.show(el, brand[kind]); });
    el.addEventListener('mouseleave', () => A.peek.hide());

    paint();
    box.appendChild(el);
    return box;
  }

  /* ── 品牌表头 ───────────────────────────────────────── */
  function brandHead(b) {
    const isOwn = b.id === C().ownBrandId;
    const card = document.createElement('div');
    card.className = 'cmp-brand' + (isOwn ? ' is-own' : '');
    card.title = isOwn ? '当前的我方品牌' : '点击设为我方品牌';
    // 点这一列空白处（不是输入框/图片/按钮）就把它设为我方品牌，
    // 不分是否在编辑模式——原来的下拉框也是随时可选，不受编辑态限制。
    card.addEventListener('click', (e) => {
      if (e.target.closest('input, button, .slot-box')) return;
      const c = C();
      if (c.ownBrandId === b.id) return;
      A.mark();
      c.ownBrandId = b.id;
      A.save('compare'); render();
    });

    const name = document.createElement('input');
    name.className = 'bname'; name.spellcheck = false;
    A.bindInput(name, b, 'name', null, 'compare');

    const model = document.createElement('input');
    model.className = 'bmodel'; model.spellcheck = false; model.placeholder = '型号';
    A.bindInput(model, b, 'model', null, 'compare');

    const shelf = document.createElement('div');
    shelf.className = 'pic-shelf';
    shelf.append(imgSlot(b, 'image'), imgSlot(b, 'image34'));

    card.append(
      imgSlot(b, 'logo'), name, model, shelf,
      A.mkKill('删除这个品牌列', () => {
        const c = C();
        if (c.brands.length <= 1) return A.toast('至少保留一个品牌列');
        if (!confirm(`删除「${b.name}」这一列？`)) return;
        A.mark();
        c.brands = c.brands.filter((x) => x.id !== b.id);
        c.groups.forEach((g) => g.rows.forEach((r) => delete r.cells[b.id]));
        if (c.ownBrandId === b.id) c.ownBrandId = c.brands[0]?.id || '';
        A.save('compare'); render();
      })
    );
    return card;
  }

  /* ── 单元格里的一行数值 ─────────────────────────────── */
  function lineEl(cell, line, idx) {
    const el = document.createElement('div');
    const paintMark = () => (el.className = 'line' + (line.mark !== 'none' ? ' ' + line.mark : ''));
    paintMark();

    const dot = document.createElement('button');
    dot.className = 'markdot';
    dot.title = '切换：中性 → 优势(蓝) → 劣势(红)';
    dot.onclick = () => {
      if (!A.isEditing()) return A.toast('先点右上角「开启编辑」');
      A.mark();
      line.mark = MARKS[(MARKS.indexOf(line.mark) + 1) % 3];
      A.save('compare'); paintMark();
    };

    const body = document.createElement('div');
    body.className = 'line-body';

    const v = document.createElement('input');
    v.className = 'v'; v.placeholder = '—'; v.spellcheck = false;
    bindI18n(v, line, 'v', 'ev');

    const s = document.createElement('input');
    s.className = 's'; s.placeholder = '注释（可留空）'; s.spellcheck = false;
    bindI18n(s, line, 's', 'es');

    body.append(v, s);

    const rm = document.createElement('button');
    rm.className = 'rmline'; rm.textContent = '×'; rm.title = '删除这一行数值';
    rm.onclick = () => {
      if (cell.lines.length <= 1) return A.toast('每个格子至少留一行，清空文字即可');
      A.mark(); cell.lines.splice(idx, 1); A.save('compare'); render();
    };

    el.append(dot, body, rm);
    return el;
  }

  /* ── 数据行 ─────────────────────────────────────────── */
  function dataRow(group, row) {
    const c = C();
    const tr = document.createElement('div');
    tr.className = 'cmp-row cmp-datarow';
    tr.style.gridTemplateColumns = cols();

    const lab = document.createElement('div');
    lab.className = 'cmp-label';
    const li = document.createElement('input');
    li.spellcheck = false;
    bindI18n(li, row, 'label', 'label_en');
    lab.append(li, A.mkKill('删除这一行', () => {
      A.mark();
      group.rows = group.rows.filter((x) => x.id !== row.id);
      A.save('compare'); render();
    }));
    tr.appendChild(lab);

    c.brands.forEach((b) => {
      if (!row.cells[b.id]) row.cells[b.id] = emptyCell();
      const cell = row.cells[b.id];
      const td = document.createElement('div');
      td.className = 'cmp-cell' + (b.id === c.ownBrandId ? ' own-col' : '');

      cell.lines.forEach((ln, i) => td.appendChild(lineEl(cell, ln, i)));

      const add = document.createElement('button');
      add.className = 'addline';
      add.textContent = '+ 数值';
      add.onclick = () => {
        A.mark();
        cell.lines.push({ v: '', s: '', mark: 'none', ev: '', es: '', stale: false });
        A.save('compare'); render();
      };
      td.appendChild(add);
      tr.appendChild(td);
    });
    return tr;
  }

  /* ── 主渲染 ─────────────────────────────────────────── */
  function render() {
    const root = A.$('#compare');
    const c = C();
    const editing = A.isEditing();
    root.innerHTML = '';
    root.classList.toggle('en-mode', EN());

    const headWrap = document.createElement('div');
    headWrap.className = 'cmp-head-wrap';
    const head = document.createElement('div');
    head.className = 'cmp-row cmp-headrow';
    head.style.gridTemplateColumns = cols();
    head.appendChild(document.createElement('div'));
    c.brands.forEach((b) => head.appendChild(brandHead(b)));
    headWrap.appendChild(head);
    if (editing) {
      const addBrand = document.createElement('button');
      addBrand.type = 'button';
      addBrand.className = 'cmp-add-brand';
      addBrand.title = '新增品牌列';
      addBrand.textContent = '+';
      addBrand.onclick = () => {
        A.mark();
        const b = { id: A.uid('c_'), name: '新品牌', model: '型号', logo: '', image: '', image34: '' };
        c.brands.push(b);
        c.groups.forEach((g) => g.rows.forEach((r) => (r.cells[b.id] = emptyCell())));
        A.save('compare'); render();
        A.$$('.cmp-brand .bname').pop()?.select();
      };
      headWrap.appendChild(addBrand);
    }
    root.appendChild(headWrap);

    c.groups.forEach((g) => {
      const card = document.createElement('div');
      card.className = 'cmp-group';

      const title = document.createElement('div');
      title.className = 'cmp-group-title';
      const gi = document.createElement('input');
      gi.spellcheck = false;
      const fit = () => (gi.size = Math.max(8, (gi.value || '').length + 2));
      bindI18n(gi, g, 'name', 'name_en', fit);
      fit();

      const addRow = document.createElement('button');
      addRow.className = 'addrow';
      addRow.textContent = '+ 参数行';
      addRow.onclick = () => {
        A.mark();
        const cells = {};
        C().brands.forEach((b) => (cells[b.id] = emptyCell()));
        g.rows.push({ id: A.uid('r_'), label: '新参数', label_en: '', cells });
        A.save('compare'); render();
      };

      title.append(gi, addRow, A.mkKill('删除整个分组', () => {
        if (!confirm(`删除分组「${g.name}」和它下面的所有行？`)) return;
        A.mark();
        C().groups = C().groups.filter((x) => x.id !== g.id);
        A.save('compare'); render();
      }));
      card.appendChild(title);

      g.rows.forEach((r) => card.appendChild(dataRow(g, r)));
      root.appendChild(card);
    });

    if (editing) {
      const addGroup = document.createElement('button');
      addGroup.type = 'button';
      addGroup.className = 'cmp-add-group';
      addGroup.textContent = '+ 新增参数分组';
      addGroup.onclick = () => {
        A.mark();
        const cells = {};
        C().brands.forEach((b) => (cells[b.id] = emptyCell()));
        C().groups.push({ id: A.uid('g_'), name: '新分组', name_en: '', rows: [{ id: A.uid('r_'), label: '新参数', label_en: '', cells }] });
        A.save('compare'); render();
        A.$$('.cmp-group-title input').pop()?.select();
      };
      root.appendChild(addGroup);
    }

    syncLangUI();
    countStale();
  }

  function syncLangUI() {
    A.$$('#lang-switch button').forEach((b) => b.classList.toggle('on', b.dataset.lang === C().lang));
    A.$('#compare-canvas').classList.toggle('en-mode', EN());
  }

  /** 数一数还有多少英文没跟上，显示在侧栏 */
  function countStale() {
    const c = C();
    let missing = 0, stale = 0;
    const chk = (o, zh, en) => {
      if (o[zh] && !o[en]) missing++;
      else if (o[en] && o.stale) stale++;
    };
    c.groups.forEach((g) => {
      chk(g, 'name', 'name_en');
      g.rows.forEach((r) => {
        chk(r, 'label', 'label_en');
        Object.values(r.cells).forEach((cell) => cell.lines.forEach((ln) => { chk(ln, 'v', 'ev'); chk(ln, 's', 'es'); }));
      });
    });
    const box = A.$('#en-status');
    if (!box) return;
    if (!missing && !stale) { box.className = 'en-status ok'; box.textContent = '英文内容已全部跟上'; return; }
    box.className = 'en-status warn';
    box.textContent = `${missing ? `${missing} 处缺英文` : ''}${missing && stale ? '，' : ''}${stale ? `${stale} 处待更新` : ''}`;
  }

  /* ── 标题（双语，contenteditable）───────────────────── */
  function bindHeads() {
    const h = A.$('#compare-canvas h1'), p = A.$('#compare-canvas p');
    [[h, 'title', 'title_en'], [p, 'subtitle', 'subtitle_en']].forEach(([el, zh, en]) => {
      el.addEventListener('input', () => {
        const c = C();
        c[EN() ? en : zh] = el.textContent.trim();
        A.save('compare');
      });
      A.trackable(el);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    });
  }

  function syncHeads() {
    const c = C();
    const h = A.$('#compare-canvas h1'), p = A.$('#compare-canvas p');
    const set = (el, val, fallbackHint) => {
      if (el === document.activeElement) return;
      el.textContent = val || '';
      el.classList.toggle('need-en', EN() && !val);
      el.dataset.hint = EN() && !val ? '待更新英文信息' : '';
    };
    set(h, EN() ? c.title_en : c.title);
    set(p, EN() ? c.subtitle_en : c.subtitle);
  }

  function setLang(lang) {
    const c = C();
    if (c.lang === lang) return;
    c.lang = lang;
    A.save('compare');
    render();
    syncHeads();
  }

  /* ── 初始化 ─────────────────────────────────────────── */
  function init(api) {
    A = api;

    A.$$('#lang-switch button').forEach((b) => (b.onclick = () => setLang(b.dataset.lang)));
    A.wireInfoPanel('#cmp-info-wrap', '#cmp-info-btn', '#cmp-info-panel');

    bindHeads();
  }

  return { init, render, syncHeads };
})();
