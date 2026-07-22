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
  const hasTag = (tag) => tag !== 'default' && !!M().tags[tag];

  /**
   * 卡片改整体色块填充后，分类色可能很深也可能很浅，白字/深字必须跟着算，
   * 不能像以前那样固定用深色文字——YIQ 亮度公式，>=150 判定为浅色底用深字。
   * 未分类的产品保持原来的白卡片 + 深色文字，不整体填色：分类色块的意义
   * 是让"有标记的产品"跳出来，如果连未分类的大多数产品也整片上色，
   * 矩阵会变成一片色块，反而失去了辨识度。
   */
  function textOn(hex) {
    const h = String(hex || '').replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) || 0, g = parseInt(h.slice(2, 4), 16) || 0, b = parseInt(h.slice(4, 6), 16) || 0;
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 150
      ? { main: '#161c28', dim: '#161c28b8', btnBg: 'rgba(22,28,40,.12)' }
      : { main: '#fff', dim: '#ffffffbf', btnBg: 'rgba(255,255,255,.16)' };
  }

  /**
   * 把 hex 颜色和黑色按比例混合，返回 rgb() 字符串——特意不用 CSS 的
   * color-mix()：PNG 导出用的 html2canvas（2022 年的老库）不认识这个
   * 函数，解析样式表时碰到就直接抛错、整个截图失败，用 JS 算出最终颜色
   * 摆在行内变量里最省事，顺便还兼容更老的浏览器。
   */
  const mixWithBlack = (hex, pct) => {
    const h = String(hex || '').replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) || 0, g = parseInt(h.slice(2, 4), 16) || 0, b = parseInt(h.slice(4, 6), 16) || 0;
    const f = pct / 100;
    return `rgb(${Math.round(r * f)}, ${Math.round(g * f)}, ${Math.round(b * f)})`;
  };

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
    const tagged = hasTag(p.tag);
    el.className = 'chip' + (p.italic ? ' i' : '') + (p.underline ? ' u' : '') + (sel.has(p.id) ? ' sel' : '') + (tagged ? ' filled' : '') + (p.isNew ? ' new' : '');
    const chipColor = colorOf(p.tag);
    el.style.setProperty('--chip', chipColor);
    if (tagged) {
      const text = textOn(chipColor);
      el.style.setProperty('--chip-fill', chipColor);
      el.style.setProperty('--chip-text', text.main);
      el.style.setProperty('--chip-text-dim', text.dim);
      el.style.setProperty('--chip-border', mixWithBlack(chipColor, 55));
      el.style.setProperty('--chip-btn-bg', text.btnBg);
    }
    el.draggable = A.isEditing();
    el.dataset.id = p.id;

    if (p.isNew) {
      const badge = document.createElement('span');
      badge.className = 'chip-new';
      badge.textContent = 'NEW';
      el.appendChild(badge);
    }

    const name = document.createElement('input');
    name.className = 'n'; name.placeholder = '产品名';
    A.bindInput(name, p, 'name', null, 'matrix');

    const price = document.createElement('input');
    price.className = 'p'; price.placeholder = '¥ —';
    A.bindInput(price, p, 'price', null, 'matrix');

    [name, price].forEach((i) => {
      i.addEventListener('mousedown', (e) => {
        // Ctrl/Cmd 按住时哪怕点在输入框上也是想多选，不是想聚焦编辑——
        // 放行冒泡到卡片本身的 mousedown（下面那个），别在这里截胡。
        if (e.ctrlKey || e.metaKey) { e.preventDefault(); return; }
        e.stopPropagation(); el.draggable = false;
      });
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
    // 跟拖拽整批移动（idsInFlight）同样的道理：这张卡片如果本来就在
    // 多选选区里，点它自己的改分类按钮也该对整批生效，不能只改这一个——
    // 不然用户框选一堆卡片后随手点其中一张的分类按钮，会发现只有点到
    // 的那张变了色，其余选中的都没变，很容易被当成"批量改分类坏了"。
    dot.onclick = (e) => { e.stopPropagation(); openTagMenu(e.currentTarget, idsInFlight(p.id)); };

    const nw = document.createElement('button');
    nw.textContent = 'N'; nw.title = '新品标记，不受分类限制'; nw.className = 'nw' + (p.isNew ? ' on' : '');
    nw.onclick = (e) => { e.stopPropagation(); toggleNew(idsInFlight(p.id)); };

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

    tools.append(nw, dot, it, un, rm);

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

  /** 单张卡片的 N 按钮和批量栏的"标记新品"共用同一套开关逻辑：
   *  选中的产品里如果已经全部是 New，再点一次就是取消，否则就是打上 —— 跟
   *  批量斜体/下划线一个道理，避免"选中的产品新旧混杂时点一下结果各不相同"。 */
  function toggleNew(ids) {
    A.mark();
    const idSet = new Set(ids);
    const on = M().products.filter((p) => idSet.has(p.id)).every((p) => p.isNew);
    M().products.forEach((p) => { if (idSet.has(p.id)) p.isNew = !on; });
    A.save('matrix'); render();
  }

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
    // 批量工具条弹出时也贴在屏幕底部，分类菜单原来只避开视口边界，
    // 没算工具条这块地方，两个一起出现时会叠在一起分不清——工具条
    // 可见时把它的顶边也当成一道边界，跟视口下边界取更靠上的那个。
    const bar = A.$('#batchbar');
    const bottomLimit = (bar && !bar.hidden ? bar.getBoundingClientRect().top : innerHeight) - 10;
    m.style.maxHeight = Math.max(160, bottomLimit - 10) + 'px';
    m.style.overflowY = 'auto';
    m.style.left = Math.min(Math.max(8, r.left - 100), innerWidth - 244) + 'px';
    m.style.top = Math.min(r.bottom + 6, bottomLimit - m.offsetHeight) + 'px';
    setTimeout(() => document.addEventListener('click', () => m.remove(), { once: true }), 0);
  }

  /* ── 框选 ───────────────────────────────────────────── */
  function wireMarquee() {
    const scroll = A.$('.matrix-scroll');
    const box = A.$('#marquee');
    let start = null, additive = false;

    scroll.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !A.isEditing()) return;
      // .mx-band / .mx-brand 是行/列头，靠 draggable 原生拖拽排序——这里的
      // preventDefault() 会连带取消它们的拖拽起手，必须排除掉，不然框选逻辑
      // 一直抢在原生 dragstart 前面把 mousedown 吃掉，行列拖拽永远不会触发
      if (e.target.closest('.chip, button, input, .mx-band, .mx-brand')) return;
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
    A.$('#batch-new').onclick = () => toggleNew([...sel]);
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
  let dragBandId = null;
  let dragBrandId = null;

  function render() {
    const g = A.$('#matrix');
    const m = M();
    const editing = A.isEditing();
    g.innerHTML = '';
    // 最后一列固定窄宽度，专门给"新增品牌列"的加号按钮用——查看模式没有这个按钮，
    // 不留这列，省出来的宽度让 minmax(…, 1fr) 自动把每个品牌列撑到最大
    g.style.gridTemplateColumns = editing
      ? `130px repeat(${m.brands.length}, minmax(170px, 1fr)) 44px`
      : `130px repeat(${m.brands.length}, minmax(170px, 1fr))`;

    // 已经不存在的产品从选区里剔掉
    [...sel].forEach((id) => { if (!m.products.some((p) => p.id === id)) sel.delete(id); });

    g.appendChild(Object.assign(document.createElement('div'), { className: 'mx-corner' }));

    m.brands.forEach((b, bIdx) => {
      const locked = bIdx === 0;
      const h = document.createElement('div');
      h.className = 'mx-brand' + (locked ? ' locked' : '');
      h.dataset.id = b.id;
      h.draggable = editing && !locked;

      const handle = document.createElement('span');
      handle.className = 'mx-brand-handle';
      handle.title = locked ? '首列锁定，不参与拖拽排序' : '按住拖动调整品牌顺序';

      const inp = document.createElement('input');
      inp.spellcheck = false;
      A.bindInput(inp, b, 'name', renderLegendStats, 'matrix');
      inp.addEventListener('mousedown', (e) => { e.stopPropagation(); h.draggable = false; });
      inp.addEventListener('blur', () => { h.draggable = editing; });

      h.append(handle, inp, A.mkKill('删除这个品牌及其产品', () => {
        if (!confirm(`删除「${b.name}」以及它下面的所有产品？`)) return;
        A.mark();
        const mm = M();
        mm.brands = mm.brands.filter((x) => x.id !== b.id);
        mm.products = mm.products.filter((x) => x.brandId !== b.id);
        A.save('matrix'); render();
      }));

      h.addEventListener('dragstart', (e) => {
        dragBrandId = b.id;
        h.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', b.id);
      });
      h.addEventListener('dragend', () => {
        dragBrandId = null;
        A.$$('.mx-brand.dragging').forEach((el) => el.classList.remove('dragging'));
      });
      h.addEventListener('dragover', (e) => {
        if (!dragBrandId || dragBrandId === b.id) return;
        e.preventDefault();
        h.classList.add('drop-hot');
      });
      h.addEventListener('dragleave', () => h.classList.remove('drop-hot'));
      h.addEventListener('drop', (e) => {
        e.preventDefault();
        h.classList.remove('drop-hot');
        const id = dragBrandId || e.dataTransfer.getData('text/plain');
        if (!id || id === b.id) return;
        const rect = h.getBoundingClientRect();
        // 首列锁定在第一位：任何拖拽落到它上面都只能排到它后面，不能抢占第一位
        moveBrand(id, b.id, locked || e.clientX > rect.left + rect.width / 2);
      });

      g.appendChild(h);
    });

    if (editing) {
      const addBrand = document.createElement('button');
      addBrand.type = 'button';
      addBrand.className = 'mx-add-brand';
      addBrand.title = '新增品牌列';
      addBrand.textContent = '+';
      addBrand.onclick = () => {
        A.mark();
        M().brands.push({ id: A.uid('b_'), name: '新品牌' });
        A.save('matrix'); render();
        A.$$('.mx-brand input').pop()?.select();
      };
      g.appendChild(addBrand);
    }

    m.bands.forEach((band, pIdx) => {
      const locked = pIdx === 0;
      const lab = document.createElement('div');
      lab.className = 'mx-band' + (locked ? ' locked' : '');
      lab.dataset.id = band.id;
      lab.draggable = editing && !locked;

      const handle = document.createElement('span');
      handle.className = 'mx-band-handle';
      handle.title = locked ? '首行锁定，不参与拖拽排序' : '按住拖动调整价格带顺序';

      const inp = document.createElement('input');
      inp.spellcheck = false;
      A.bindInput(inp, band, 'name', null, 'matrix');
      inp.addEventListener('mousedown', (e) => { e.stopPropagation(); lab.draggable = false; });
      inp.addEventListener('blur', () => { lab.draggable = A.isEditing(); });

      lab.append(handle, inp, A.mkKill('删除这条价格带及其产品', () => {
        if (!confirm(`删除价格带「${band.name}」以及里面的所有产品？`)) return;
        A.mark();
        const mm = M();
        mm.bands = mm.bands.filter((x) => x.id !== band.id);
        mm.products = mm.products.filter((x) => x.bandId !== band.id);
        A.save('matrix'); render();
      }));

      lab.addEventListener('dragstart', (e) => {
        dragBandId = band.id;
        lab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', band.id);
      });
      lab.addEventListener('dragend', () => {
        dragBandId = null;
        A.$$('.mx-band.dragging').forEach((el) => el.classList.remove('dragging'));
      });
      lab.addEventListener('dragover', (e) => {
        if (!dragBandId || dragBandId === band.id) return;
        e.preventDefault();
        lab.classList.add('drop-hot');
      });
      lab.addEventListener('dragleave', () => lab.classList.remove('drop-hot'));
      lab.addEventListener('drop', (e) => {
        e.preventDefault();
        lab.classList.remove('drop-hot');
        const id = dragBandId || e.dataTransfer.getData('text/plain');
        if (!id || id === band.id) return;
        const rect = lab.getBoundingClientRect();
        // 首行锁定在第一位：任何拖拽落到它上面都只能排到它后面，不能抢占第一位
        moveBand(id, band.id, locked || e.clientY > rect.top + rect.height / 2);
      });

      g.appendChild(lab);

      m.brands.forEach((brand) => {
        const cell = document.createElement('div');
        cell.className = 'mx-cell';

        m.products.filter((p) => p.brandId === brand.id && p.bandId === band.id).forEach((p) => cell.appendChild(chip(p)));

        const add = document.createElement('button');
        add.className = 'addhere';
        add.textContent = '+ 添加产品';
        add.onclick = () => {
          const newId = A.uid('i_');
          A.mark();
          M().products.push({ id: newId, brandId: brand.id, bandId: band.id, name: '新产品', price: '¥0', tag: 'default', italic: false, underline: false });
          A.save('matrix'); render();
          A.$(`.chip[data-id="${newId}"] .n`)?.select();
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

      // 补一格空位，跟表头那颗"新增品牌"按钮对齐，网格才不会错位（查看模式没有那颗按钮，不用补）
      if (editing) g.appendChild(Object.assign(document.createElement('div'), { className: 'mx-fill' }));
    });

    if (editing) {
      const addBand = document.createElement('button');
      addBand.type = 'button';
      addBand.className = 'mx-add-band';
      addBand.textContent = '+ 新增价格带';
      addBand.onclick = () => {
        A.mark();
        M().bands.push({ id: A.uid('p_'), name: '0-0K' });
        A.save('matrix'); render();
        A.$$('.mx-band input').pop()?.select();
      };
      g.appendChild(addBand);
    }

    paintSel();
    renderLegendStats();
  }

  /** 价格带拖动排序：把 id 这条挪到 targetId 旁边。
   *  after 由放手时鼠标在目标行上半/下半决定——如果永远只往"前面"插，
   *  拖到紧挨着的下一行时，先移除 id 会让 targetId 的下标正好补上被腾出
   *  的位置，"插到 targetId 前面"就等于插回原处，看起来跟没拖一样。 */
  function moveBand(id, targetId, after) {
    const list = M().bands;
    const from = list.findIndex((b) => b.id === id);
    if (from < 0) return;
    A.mark();
    const [item] = list.splice(from, 1);
    let to = list.findIndex((b) => b.id === targetId);
    if (to < 0) to = list.length; else if (after) to += 1;
    list.splice(to, 0, item);
    A.save('matrix'); render();
  }

  /* 品牌列拖动排序：跟 moveBand 同一个套路，方向判断改成水平方向 */
  function moveBrand(id, targetId, after) {
    const list = M().brands;
    const from = list.findIndex((b) => b.id === id);
    if (from < 0) return;
    A.mark();
    const [item] = list.splice(from, 1);
    let to = list.findIndex((b) => b.id === targetId);
    if (to < 0) to = list.length; else if (after) to += 1;
    list.splice(to, 0, item);
    A.save('matrix'); render();
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

  /** 只换颜色时别重建图例/矩阵的 DOM，否则输入焦点、正在拖拽的原生取色器都会被打断——
   *  只重算卡片色块引用的 CSS 变量即可，图例本身颜色是它自己的 <input> 在显示，不用跟着重建 */
  function repaint() {
    A.$$('.chip').forEach((el) => {
      const p = M().products.find((x) => x.id === el.dataset.id);
      if (p) el.style.setProperty('--chip', colorOf(p.tag));
    });
  }

  /* ── 图例：兼当分类编辑器 ──────────────────────────────
     图例本身就是"改一处、全盘生效"的编辑入口——不再单独开一块侧栏。
     第一行是「默认色」（未分类产品用的兜底色，不是真分类，不能删）；
     后面每行一个分类：色块 + 富文本名字 + 删除；最后一个「+」新增分类。 */
  function renderLegendStats() {
    const m = M();
    const lg = A.$('#legend');
    lg.innerHTML = '';

    const defRow = document.createElement('div');
    defRow.className = 'tag-row legend-default';
    const defColor = document.createElement('input');
    defColor.type = 'color'; defColor.title = '默认色（未分类产品）';
    defColor.value = m.defaultColor;
    defColor.addEventListener('input', () => { m.defaultColor = defColor.value; A.save('matrix'); repaint(); });
    A.trackable(defColor, render);
    const defLabel = document.createElement('span');
    defLabel.className = 'legend-default-label';
    defLabel.textContent = '默认色 · 未分类';
    defRow.append(defColor, defLabel);
    lg.appendChild(defRow);

    Object.entries(m.tags).forEach(([key, t]) => {
      const row = document.createElement('div');
      row.className = 'tag-row';

      const c = document.createElement('input');
      c.type = 'color'; c.value = t.color;
      c.addEventListener('input', () => { t.color = c.value; A.save('matrix'); repaint(); });
      A.trackable(c, render);

      const name = richField(t, 'label', null);

      row.append(c, name, A.mkKill('删除分类（产品会退回默认色）', () => {
        A.mark();
        const mm = M();
        delete mm.tags[key];
        mm.products.forEach((p) => { if (p.tag === key) p.tag = 'default'; });
        A.save('matrix'); render();
      }));
      lg.appendChild(row);
    });

    const addTag = document.createElement('button');
    addTag.type = 'button';
    addTag.className = 'legend-add';
    addTag.title = '新增一个分类';
    addTag.textContent = '+';
    addTag.onclick = () => {
      A.mark();
      M().tags[A.uid('t_')] = { label: '新分类', color: '#c9922f', italic: false, underline: false };
      A.save('matrix'); render();
      A.$('#legend').querySelector('.tag-row:last-of-type .rich')?.focus();
    };
    lg.appendChild(addTag);

    const prices = m.products.map((p) => Number(String(p.price).replace(/[^\d.]/g, ''))).filter((n) => n > 0);
    const avg = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
    A.$('#matrix-stats').innerHTML = [
      [m.products.length, '产品总数'], [m.brands.length, '品牌'],
      [m.bands.length, '价格带'], ['¥' + avg.toLocaleString(), '均价']
    ].map(([b, s]) => `<div class="stat"><b>${b}</b><span>${s}</span></div>`).join('');
  }

  /* ── 导出 PNG（固定 16:9，给 PPT 用）───────────────────
     矩阵原本的列宽是响应式的（品牌一多就变宽/触发横向滚动），直接截图
     会得到一张比例很怪、四周留白很不均匀的图。这里的策略：
       1. 把矩阵克隆到一个不影响当前页面的离屏容器里，去掉编辑态才有
          意义的工具按钮（拖拽手柄、增删按钮），这些截进 PPT 里没意义。
       2. 列宽双向调整：品牌多就收窄、品牌少价格带多（内容偏瘦高）就
          放宽，尽量让内容本身的宽高比先贴近 16:9，而不是事后硬凑。
       3. 贴到足够近之后，剩下的一点点比例差用轻微的非等比拉伸铺满
          画布，不再留白——这一步的形变幅度很小，肉眼基本看不出来，
          前提是第 2 步已经把比例带到很接近了。
       4. 最终画布是 4K（3840×2160），配合 html2canvas 2 倍像素密度
          渲染，全屏投影也不会糊。
     ═══════════════════════════════════════════════════════════ */
  const EXPORT_W = 3840, EXPORT_H = 2160; // 16:9，4K，投影全屏也够清晰
  const COL_START = 220, COL_MIN = 108, COL_MAX = 340, COL_STEP = 12;
  // 字号从这几档里挑：先试最大的，配合把列宽压到 COL_MIN 腾地方，
  // 还是装不下才降一档——放映用的图，字尽量大比排版工整更重要。
  const FONT_SCALE_MAX = 2, FONT_SCALE_MIN = 1, FONT_SCALE_STEP = 0.1;

  /**
   * html2canvas（2022 年的老库）解析不了 var(--a, var(--b)) 这种嵌套
   * fallback 的 CSS 变量——「未分类」卡片的颜色刚好全走这条链路
   * （--chip-fill 没设置时 fallback 到 --paper-card），解析失败后
   * 颜色直接崩成灰蒙蒙的，就是反馈里"前景色不清晰"的真正原因。
   * 这里在导出前把浏览器已经算好的最终颜色摘出来，糊成克隆节点的
   * 内联样式，html2canvas 就不用自己再解析一遍变量链路了。
   */
  function freezeColors(origRoot, cloneRoot, targets) {
    targets.forEach(({ selector, props }) => {
      const origEls = origRoot.querySelectorAll(selector);
      const cloneEls = cloneRoot.querySelectorAll(selector);
      origEls.forEach((el, i) => {
        const target = cloneEls[i];
        if (!target) return;
        const cs = getComputedStyle(el);
        props.forEach((p) => { target.style[p] = cs[p]; });
      });
    });
  }

  /**
   * html2canvas 渲染 <input> 的文字是出了名的不可靠——品牌名、价格带、
   * 产品名/价格全都是 input（方便双击直接编辑），实测导出后经常整字
   * 丢失或错位（"IQAir" 被吞成"QA ir"），这才是反馈里"数据都没了"的
   * 真正原因，不是数据真没了，是 html2canvas 画丢了。
   * 换个思路：导出时把这些 input 换成普通的 <div> 文字，把浏览器已经
   * 算好的字体/颜色/间距摘出来糊成内联样式再画——html2canvas 画普通
   * 文本节点是稳的，出问题的只有表单控件这条渲染路径。
   * 宽度故意不摘（摘了会把改列宽之前的旧像素宽度焊死），留 100% 让
   * 它跟着 autoFitColumns 之后的新列宽走。
   */
  const TEXT_STYLE_PROPS = ['fontFamily', 'fontWeight', 'fontStyle', 'fontSize', 'letterSpacing', 'lineHeight', 'textAlign', 'textDecorationLine', 'color'];
  /**
   * 记下这个元素在 1× 字号下的基准 font-size / line-height，后面
   * applyFontScale() 按倍数重新算，不是在上一次结果上累乘——
   * 不然反复试挡位的时候会越滚越大，数字会飘。
   */
  function markScalable(el, baseFs, baseLh) {
    el.dataset.baseFs = baseFs;
    el.dataset.baseLh = baseLh || baseFs * 1.3;
  }
  /** 色块方块/图例间距同理——不跟着字号一起放大的话，字号涨上去之后
   *  色块和行间距还是编辑态那个小尺寸，色块和留白比例失衡，图例看着
   *  反而比放大前更小气（这才是"图例太小"反馈的真正原因，字号其实
   *  已经在跟着放大了，色块和间距没跟上）。 */
  function markScalableBox(el, base) {
    el.dataset.baseBox = base;
  }
  function markScalableGap(el, baseX, baseY) {
    el.dataset.baseGapX = baseX;
    el.dataset.baseGapY = baseY == null ? baseX : baseY;
  }
  /** querySelectorAll 只找后代，找不到 root 自己——fitLegendScale() 会拿
   *  legend 容器本身当 root 调用（它自己的行/列间距也标了 data-base-gap-x），
   *  这里得把 root 自己也纳入候选，不然容器级别的属性会被静默漏掉。 */
  function selfAndDescendants(root, sel) {
    return root.matches?.(sel) ? [root, ...root.querySelectorAll(sel)] : [...root.querySelectorAll(sel)];
  }
  function applyFontScale(root, scale) {
    selfAndDescendants(root, '[data-base-fs]').forEach((el) => {
      el.style.fontSize = (parseFloat(el.dataset.baseFs) * scale).toFixed(2) + 'px';
      el.style.lineHeight = (parseFloat(el.dataset.baseLh) * scale).toFixed(2) + 'px';
    });
    selfAndDescendants(root, '[data-base-box]').forEach((el) => {
      const s = (parseFloat(el.dataset.baseBox) * scale).toFixed(2) + 'px';
      el.style.width = s; el.style.height = s;
    });
    selfAndDescendants(root, '[data-base-gap-x]').forEach((el) => {
      el.style.columnGap = (parseFloat(el.dataset.baseGapX) * scale).toFixed(2) + 'px';
      el.style.rowGap = (parseFloat(el.dataset.baseGapY) * scale).toFixed(2) + 'px';
    });
  }

  function textifyInputs(origRoot, cloneRoot, selector) {
    const origEls = origRoot.querySelectorAll(selector);
    const cloneEls = cloneRoot.querySelectorAll(selector);
    origEls.forEach((el, i) => {
      const cloneEl = cloneEls[i];
      if (!cloneEl) return;
      const cs = getComputedStyle(el);
      const div = document.createElement('div');
      div.className = cloneEl.className;
      div.textContent = el.value || '';
      TEXT_STYLE_PROPS.forEach((p) => { div.style[p] = cs[p]; });
      // 装不下不再用省略号截断——数据不能丢，装不下就换行让格子变高，
      // 反正后面 fitScaleAndColumns 会先尽量把列宽/字号调到能装下大部分内容。
      div.style.cssText += 'border:0; background:none; width:100%; min-width:0; box-sizing:border-box; padding:' + cs.padding + '; border-radius:' + cs.borderRadius + '; white-space:normal; overflow-wrap:break-word;';
      markScalable(div, parseFloat(cs.fontSize) || 14, parseFloat(cs.lineHeight));
      cloneEl.replaceWith(div);
    });
  }

  const HEAD_FREEZE = [{ selector: 'h1, p', props: ['color'] }];
  const GRID_FREEZE = [
    { selector: '.chip', props: ['backgroundColor', 'borderColor'] },
    { selector: '.mx-corner, .mx-brand, .mx-band, .mx-cell', props: ['backgroundColor'] }
  ];
  /** h1/副标题也要跟着放大——不止表格里的内容（图例文字的缩放/冻色在 simplifyLegendForExport 里单独处理） */
  function markScalableGroup(origRoot, cloneRoot, selector) {
    const origEls = origRoot.querySelectorAll(selector);
    const cloneEls = cloneRoot.querySelectorAll(selector);
    origEls.forEach((el, i) => {
      const target = cloneEls[i];
      if (!target) return;
      const cs = getComputedStyle(el);
      markScalable(target, parseFloat(cs.fontSize) || 14, parseFloat(cs.lineHeight));
    });
  }

  /** 图例现在是"取色器 + 富文本 + 删除按钮"的编辑表单，导出快照只要看得懂
   *  的静态图例——按真实文档里量出来的字号/颜色，新建 swatch + 文字的老样子
   *  （不能直接复用表单元素，不然导出图里会带着色块选择器和删除叉号）。
   *  必须在 freezeColors / markScalableGroup 处理图例之前调用：那两个函数
   *  按 orig/clone 的 'span' 选择器逐个配对，得先把 clone 的结构改回
   *  span+span 才对得上号。 */
  function simplifyLegendForExport(origLegend, legend) {
    const origRows = [...origLegend.querySelectorAll('.tag-row')];
    const cloneRows = [...legend.querySelectorAll('.tag-row')];
    origRows.forEach((origRow, i) => {
      const cloneRow = cloneRows[i];
      if (!cloneRow) return;
      const colorInput = origRow.querySelector('input[type=color]');
      const richOrLabel = origRow.querySelector('.rich, .legend-default-label');
      const cs = richOrLabel ? getComputedStyle(richOrLabel) : null;
      const span = document.createElement('span');
      const swatch = document.createElement('i');
      swatch.className = 'swatch';
      swatch.style.background = colorInput ? colorInput.value : '';
      markScalableBox(swatch, 11); // 基准取自 .legend i.swatch 的 11px
      markScalableGap(span, 7); // 基准取自 .legend span 的 gap:7px（色块到文字）
      const label = document.createElement('span');
      label.innerHTML = richOrLabel ? richOrLabel.innerHTML : '';
      if (cs) { label.style.color = cs.color; markScalable(label, parseFloat(cs.fontSize) || 12.5, parseFloat(cs.lineHeight)); }
      span.append(swatch, label);
      cloneRow.replaceWith(span);
    });
    legend.querySelector('.legend-add')?.remove();
    markScalableGap(legend, 10, 8); // 基准取自 .legend 的 gap:8px 10px（行/列间距），条目之间也要跟着一起放大，不然字大了反而挤在一起
  }

  function buildExportClone() {
    const origHead = A.$('#matrix-canvas .paper-head');
    const origGrid = A.$('#matrix');
    const origLegend = A.$('#legend');

    const head = origHead.cloneNode(true);
    const grid = origGrid.cloneNode(true);
    const legend = origLegend.cloneNode(true);

    head.querySelector('.matrix-head-tools')?.remove(); // 统计/说明图标/导出按钮都跟标题同一行，克隆时得先摘掉，不然会截进图里、也会打乱下面按 h1/p 顺序对应原节点的逻辑
    grid.querySelectorAll('.mx-add-brand, .mx-add-band, .mx-fill, .mx-band-handle, .mx-brand-handle').forEach((el) => el.remove()); // 新增品牌/价格带的加号、拖拽手柄、补位空格都是编辑态才有意义的东西，且 fitScaleAndColumns 重算列宽时不会给它们留位置，留着会把导出图挤歪
    // .mx-corner/.mx-brand/.mx-band 在编辑态用 position:sticky 做首行/首列冻结，
    // 是为了配合 .matrix-scroll 的滚动容器；导出克隆体离屏渲染、根本不滚动，
    // 但 html2canvas（老库）不认识 sticky，会按它自己的规则乱摆——价格带那一列
    // （.mx-band，本该在最左）实测被画到最右边，就是这个原因。导出用不到
    // 冻结效果，直接去掉定位，让它们按网格自身的行列位置正常排布。
    grid.querySelectorAll('.mx-corner, .mx-brand, .mx-band').forEach((el) => {
      el.style.position = 'static';
      el.style.left = 'auto';
      el.style.top = 'auto';
    });
    simplifyLegendForExport(origLegend, legend);

    freezeColors(origHead, head, HEAD_FREEZE);
    freezeColors(origGrid, grid, GRID_FREEZE);

    textifyInputs(origGrid, grid, '.mx-brand input');
    textifyInputs(origGrid, grid, '.mx-band input');
    textifyInputs(origGrid, grid, '.chip .n');
    textifyInputs(origGrid, grid, '.chip .p');
    markScalableGroup(origHead, head, 'h1, p');

    head.querySelectorAll('[contenteditable]').forEach((el) => { el.contentEditable = 'false'; });
    grid.querySelectorAll('.chip-tools, .addhere, .addrow, .addline, .kill, .mx-brand .kill, .mx-band .kill').forEach((el) => el.remove());
    grid.querySelectorAll('.chip').forEach((el) => {
      el.classList.remove('sel', 'dragging');
      // .chip 自带一个 0.3s 的进场动画（从透明淡入），cloneNode 出来的
      // 是全新节点，重新插入文档后浏览器会把这个动画重新播放一遍——
      // html2canvas 如果刚好在动画播放到一半时截图，画面就会是"整体
      // 蒙了一层"的半透明状态，这就是反馈里"灰蒙蒙像罩了层东西"的
      // 真正原因。导出的是静态快照，不需要这个动画，直接关掉。
      el.style.animation = 'none';
    });

    // 导出底色跟随当前主题的纸面色（纸面已双主题化，不再固定米白）——
    // 冻结的格子/文字色都取自当前主题，底色不跟着走会拼出阴阳图
    const paperBg = (getComputedStyle(A.$('#matrix-canvas')).getPropertyValue('--paper') || '').trim() || '#fdfaf3';
    const wrap = document.createElement('div');
    wrap.className = 'paper matrix-export-shot';
    wrap.style.cssText = 'position:fixed; left:-99999px; top:0; width:max-content; background:' + paperBg + ';';
    wrap.dataset.exportBg = paperBg;
    wrap.append(head, grid, legend);
    document.body.appendChild(wrap);
    return { wrap, head, grid, legend };
  }

  /**
   * 先挑字号、再调列宽，两个旋钮一起找一个能让"表格主体"塞进合适
   * 比例的方案：
   *   1. 从最大字号挡位试起，每挡字号下都用列宽收窄去够比例——
   *      字号不变时收窄列宽是唯一能让内容变"瘦"的办法。
   *   2. 收到 COL_MIN 还是比目标宽，说明这挡字号放不下，降一挡重试。
   *   3. 找到能装下的字号后，如果内容反而比目标更瘦高（品牌少、
   *      价格带多），再把列宽放宽一点，让图更"扁"，减少留白。
   * 这里的"目标比例"不是直接的 16:9——标题和图例最后会完整绘制、
   * 不参与裁切（它们只出现一次，哪怕只裁掉一点点也是整段消失，
   * 跟裁一点表格边缘完全不是一个风险等级），所以表格主体分到的
   * 高度要先把标题+图例预留掉的那部分扣掉，算出的目标会比 16:9
   * 略"宽"一点，这样表格主体和标题图例的高度加起来才正好是 16:9。
   * 返回值只用来决定导出后的提示文案。
   */
  function fitScaleAndColumns(wrap, head, grid, legend) {
    const brands = M().brands.length;
    if (!brands) return { adjusted: false, scale: 1 };
    const setCols = (w) => { grid.style.gridTemplateColumns = `130px repeat(${brands}, ${w}px)`; };
    const aspect = () => grid.scrollWidth / grid.scrollHeight;
    const gridTarget = () => {
      const s = EXPORT_W / grid.scrollWidth;
      const extraH = (head.scrollHeight + legend.scrollHeight) * s;
      return EXPORT_W / Math.max(1, EXPORT_H - extraH);
    };

    // 图例字号现在由 fitLegendScale() 单独最大化（不跟着主表挡位走，见下方
    // 函数注释），所以这里只对 head/grid 调字号——legend 这时还是基准尺寸，
    // gridTarget() 拿它当前（偏小的）高度估算主表要让出的空间，等图例后续
    // 独立放大之后总高度会比这个估算更高，成图可能会比 16:9 略"方"一点、
    // 四周多一点点背景色留边，这是用户明确要的取舍：图例的可读性优先于
    // 严丝合缝地贴满 16:9。
    let scale = FONT_SCALE_MAX, w = COL_START;
    for (;;) {
      applyFontScale(head, scale);
      applyFontScale(grid, scale);
      w = COL_START;
      setCols(w);
      let target = gridTarget();
      while (w > COL_MIN && aspect() > target * 1.08) { w -= COL_STEP; setCols(w); target = gridTarget(); }
      while (w < COL_MAX && aspect() < target * 0.92) { w += COL_STEP; setCols(w); target = gridTarget(); }
      if ((aspect() >= target * 0.92 && aspect() <= target * 1.08) || scale <= FONT_SCALE_MIN + 1e-9) break;
      scale = +(scale - FONT_SCALE_STEP).toFixed(2);
    }

    return { adjusted: w !== COL_START || scale !== FONT_SCALE_MAX, scale };
  }

  const LEGEND_SCALE_MAX = 3.4, LEGEND_SCALE_MIN = 1, LEGEND_SCALE_STEP = 0.1;
  const LEGEND_MAX_ROWS = 2; // 分类一般不多，最多允许折两行，再多就太占地方、反而不好读

  /** 按 offsetTop 分组数行——同一行内 flex 项顶部会因为 gap/放大后的字号
   *  产生几像素的抖动，用 4px 网格取整吸收掉，避免把同一行误判成两行。 */
  function legendRowCount(legend) {
    const items = [...legend.children];
    if (!items.length) return 0;
    const tops = new Set(items.map((el) => Math.round(el.offsetTop / 4) * 4));
    return tops.size;
  }

  /** 图例不跟主表的字号绑在一起放大——主表要顾及列宽塞不塞得下，字号经常
   *  被压得比较小；图例通常就几个分类，没有这层限制，应该在自己能占到的
   *  宽度里独立放到尽量大、尽量好认，不用管是不是跟主表"比例一致"。
   *  策略很直接：字号一档一档往上试，装到要折出第 3 行才收手退回一档。 */
  function fitLegendScale(legend) {
    let scale = LEGEND_SCALE_MAX;
    for (; scale > LEGEND_SCALE_MIN + 1e-9; scale = +(scale - LEGEND_SCALE_STEP).toFixed(2)) {
      applyFontScale(legend, scale);
      if (legendRowCount(legend) <= LEGEND_MAX_ROWS) return scale;
    }
    applyFontScale(legend, LEGEND_SCALE_MIN);
    return LEGEND_SCALE_MIN;
  }

  async function exportPNG() {
    if (typeof html2canvas !== 'function') { A.toast('导出组件没加载成功，刷新页面再试一次', 'bad'); return; }
    const btn = A.$('#matrix-export-btn');
    btn.disabled = true; btn.textContent = '生成中…';
    let clone;
    try {
      clone = buildExportClone();
      const fit = fitScaleAndColumns(clone.wrap, clone.head, clone.grid, clone.legend);
      // 外层容器原来靠 width:max-content 撑宽度——但 flex-wrap 容器算"自然宽度"
      // 是按不换行、摆成一整排来算的（CSS 规范如此，跟它实际会不会换行无关）。
      // 图例字号一放大，这个"假装不换行"的自然宽度就可能比主表还宽，容器被
      // 图例撑宽之后，主表右边空出一大截；整张图等比塞进 4K 画布时又要整体
      // 缩小更多，上下也跟着空出大片留白。这里把容器宽度显式钉死成主表的
      // 实际宽度，图例才会真的在这个宽度内换行，而不是把容器反过来撑宽。
      // wrap 是 .paper，box-sizing:border-box 下自带左右 padding（styles.css
      // 里是 30px+30px）。如果直接把 width 钉成 grid.scrollWidth，这段 padding
      // 会从里面"抠"掉，content-box 比 grid 实际需要的宽度还窄 60px，网格右侧
      // 最后一列就会溢出 wrap 自身的包围盒——而 html2canvas 截图时用的正是
      // wrap.getBoundingClientRect() 来定尺寸，溢出包围盒的部分根本不在截图
      // 范围内，导出图上看到的就是最后几列被整齐地切掉一块。这里把 wrap 自己
      // 的左右 padding 加回宽度里，content-box 才会跟 grid.scrollWidth 对齐。
      const wrapPadX = parseFloat(getComputedStyle(clone.wrap).paddingLeft) + parseFloat(getComputedStyle(clone.wrap).paddingRight);
      clone.wrap.style.width = (clone.grid.scrollWidth + wrapPadX) + 'px';
      fitLegendScale(clone.legend); // 主表定型之后再把图例独立放大到最大最清晰

      const shot = await html2canvas(clone.wrap, { backgroundColor: clone.wrap.dataset.exportBg, scale: 2, useCORS: true, logging: false });

      const out = document.createElement('canvas');
      out.width = EXPORT_W; out.height = EXPORT_H;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = clone.wrap.dataset.exportBg;
      ctx.fillRect(0, 0, EXPORT_W, EXPORT_H);
      // 等比缩放，取能让内容完整装进画布的那个缩放系数（不裁任何
      // 东西）——宁可留一点点边，也不能拉伸变形或裁掉标题/表头/
      // 数据。留出来的边用背景色天然融合（跟画布底色一致），基本
      // 看不出来：字号+列宽搜索已经把内容比例带到接近 16:9 了，
      // 残差很小，不会是那种大片违和的空白。
      const fitScale = Math.min(EXPORT_W / shot.width, EXPORT_H / shot.height);
      const drawW = shot.width * fitScale, drawH = shot.height * fitScale;
      ctx.drawImage(shot, 0, 0, shot.width, shot.height, (EXPORT_W - drawW) / 2, (EXPORT_H - drawH) / 2, drawW, drawH);

      const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `价格带沙盘_${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);

      const notes = [];
      if (fit.scale > 1) notes.push(`字号放大到 ${fit.scale.toFixed(1)}×`);
      if (fit.adjusted) notes.push('自动调整了列宽以适配 16:9');
      A.toast(notes.length ? `已导出 PNG（${notes.join('，')}）` : '已导出 PNG');
    } catch (e) {
      A.toast('导出失败：' + e.message, 'bad');
    } finally {
      clone?.wrap.remove();
      btn.disabled = false; btn.textContent = '⭳ 导出 PNG（16:9）';
    }
  }

  /**
   * 图例/分类编辑、统计、新增品牌/价格带都挪进画布本身了（图例可以直接
   * 编辑、品牌行/价格带列末尾加号新增），标题行只留一个纯文字的说明
   * 图标——鼠标移上去悬浮展开，面板里没有任何可交互控件，纯 hover 就够。
   */
  function wireInfoPanel() {
    const wrap = A.$('#mx-info-wrap'), btn = A.$('#mx-info-btn'), panel = A.$('#mx-info-panel');
    let closeTimer = null;
    const open = () => { clearTimeout(closeTimer); panel.hidden = false; wrap.classList.add('on'); };
    const close = () => { panel.hidden = true; wrap.classList.remove('on'); };
    const scheduleClose = () => { clearTimeout(closeTimer); closeTimer = setTimeout(close, 260); };
    wrap.addEventListener('mouseenter', open);
    wrap.addEventListener('mouseleave', scheduleClose);
    btn.addEventListener('click', (e) => { e.stopPropagation(); panel.hidden ? open() : scheduleClose(); });
    document.addEventListener('click', (e) => { if (!panel.hidden && !wrap.contains(e.target)) close(); });
  }

  /* ── 初始化 ─────────────────────────────────────────── */
  function init(api) {
    A = api;

    A.$('#matrix-export-btn').onclick = exportPNG;

    wireInfoPanel();
    wireMarquee();
    wireBatchBar();
  }

  return { init, render, clearSelection: clearSel };
})();
