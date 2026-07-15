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
  // "新品" 不是写死的分类，是用户自己在分类编辑里建的——分类名里带"新品"或"new"
  // 字样就自动在卡片上加显眼的 New 角标，不需要每个产品再单独标一次
  const isNewTag = (tag) => hasTag(tag) && /新品|new/i.test(M().tags[tag].label || '');

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
    el.className = 'chip' + (p.italic ? ' i' : '') + (p.underline ? ' u' : '') + (sel.has(p.id) ? ' sel' : '') + (tagged ? ' filled' : '');
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

    if (isNewTag(p.tag)) {
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
    // 跟拖拽整批移动（idsInFlight）同样的道理：这张卡片如果本来就在
    // 多选选区里，点它自己的改分类按钮也该对整批生效，不能只改这一个——
    // 不然用户框选一堆卡片后随手点其中一张的分类按钮，会发现只有点到
    // 的那张变了色，其余选中的都没变，很容易被当成"批量改分类坏了"。
    dot.onclick = (e) => { e.stopPropagation(); openTagMenu(e.currentTarget, idsInFlight(p.id)); };

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
  function applyFontScale(root, scale) {
    root.querySelectorAll('[data-base-fs]').forEach((el) => {
      el.style.fontSize = (parseFloat(el.dataset.baseFs) * scale).toFixed(2) + 'px';
      el.style.lineHeight = (parseFloat(el.dataset.baseLh) * scale).toFixed(2) + 'px';
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
  const LEGEND_FREEZE = [{ selector: 'span', props: ['color'] }];

  /** h1/副标题、图例文字也要跟着放大——不止表格里的内容 */
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

  function buildExportClone() {
    const origHead = A.$('#matrix-canvas .paper-head');
    const origGrid = A.$('#matrix');
    const origLegend = A.$('#legend');

    const head = origHead.cloneNode(true);
    const grid = origGrid.cloneNode(true);
    const legend = origLegend.cloneNode(true);

    freezeColors(origHead, head, HEAD_FREEZE);
    freezeColors(origGrid, grid, GRID_FREEZE);
    freezeColors(origLegend, legend, LEGEND_FREEZE);

    textifyInputs(origGrid, grid, '.mx-brand input');
    textifyInputs(origGrid, grid, '.mx-band input');
    textifyInputs(origGrid, grid, '.chip .n');
    textifyInputs(origGrid, grid, '.chip .p');
    markScalableGroup(origHead, head, 'h1, p');
    markScalableGroup(origLegend, legend, 'span');

    head.querySelector('#matrix-export-btn')?.remove(); // 按钮现在跟标题同一行，克隆时得摘掉，不然会截进图里
    head.querySelectorAll('[contenteditable]').forEach((el) => { el.contentEditable = 'false'; });
    grid.querySelectorAll('.chip-tools, .addhere, .addrow, .addline, .kill, .mx-brand .kill').forEach((el) => el.remove());
    grid.querySelectorAll('.chip').forEach((el) => el.classList.remove('sel', 'dragging'));

    const wrap = document.createElement('div');
    wrap.className = 'paper matrix-export-shot';
    wrap.style.cssText = 'position:fixed; left:-99999px; top:0; width:max-content; background:#fdfaf3;';
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

    let scale = FONT_SCALE_MAX, w = COL_START;
    for (;;) {
      applyFontScale(wrap, scale);
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

  async function exportPNG() {
    if (typeof html2canvas !== 'function') { A.toast('导出组件没加载成功，刷新页面再试一次', 'bad'); return; }
    const btn = A.$('#matrix-export-btn');
    btn.disabled = true; btn.textContent = '生成中…';
    let clone;
    try {
      clone = buildExportClone();
      const fit = fitScaleAndColumns(clone.wrap, clone.head, clone.grid, clone.legend);

      const shot = await html2canvas(clone.wrap, { backgroundColor: '#fdfaf3', scale: 2, useCORS: true, logging: false });

      const out = document.createElement('canvas');
      out.width = EXPORT_W; out.height = EXPORT_H;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#fdfaf3';
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

  /* ── 初始化 ─────────────────────────────────────────── */
  function init(api) {
    A = api;

    A.$('#matrix-export-btn').onclick = exportPNG;

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
