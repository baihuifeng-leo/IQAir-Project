/* ═══════════════════════════════════════════════════════════
   matrix.js — 品牌 × 价格带 沙盘
   支持鼠标框选、Ctrl 加选、整批拖拽 / 改分类 / 删除。
   ═══════════════════════════════════════════════════════════ */
const Matrix = (() => {
  let A;
  let dragId = null;
  const sel = new Set();          // 选中的产品 id

  const M = () => A.state.matrix;
  const colorOf = (tag) => (tag === 'default' || !M().tags[tag] ? M().defaultColor : M().tags[tag].color);

  /* ── 选区 ───────────────────────────────────────────── */
  function setSel(ids) { sel.clear(); ids.forEach((i) => sel.add(i)); paintSel(); }
  function clearSel() { sel.clear(); paintSel(); }
  function paintSel() {
    A.$$('.chip').forEach((el) => el.classList.toggle('sel', sel.has(el.dataset.id)));
    const bar = A.$('#batchbar');
    bar.hidden = sel.size === 0;
    if (sel.size) A.$('#batch-count').textContent = sel.size;
  }

  /* ── 产品卡片 ───────────────────────────────────────── */
  function chip(p) {
    const el = document.createElement('div');
    el.className = 'chip' + (p.italic ? ' i' : '') + (p.underline ? ' u' : '') + (sel.has(p.id) ? ' sel' : '');
    el.style.setProperty('--chip', colorOf(p.tag));
    el.draggable = A.isEditing();
    el.dataset.id = p.id;

    const name = document.createElement('input');
    name.className = 'n'; name.placeholder = '产品名';
    A.bindInput(name, p, 'name', null, 'matrix');

    const price = document.createElement('input');
    price.className = 'p'; price.placeholder = '¥ —';
    A.bindInput(price, p, 'price', null, 'matrix');

    [name, price].forEach((i) => {
      i.addEventListener('mousedown', (e) => { e.stopPropagation(); el.draggable = false; });
      i.addEventListener('blur', () => (el.draggable = A.isEditing()));
    });

    el.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault(); e.stopPropagation();
        sel.has(p.id) ? sel.delete(p.id) : sel.add(p.id);
        paintSel();
      } else if (!sel.has(p.id)) {
        clearSel(); // 拖一个没选中的 → 先清掉旧选区
      }
    });

    const tools = document.createElement('div');
    tools.className = 'chip-tools';

    const dot = document.createElement('button');
    dot.className = 'dot'; dot.title = '选择分类';
    dot.onclick = (e) => { e.stopPropagation(); openTagMenu(e.currentTarget, [p.id]); };

    const it = document.createElement('button');
    it.textContent = 'I'; it.title = '斜体'; it.style.fontStyle = 'italic';
    it.onclick = () => { A.mark(); p.italic = !p.italic; A.save('matrix'); render(); };

    const un = document.createElement('button');
    un.textContent = 'U'; un.title = '下划线'; un.style.textDecoration = 'underline';
    un.onclick = () => { A.mark(); p.underline = !p.underline; A.save('matrix'); render(); };

    const rm = document.createElement('button');
    rm.textContent = '×'; rm.title = '删除这个产品';
    rm.onclick = () => {
      A.mark();
      M().products = M().products.filter((x) => x.id !== p.id);
      sel.delete(p.id);
      A.save('matrix'); render();
    };

    tools.append(dot, it, un, rm);

    el.addEventListener('dragstart', (e) => {
      if (!sel.has(p.id)) clearSel();
      dragId = p.id;
      el.classList.add('dragging');
      if (sel.size > 1) A.$$('.chip.sel').forEach((c) => c.classList.add('dragging'));
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.id);
    });
    el.addEventListener('dragend', () => {
      dragId = null;
      A.$$('.chip.dragging').forEach((c) => c.classList.remove('dragging'));
    });

    el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
    el.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      const id = dragId || e.dataTransfer.getData('text/plain');
      if (!id || id === p.id) return;
      const rect = el.getBoundingClientRect();
      moveMany(idsInFlight(id), p.brandId, p.bandId, p.id, e.clientY > rect.top + rect.height / 2);
    });

    el.append(name, price, tools);
    return el;
  }

  /** 拖的是选区里的一张 → 整批跟着走；否则只动这一张 */
  const idsInFlight = (id) => (sel.has(id) && sel.size > 1 ? [...sel] : [id]);

  function moveMany(ids, brandId, bandId, anchorId, after) {
    const list = M().products;
    const ordered = list.filter((x) => ids.includes(x.id)); // 保持原有先后顺序
    if (!ordered.length) return;
    A.mark();
    ordered.forEach((p) => list.splice(list.indexOf(p), 1));
    ordered.forEach((p) => { p.brandId = brandId; p.bandId = bandId; });
    let at = list.length;
    if (anchorId && !ids.includes(anchorId)) {
      const j = list.findIndex((x) => x.id === anchorId);
      if (j >= 0) at = after ? j + 1 : j;
    }
    list.splice(at, 0, ...ordered);
    A.save('matrix'); render();
  }

  /* ── 分类下拉（可作用于一批）─────────────────────────── */
  function openTagMenu(anchor, ids) {
    document.querySelector('.tagmenu')?.remove();
    const m = document.createElement('div');
    m.className = 'tagmenu';
    const entries = [['default', { label: '未分类（默认色）', color: M().defaultColor }], ...Object.entries(M().tags)];
    entries.forEach(([k, v]) => {
      const b = document.createElement('button');
      b.innerHTML = `<i style="background:${v.color}"></i><span></span>`;
      b.querySelector('span').textContent = v.label;
      b.onclick = () => {
        A.mark();
        M().products.forEach((p) => { if (ids.includes(p.id)) p.tag = k; });
        A.save('matrix'); m.remove(); render();
      };
      m.appendChild(b);
    });
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.min(Math.max(8, r.left - 100), innerWidth - 244) + 'px';
    m.style.top = Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 10) + 'px';
    setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
  }

  /* ── 框选 ───────────────────────────────────────────── */
  function wireMarquee() {
    const scroll = A.$('.matrix-scroll');
    const box = A.$('#marquee');
    let start = null, additive = false;

    scroll.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !A.isEditing()) return;
      if (e.target.closest('.chip, button, input')) return;
      additive = e.ctrlKey || e.metaKey || e.shiftKey;
      if (!additive) clearSel();
      start = { x: e.clientX, y: e.clientY };
      box.hidden = false;
      Object.assign(box.style, { left: start.x + 'px', top: start.y + 'px', width: '0px', height: '0px' });
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!start) return;
      const x = Math.min(e.clientX, start.x), y = Math.min(e.clientY, start.y);
      const w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
      Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });

      const r = { l: x, t: y, r: x + w, b: y + h };
      const base = additive ? new Set(sel) : new Set();
      A.$$('.chip').forEach((el) => {
        const c = el.getBoundingClientRect();
        const hit = c.left < r.r && c.right > r.l && c.top < r.b && c.bottom > r.t;
        if (hit) base.add(el.dataset.id);
      });
      setSel([...base]);
    });

    window.addEventListener('mouseup', () => {
      if (!start) return;
      start = null;
      box.hidden = true;
      if (sel.size) A.toast(`选中 ${sel.size} 个产品，可以整批拖动`);
    });

    // 自动滚动：框选到边缘时跟着滚
    scroll.addEventListener('dragover', (e) => {
      const r = scroll.getBoundingClientRect();
      if (e.clientY > r.bottom - 40) scroll.scrollTop += 12;
      if (e.clientY < r.top + 40) scroll.scrollTop -= 12;
      if (e.clientX > r.right - 40) scroll.scrollLeft += 12;
      if (e.clientX < r.left + 40) scroll.scrollLeft -= 12;
    });
  }

  function wireBatchBar() {
    A.$('#batch-tag').onclick = (e) => openTagMenu(e.currentTarget, [...sel]);
    A.$('#batch-italic').onclick = () => {
      A.mark();
      const on = M().products.filter((p) => sel.has(p.id)).every((p) => p.italic);
      M().products.forEach((p) => { if (sel.has(p.id)) p.italic = !on; });
      A.save('matrix'); render();
    };
    A.$('#batch-underline').onclick = () => {
      A.mark();
      const on = M().products.filter((p) => sel.has(p.id)).every((p) => p.underline);
      M().products.forEach((p) => { if (sel.has(p.id)) p.underline = !on; });
      A.save('matrix'); render();
    };
    A.$('#batch-delete').onclick = () => {
      if (!confirm(`删除选中的 ${sel.size} 个产品？`)) return;
      A.mark();
      M().products = M().products.filter((p) => !sel.has(p.id));
      clearSel(); A.save('matrix'); render();
    };
    A.$('#batch-clear').onclick = clearSel;

    document.addEventListener('keydown', (e) => {
      if (!sel.size || A.view() !== 'matrix') return;
      if (document.activeElement?.tagName === 'INPUT') return;
      if (e.key === 'Escape') clearSel();
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); A.$('#batch-delete').click(); }
    });
  }

  /* ── 主网格 ─────────────────────────────────────────── */
  function render() {
    const g = A.$('#matrix');
    const m = M();
    g.innerHTML = '';
    g.style.gridTemplateColumns = `130px repeat(${m.brands.length}, minmax(170px, 1fr))`;

    // 已经不存在的产品从选区里剔掉
    [...sel].forEach((id) => { if (!m.products.some((p) => p.id === id)) sel.delete(id); });

    g.appendChild(Object.assign(document.createElement('div'), { className: 'mx-corner' }));

    m.brands.forEach((b) => {
      const h = document.createElement('div');
      h.className = 'mx-brand';
      const inp = document.createElement('input');
      inp.spellcheck = false;
      A.bindInput(inp, b, 'name', renderLegendStats, 'matrix');
      h.append(inp, A.mkKill('删除这个品牌及其产品', () => {
        if (!confirm(`删除「${b.name}」以及它下面的所有产品？`)) return;
        A.mark();
        const mm = M();
        mm.brands = mm.brands.filter((x) => x.id !== b.id);
        mm.products = mm.products.filter((x) => x.brandId !== b.id);
        A.save('matrix'); render();
      }));
      g.appendChild(h);
    });

    m.bands.forEach((band) => {
      const lab = document.createElement('div');
      lab.className = 'mx-band';
      const inp = document.createElement('input');
      inp.spellcheck = false;
      A.bindInput(inp, band, 'name', null, 'matrix');
      lab.append(inp, A.mkKill('删除这条价格带及其产品', () => {
        if (!confirm(`删除价格带「${band.name}」以及里面的所有产品？`)) return;
        A.mark();
        const mm = M();
        mm.bands = mm.bands.filter((x) => x.id !== band.id);
        mm.products = mm.products.filter((x) => x.bandId !== band.id);
        A.save('matrix'); render();
      }));
      g.appendChild(lab);

      m.brands.forEach((brand) => {
        const cell = document.createElement('div');
        cell.className = 'mx-cell';

        m.products.filter((p) => p.brandId === brand.id && p.bandId === band.id).forEach((p) => cell.appendChild(chip(p)));

        const add = document.createElement('button');
        add.className = 'addhere';
        add.textContent = '+ 添加产品';
        add.onclick = () => {
          const mm = M();
          const cellIndex = mm.bands.indexOf(band) * mm.brands.length + mm.brands.indexOf(brand);
          const newId = A.uid('i_');
          A.mark();
          mm.products.push({ id: newId, brandId: brand.id, bandId: band.id, name: '新产品', price: '¥0', tag: 'default', italic: false, underline: false });
          A.save('matrix'); render();
          A.$$('.mx-cell')[cellIndex]?.querySelector(`.chip[data-id="${newId}"] .n`)?.select();
        };
        cell.appendChild(add);

        cell.addEventListener('dragover', (e) => { e.preventDefault(); cell.classList.add('drop-hot'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('drop-hot'));
        cell.addEventListener('drop', (e) => {
          e.preventDefault();
          cell.classList.remove('drop-hot');
          const id = dragId || e.dataTransfer.getData('text/plain');
          if (id) moveMany(idsInFlight(id), brand.id, band.id, null, false);
        });

        g.appendChild(cell);
      });
    });

    paintSel();
    renderTagEditor();
    renderLegendStats();
  }

  /* ── 侧栏：分类编辑 ─────────────────────────────────── */
  function renderTagEditor() {
    const box = A.$('#tag-editor');
    box.innerHTML = '';

    Object.entries(M().tags).forEach(([key, t]) => {
      const row = document.createElement('div');
      row.className = 'tag-row';

      const c = document.createElement('input');
      c.type = 'color'; c.value = t.color;
      c.addEventListener('input', () => { t.color = c.value; hex.value = c.value; A.save('matrix'); repaint(); });
      A.trackable(c, render);

      const hex = document.createElement('input');
      hex.type = 'text'; hex.value = t.color; hex.spellcheck = false;
      hex.style.flex = '0 0 74px';
      hex.addEventListener('input', () => {
        if (/^#[0-9a-f]{6}$/i.test(hex.value)) { t.color = hex.value; c.value = hex.value; A.save('matrix'); repaint(); }
      });
      A.trackable(hex);

      const name = richField(t, 'label', renderLegendStats);

      row.append(c, hex, name, A.mkKill('删除分类（产品会退回默认色）', () => {
        A.mark();
        const mm = M();
        delete mm.tags[key];
        mm.products.forEach((p) => { if (p.tag === key) p.tag = 'default'; });
        A.save('matrix'); render();
      }));
      box.appendChild(row);
    });
  }

  /* ── 富文本字段：加粗 / 斜体 / 下划线 ─────────────────
     不引 Quill / TipTap（起步 100KB+），这里只要三个命令。
     execCommand 虽被标为 deprecated，但没有任何浏览器计划移除它。 */
  const ALLOWED = /^(B|I|U|STRONG|EM|BR)$/;

  /** 白名单清洗：内容会进 db.json 并以 innerHTML 渲染，不清洗就等于给同事开了 XSS */
  function sanitize(html) {
    const box = document.createElement('div');
    box.innerHTML = html;
    (function walk(n) {
      [...n.childNodes].forEach((c) => {
        if (c.nodeType === 1) {
          walk(c);
          if (!ALLOWED.test(c.tagName)) c.replaceWith(...c.childNodes);
          else [...c.attributes].forEach((a) => c.removeAttribute(a.name));
        } else if (c.nodeType !== 3) c.remove();
      });
    })(box);
    return box.innerHTML;
  }

  function richField(obj, key, after) {
    const el = document.createElement('div');
    el.className = 'rich';
    el.contentEditable = A.isEditing() ? 'true' : 'false';
    el.innerHTML = obj[key] || '';
    el.dataset.placeholder = '分类名';

    el.addEventListener('input', () => { obj[key] = sanitize(el.innerHTML); A.save('matrix'); after && after(); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); return; }
      if (!(e.ctrlKey || e.metaKey)) return;
      const cmd = { b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()];
      if (cmd) { e.preventDefault(); document.execCommand(cmd); }
    });
    // 从 Word / 网页粘进来会带一坨样式，强制纯文本
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    });
    A.trackable(el);

    const bar = document.createElement('div');
    bar.className = 'richbar';
    [['B', 'bold', '加粗'], ['I', 'italic', '斜体'], ['U', 'underline', '下划线']].forEach(([label, cmd, tip]) => {
      const b = document.createElement('button');
      b.textContent = label; b.title = tip + '（选中文字后点，或 Ctrl+' + label + '）';
      b.onmousedown = (e) => e.preventDefault();   // 别让按钮抢走选区
      b.onclick = () => { el.focus(); document.execCommand(cmd); el.dispatchEvent(new Event('input')); };
      bar.appendChild(b);
    });

    const wrap = document.createElement('div');
    wrap.className = 'richwrap';
    wrap.append(el, bar);
    return wrap;
  }

  /** 只换颜色时别重建 DOM，否则输入焦点会丢 */
  function repaint() {
    A.$$('.chip').forEach((el) => {
      const p = M().products.find((x) => x.id === el.dataset.id);
      if (p) el.style.setProperty('--chip', colorOf(p.tag));
    });
    renderLegendStats();
  }

  /* ── 图例 + 统计 ────────────────────────────────────── */
  function renderLegendStats() {
    const m = M();
    const lg = A.$('#legend');
    lg.innerHTML = '';
    Object.entries(m.tags).forEach(([, t]) => {
      const s = document.createElement('span');
      s.innerHTML = `<i class="swatch" style="background:${t.color}"></i>`;
      const label = document.createElement('span');
      label.innerHTML = t.label || '';   // 已经过 sanitize 白名单，只可能是 b/i/u
      s.appendChild(label);
      lg.appendChild(s);
    });

    const prices = m.products.map((p) => Number(String(p.price).replace(/[^\d.]/g, ''))).filter((n) => n > 0);
    const avg = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
    A.$('#matrix-stats').innerHTML = [
      [m.products.length, '产品总数'], [m.brands.length, '品牌'],
      [m.bands.length, '价格带'], ['¥' + avg.toLocaleString(), '均价']
    ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
  }

  /* ── 初始化 ─────────────────────────────────────────── */
  function init(api) {
    A = api;

    A.$('#btn-add-tag').onclick = () => {
      A.mark();
      M().tags[A.uid('t_')] = { label: '新分类', color: '#c9922f', italic: false, underline: false };
      A.save('matrix'); render();
      A.$('#tag-editor').lastChild?.querySelectorAll('input[type=text]')[1]?.select();
    };
    A.$('#btn-add-brand').onclick = () => {
      A.mark();
      M().brands.push({ id: A.uid('b_'), name: '新品牌' });
      A.save('matrix'); render();
      A.$$('.mx-brand input').pop()?.select();
    };
    A.$('#btn-add-band').onclick = () => {
      A.mark();
      M().bands.push({ id: A.uid('p_'), name: '0-0K' });
      A.save('matrix'); render();
      A.$$('.mx-band input').pop()?.select();
    };

    const dc = A.$('#default-color'), dh = A.$('#default-color-hex');
    dc.value = M().defaultColor; dh.value = M().defaultColor;
    dc.addEventListener('input', () => { M().defaultColor = dc.value; dh.value = dc.value; A.save('matrix'); repaint(); });
    dh.addEventListener('input', () => {
      if (/^#[0-9a-f]{6}$/i.test(dh.value)) { M().defaultColor = dh.value; dc.value = dh.value; A.save('matrix'); repaint(); }
    });
    A.trackable(dc); A.trackable(dh);

    wireMarquee();
    wireBatchBar();
  }

  return { init, render, clearSelection: clearSel };
})();
