/* report-slides.js — 个人报告自定义页：零依赖 PPT 式画布编辑器 */
const ReportSlides = (() => {
  'use strict';
  const W = 1280, H = 720, DEFAULT_FONT_SIZE = 28, DEFAULT_SLIDE_TITLE = '未命名页面', BODY_TOP = 100;
  const MASTER_LEFT_IMAGE = '/uploads/56a87e70285cdea7e6.png';
  const MASTER_RIGHT_IMAGE = '/uploads/6f73ccc2f49d28a04c.png';
  const LEGACY_MASTER_IMAGE_URLS = new Set([MASTER_LEFT_IMAGE, MASTER_RIGHT_IMAGE, '/uploads/7c38a67eae0f6f377d.png']);
  const SHAPE_TYPES = [['rect', '矩形'], ['ellipse', '椭圆'], ['line', '直线']];
  const SYMBOLS = ['★', '☆', '●', '○', '■', '□', '▲', '▼', '◆', '◇', '✓', '✗', '→', '←', '↑', '↓', '⇒', '➤', '①', '②', '③', '❗', '⚠', '§'];
  const DEFAULT_SHAPE_FILL = '#4ee0c1', DEFAULT_SHAPE_STROKE = '#1f9e85';
  let A, pages = [], pageId = null, host, presenting = false, readOnly = false, selectedId = null, editingId = null, masterVersion = 1;
  let saveTimer = null, saving = false, queued = false, pendingPageOrder = null, saveHandler = null, pageActions = {}, resizeObserver = null;

  const currentPage = () => pages.find((p) => p.id === pageId) || null;
  const uid = (prefix) => A.uid(prefix);
  const call = async (url, opts) => {
    const r = A.guard(await fetch(url, opts)); const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '请求失败'); return j;
  };
  const nextZ = (page) => Math.max(0, ...page.elements.map((el) => Number(el.z) || 0)) + 1;
  const canvasScale = () => host.querySelector('.rs-canvas')?.getBoundingClientRect().width / W || 1;

  function isLegacyMasterElement(el, hasLegacyMaster) {
    if (el?.type === 'image') return LEGACY_MASTER_IMAGE_URLS.has(el.url);
    return !!(hasLegacyMaster && el?.type === 'text' && Number(el.y) < 80 && Number(el.x) >= 70 && Number(el.x) <= 320);
  }
  function migrateSlideMaster(page) {
    const elements = Array.isArray(page?.elements) ? page.elements : [];
    const hasLegacyMaster = elements.some((el) => el?.type === 'image' && LEGACY_MASTER_IMAGE_URLS.has(el.url));
    const legacyTitle = hasLegacyMaster && elements.find((el) => el?.type === 'text' && Number(el.y) < 80 && Number(el.x) >= 70 && Number(el.x) <= 320);
    const title = String(page?.title || legacyTitle?.text || DEFAULT_SLIDE_TITLE).trim() || DEFAULT_SLIDE_TITLE;
    return { ...page, title, elements: hasLegacyMaster ? elements.filter((el) => !isLegacyMasterElement(el, hasLegacyMaster)) : elements };
  }

  function scheduleSave() {
    if (presenting || readOnly) return;
    clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 600);
  }
  async function flushSave() {
    if (saving) { queued = true; return; }
    saving = true;
    const pageOrder = pendingPageOrder; pendingPageOrder = null;
    try {
      if (saveHandler) await saveHandler({ slides: pages, ...(pageOrder ? { pageOrder } : {}) });
      else await call('/api/reports/personal/slides/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slides: pages, ...(pageOrder ? { pageOrder } : {}) }) });
    }
    catch (e) { A.toast('自定义页保存失败：' + e.message, 'bad'); }
    finally { saving = false; if (queued) { queued = false; flushSave(); } }
  }

  function mkBtn(label, fn, title) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost rs-toolbar-btn';
    b.textContent = label; if (title) b.title = title; b.onclick = fn; return b;
  }
  function mkSelect(placeholder, options, onPick) {
    const sel = document.createElement('select'); sel.className = 'rs-toolbar-select'; sel.setAttribute('aria-label', placeholder.replace(/…$/, ''));
    const ph = document.createElement('option'); ph.value = ''; ph.textContent = placeholder; ph.disabled = true; ph.selected = true; sel.appendChild(ph);
    options.forEach(([value, label]) => { const opt = document.createElement('option'); opt.value = value; opt.textContent = label; sel.appendChild(opt); });
    sel.onchange = () => { if (sel.value) onPick(sel.value); sel.value = ''; };
    return sel;
  }
  function mountPage(id) { pageId = id; selectedId = null; editingId = null; render(); }
  function unmountPage() { pageId = null; selectedId = null; editingId = null; if (host) host.replaceChildren(); }
  function setPages(nextPages) {
    const incoming = Array.isArray(nextPages) ? nextPages : [];
    pages = incoming.map(migrateSlideMaster);
    if (JSON.stringify(pages) !== JSON.stringify(incoming) && !readOnly) scheduleSave();
    if (pageId && !currentPage()) unmountPage();
  }
  function getPages() { return pages; }
  function addPage() { const page = { id: uid('pg_'), name: '', title: '未命名页面', elements: [] }; pages.push(page); scheduleSave(); return page; }
  function deletePage(id) { const at = pages.findIndex((p) => p.id === id); if (at < 0) return false; pages.splice(at, 1); if (pageId === id) unmountPage(); scheduleSave(); return true; }
  function renamePage(id, name) { const page = pages.find((item) => item.id === id); if (!page) return false; page.name = String(name || '').trim().slice(0, 40); scheduleSave(); return true; }

  function render() {
    const page = currentPage(); if (!host || !page) return;
    host.replaceChildren();
    const shell = document.createElement('div'); shell.className = 'rs-shell' + (presenting ? ' presenting' : '');
    if (!presenting && !readOnly) shell.appendChild(renderToolbar(page));
    const viewport = document.createElement('div'); viewport.className = 'rs-viewport';
    const canvas = document.createElement('div'); canvas.className = 'rs-canvas'; canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', onCanvasPointerDown);
    if (masterVersion > 0) canvas.appendChild(buildSlideMaster(page, { editable: !presenting && !readOnly }));
    page.elements.slice().sort((a, b) => a.z - b.z).forEach((el) => canvas.appendChild(buildElementNode(el)));
    viewport.appendChild(canvas); shell.appendChild(viewport); host.appendChild(shell);
    requestAnimationFrame(scaleCanvas);
  }
  function scaleCanvas() {
    const viewport = host?.querySelector('.rs-viewport'), canvas = host?.querySelector('.rs-canvas');
    if (!viewport || !canvas) return;
    canvas.style.transform = `scale(${Math.min(viewport.clientWidth / W, viewport.clientHeight / H)})`;
  }
  function renderToolbar(page) {
    const bar = document.createElement('div'); bar.className = 'rs-toolbar'; const el = page.elements.find((x) => x.id === selectedId);
    const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    bar.append(
      mkBtn(fullscreen ? '退出全屏编辑' : '全屏编辑', toggleEditFullscreen, fullscreen ? '退出全屏编辑' : '放大当前画布进行编辑'),
      mkBtn('新建文字', addTextElement), mkBtn('插入图片', insertImage, '也可直接按 Ctrl+V 粘贴图片'),
      mkSelect('插入形状…', SHAPE_TYPES, addShapeElement), mkSelect('插入符号…', SYMBOLS.map((s) => [s, s]), addSymbolElement)
    );
    [['复制', duplicateSelected, 'Ctrl/Cmd+D 复制选中元素'], ['水平居中', centerHorizontal], ['垂直居中', centerVertical], ['置顶', bringToFront], ['置底', sendToBack], ['删除', deleteSelected, 'Delete 删除选中元素']].forEach(([l, fn, title]) => { const b = mkBtn(l, fn, title); b.disabled = !el; bar.appendChild(b); });
    if (el?.type === 'text') {
      const edit = mkBtn('编辑文字', () => enterTextEdit(el)); edit.disabled = editingId === el.id; bar.appendChild(edit);
      const size = document.createElement('input'); size.type = 'number'; size.min = '10'; size.max = '160'; size.className = 'rs-toolbar-size'; size.value = el.fontSize || DEFAULT_FONT_SIZE;
      size.onchange = () => { el.fontSize = Math.max(10, Math.min(160, Number(size.value) || DEFAULT_FONT_SIZE)); scheduleSave(); render(); }; bar.appendChild(size);
      const color = document.createElement('input'); color.type = 'color'; color.className = 'rs-toolbar-color'; color.value = el.color || '#808080';
      color.oninput = () => { el.color = color.value; scheduleSave(); const box = host.querySelector('.rs-text'); if (box) box.style.color = el.color; }; bar.appendChild(color);
      [['B', 'bold'], ['I', 'italic']].forEach(([label, key]) => { const b = mkBtn(label, () => { el[key] = !el[key]; scheduleSave(); render(); }); b.classList.toggle('on', !!el[key]); bar.appendChild(b); });
      [['left', '左'], ['center', '中'], ['right', '右']].forEach(([align, label]) => { const b = mkBtn(label, () => { el.align = align; scheduleSave(); render(); }); b.classList.toggle('on', (el.align || 'left') === align); bar.appendChild(b); });
    } else if (el?.type === 'shape') {
      if (el.shapeType !== 'line') {
        const fill = document.createElement('input'); fill.type = 'color'; fill.className = 'rs-toolbar-color'; fill.title = '填充色'; fill.value = /^#/.test(el.fill || '') ? el.fill : DEFAULT_SHAPE_FILL;
        fill.oninput = () => { el.fill = fill.value; scheduleSave(); const shape = host.querySelector(`.rs-el[data-id="${el.id}"] .rs-shape`); if (shape) shape.style.background = el.fill; }; bar.appendChild(fill);
      }
      const stroke = document.createElement('input'); stroke.type = 'color'; stroke.className = 'rs-toolbar-color'; stroke.title = el.shapeType === 'line' ? '线条颜色' : '边框颜色'; stroke.value = /^#/.test(el.stroke || '') ? el.stroke : DEFAULT_SHAPE_STROKE;
      stroke.oninput = () => {
        el.stroke = stroke.value; scheduleSave();
        const shape = host.querySelector(`.rs-el[data-id="${el.id}"] .rs-shape`); if (!shape) return;
        if (el.shapeType === 'line') shape.style.background = el.stroke; else shape.style.borderColor = el.stroke;
      }; bar.appendChild(stroke);
      const width = document.createElement('input'); width.type = 'number'; width.min = '0'; width.max = '40'; width.className = 'rs-toolbar-size'; width.title = el.shapeType === 'line' ? '线条粗细' : '边框粗细'; width.value = el.strokeWidth || 0;
      width.onchange = () => { el.strokeWidth = Math.max(0, Math.min(40, Number(width.value) || 0)); scheduleSave(); render(); }; bar.appendChild(width);
    }
    const actions = document.createElement('div'); actions.className = 'rs-toolbar-page-actions';
    const rename = mkBtn('重命名', () => pageActions.rename?.(page.id)); rename.classList.add('rs-toolbar-page-rename'); actions.appendChild(rename);
    const remove = mkBtn('删除页面', () => pageActions.delete?.(page.id)); remove.classList.add('rs-toolbar-page-delete'); actions.appendChild(remove);
    bar.appendChild(actions);
    return bar;
  }
  function updateToolbar() {
    if (presenting || readOnly) return;
    const old = host?.querySelector('.rs-toolbar'), page = currentPage();
    if (old && page) old.replaceWith(renderToolbar(page));
  }
  function buildSlideMaster(page, { editable = false } = {}) {
    const master = document.createElement('div'); master.className = 'rs-slide-master' + (editable ? ' editable' : '');
    const left = document.createElement('img'); left.className = 'rs-slide-master-brand rs-slide-master-brand-left'; left.src = MASTER_LEFT_IMAGE; left.alt = '';
    const title = document.createElement(editable ? 'input' : 'div'); title.className = 'rs-slide-title';
    if (editable) { title.type = 'text'; title.value = page.title || DEFAULT_SLIDE_TITLE; }
    else title.textContent = page.title || DEFAULT_SLIDE_TITLE;
    const right = document.createElement('img'); right.className = 'rs-slide-master-brand rs-slide-master-brand-right'; right.src = MASTER_RIGHT_IMAGE; right.alt = '';
    const line = document.createElement('div'); line.className = 'rs-slide-master-line';
    if (editable) {
      title.maxLength = 80; title.spellcheck = false; title.setAttribute('aria-label', '页面标题');
      title.addEventListener('pointerdown', (e) => e.stopPropagation());
      title.addEventListener('input', () => { page.title = title.value; scheduleSave(); });
      title.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); title.blur(); } });
    }
    master.append(left, title, right, line); return master;
  }
  function buildShapeNode(el) {
    const shape = document.createElement('div'); shape.className = 'rs-shape rs-shape-' + el.shapeType;
    if (el.shapeType === 'line') Object.assign(shape.style, { background: el.stroke || DEFAULT_SHAPE_STROKE, height: (el.strokeWidth || 4) + 'px' });
    else Object.assign(shape.style, { background: el.fill && el.fill !== 'none' ? el.fill : 'transparent', borderColor: el.stroke || 'transparent', borderWidth: (el.strokeWidth || 0) + 'px' });
    return shape;
  }
  function buildElementNode(el) {
    const node = document.createElement('div'); node.className = 'rs-el' + (el.id === selectedId ? ' sel' : ''); node.dataset.id = el.id;
    Object.assign(node.style, { left: el.x + 'px', top: el.y + 'px', width: el.w + 'px', height: el.h + 'px', zIndex: el.z });
    node.addEventListener('pointerdown', (e) => startMove(e, el));
    if (el.type === 'text') {
      const isEditing = editingId === el.id;
      const box = document.createElement(isEditing ? 'textarea' : 'div'); box.className = 'rs-text' + (isEditing ? ' rs-text-editor' : '');
      if (isEditing) { box.value = el.text; box.setAttribute('aria-label', '编辑文字内容'); }
      else box.textContent = el.text;
      Object.assign(box.style, { fontSize: (el.fontSize || DEFAULT_FONT_SIZE) + 'px', color: el.color || 'var(--text)', fontWeight: el.bold ? '700' : '400', fontStyle: el.italic ? 'italic' : 'normal', textAlign: el.align || 'left' });
      if (!presenting && !readOnly) {
        node.addEventListener('dblclick', (e) => { e.stopPropagation(); enterTextEdit(el); });
        if (isEditing) {
          box.addEventListener('pointerdown', (e) => e.stopPropagation());
          box.addEventListener('input', () => { el.text = box.value.slice(0, 4000); autoGrowHeight(box, el); scheduleSave(); });
          box.addEventListener('blur', () => commitTextEdit(el));
          box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); box.blur(); } });
        }
      }
      node.appendChild(box);
    } else if (el.type === 'shape') {
      node.appendChild(buildShapeNode(el));
    } else {
      const img = document.createElement('img'); img.className = 'rs-image'; img.src = el.url; img.draggable = false;
      img.classList.toggle('contain', el.fit === 'contain'); node.appendChild(img);
      if (el.preview) {
        node.classList.add('rs-previewable'); node.title = '查看原图'; node.setAttribute('aria-label', el.previewTitle || '查看原图');
        node.addEventListener(presenting ? 'click' : 'dblclick', (e) => { e.preventDefault(); e.stopPropagation(); A.lightbox(el.url, el.previewTitle || '查看原图'); });
      }
    }
    if (!presenting && !readOnly && el.id === selectedId) attachHandles(node, el);
    return node;
  }
  function buildPrintPage(id) {
    const page = pages.find((item) => item.id === id); if (!page) return null;
    const section = document.createElement('section'); section.className = 'rpt-page rpt-pdf-custom-page'; section.dataset.pageId = page.id;
    const canvas = document.createElement('div'); canvas.className = 'rs-canvas';
    if (masterVersion > 0) canvas.appendChild(buildSlideMaster(page, { print: true }));
    page.elements.slice().sort((a, b) => a.z - b.z).forEach((el) => {
      const node = document.createElement('div'); node.className = 'rs-el';
      Object.assign(node.style, { left: el.x + 'px', top: el.y + 'px', width: el.w + 'px', height: el.h + 'px', zIndex: el.z });
      if (el.type === 'text') {
        const box = document.createElement('div'); box.className = 'rs-text'; box.textContent = el.text;
        Object.assign(box.style, { fontSize: (el.fontSize || DEFAULT_FONT_SIZE) + 'px', color: el.color || 'var(--text)', fontWeight: el.bold ? '700' : '400', fontStyle: el.italic ? 'italic' : 'normal', textAlign: el.align || 'left' });
        node.appendChild(box);
      } else if (el.type === 'shape') { node.appendChild(buildShapeNode(el)); }
      else { const img = document.createElement('img'); img.className = 'rs-image'; img.src = el.url; img.alt = ''; img.classList.toggle('contain', el.fit === 'contain'); node.appendChild(img); }
      canvas.appendChild(node);
    });
    section.appendChild(canvas); return section;
  }
  function onCanvasPointerDown(e) { if (e.target === e.currentTarget) { selectedId = null; editingId = null; render(); } }
  function startMove(e, el) {
    if (presenting || readOnly || editingId === el.id || e.target.classList.contains('rs-handle')) return;
    e.stopPropagation(); selectedId = el.id;
    host.querySelectorAll('.rs-el.sel').forEach((node) => { node.classList.remove('sel'); node.querySelectorAll('.rs-handle').forEach((handle) => handle.remove()); });
    e.currentTarget.classList.add('sel'); attachHandles(e.currentTarget, el); updateToolbar();
    const sx = e.clientX, sy = e.clientY, ox = el.x, oy = el.y, k = canvasScale();
    const move = (m) => { el.x = Math.round(ox + (m.clientX - sx) / k); el.y = Math.round(oy + (m.clientY - sy) / k); const n = host.querySelector(`.rs-el[data-id="${el.id}"]`); if (n) { n.style.left = el.x + 'px'; n.style.top = el.y + 'px'; } };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); scheduleSave(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }
  function attachHandles(node, el) {
    const isLine = el.type === 'shape' && el.shapeType === 'line';
    const handles = el.type === 'text' || isLine ? ['l', 'r'] : ['nw', 'ne', 'sw', 'se'];
    handles.forEach((side) => {
      const h = document.createElement('div'); h.className = 'rs-handle rs-handle-' + side;
      h.addEventListener('pointerdown', (e) => {
        if (el.type === 'text') startTextResize(e, el, side);
        else if (isLine) startLineResize(e, el, side);
        else if (el.type === 'shape') startShapeResize(e, el, side);
        else startImageResize(e, el, side);
      });
      node.appendChild(h);
    });
  }
  function startTextResize(e, el, side) {
    e.stopPropagation(); const sx = e.clientX, ox = el.x, ow = el.w, k = canvasScale(); const node = host.querySelector(`.rs-el[data-id="${el.id}"]`);
    const move = (m) => { const dx = (m.clientX - sx) / k; const width = Math.max(60, side === 'r' ? ow + dx : ow - dx); el.w = width; if (side === 'l') el.x = ox + ow - width; if (node) { node.style.left = el.x + 'px'; node.style.width = width + 'px'; autoGrowHeight(node.querySelector('.rs-text'), el); } };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); scheduleSave(); }; document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }
  function startImageResize(e, el, corner) {
    e.stopPropagation(); const sx = e.clientX, ox = el.x, oy = el.y, ow = el.w, oh = el.h, ratio = ow / oh, k = canvasScale(); const node = host.querySelector(`.rs-el[data-id="${el.id}"]`);
    const move = (m) => { const dx = ((m.clientX - sx) / k) * (corner.includes('w') ? -1 : 1); const width = Math.max(24, ow + dx), height = width / ratio; el.w = width; el.h = height; if (corner.includes('w')) el.x = ox + ow - width; if (corner.includes('n')) el.y = oy + oh - height; if (node) Object.assign(node.style, { left: el.x + 'px', top: el.y + 'px', width: width + 'px', height: height + 'px' }); };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); scheduleSave(); }; document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }
  function startLineResize(e, el, side) {
    e.stopPropagation(); const sx = e.clientX, ox = el.x, ow = el.w, k = canvasScale(); const node = host.querySelector(`.rs-el[data-id="${el.id}"]`);
    const move = (m) => { const dx = (m.clientX - sx) / k; const width = Math.max(20, side === 'r' ? ow + dx : ow - dx); el.w = width; if (side === 'l') el.x = ox + ow - width; if (node) { node.style.left = el.x + 'px'; node.style.width = width + 'px'; } };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); scheduleSave(); }; document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }
  function startShapeResize(e, el, corner) {
    e.stopPropagation(); const sx = e.clientX, sy = e.clientY, ox = el.x, oy = el.y, ow = el.w, oh = el.h, k = canvasScale(); const node = host.querySelector(`.rs-el[data-id="${el.id}"]`);
    const move = (m) => {
      const dx = (m.clientX - sx) / k, dy = (m.clientY - sy) / k;
      let width = ow, height = oh, x = ox, y = oy;
      if (corner.includes('e')) width = Math.max(20, ow + dx); else if (corner.includes('w')) { width = Math.max(20, ow - dx); x = ox + ow - width; }
      if (corner.includes('s')) height = Math.max(20, oh + dy); else if (corner.includes('n')) { height = Math.max(20, oh - dy); y = oy + oh - height; }
      el.x = x; el.y = y; el.w = width; el.h = height;
      if (node) Object.assign(node.style, { left: x + 'px', top: y + 'px', width: width + 'px', height: height + 'px' });
    };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); scheduleSave(); }; document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }
  function autoGrowHeight(box, el) { if (!box) return; box.style.height = 'auto'; el.h = Math.max(34, box.scrollHeight); const node = box.closest('.rs-el'); if (node) node.style.height = el.h + 'px'; }
  function enterTextEdit(el) {
    if (presenting || readOnly) return;
    selectedId = editingId = el.id; render();
    const box = host.querySelector(`.rs-el[data-id="${el.id}"] .rs-text`); if (!box) return;
    box.focus(); box.select?.();
  }
  function commitTextEdit(el) { if (editingId === el.id) editingId = null; scheduleSave(); render(); }
  function addTextElement() { const page = currentPage(); if (!page || presenting || readOnly) return; const el = { id: uid('el_'), type: 'text', x: 160, y: BODY_TOP, w: 420, h: 42, z: nextZ(page), text: '双击编辑文字', fontSize: DEFAULT_FONT_SIZE, color: null, bold: false, italic: false, align: 'left' }; page.elements.push(el); selectedId = el.id; scheduleSave(); render(); enterTextEdit(el); }
  function addShapeElement(shapeType) {
    const page = currentPage(); if (!page || presenting || readOnly) return;
    const isLine = shapeType === 'line';
    const w = isLine ? 300 : 240, h = isLine ? 20 : 160;
    const el = {
      id: uid('el_'), type: 'shape', shapeType, x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h, z: nextZ(page),
      fill: isLine ? null : DEFAULT_SHAPE_FILL, stroke: DEFAULT_SHAPE_STROKE, strokeWidth: isLine ? 4 : 2
    };
    page.elements.push(el); selectedId = el.id; scheduleSave(); render();
  }
  function addSymbolElement(symbol) {
    const page = currentPage(); if (!page || presenting || readOnly || !symbol) return;
    const el = { id: uid('el_'), type: 'text', x: Math.round((W - 80) / 2), y: Math.round((H - 80) / 2), w: 80, h: 80, z: nextZ(page), text: symbol, fontSize: 56, color: null, bold: false, italic: false, align: 'center' };
    page.elements.push(el); selectedId = el.id; scheduleSave(); render();
  }
  function duplicateSelected() {
    const page = currentPage(), el = page?.elements.find((x) => x.id === selectedId);
    if (!page || !el || presenting || readOnly) return;
    const copy = { ...el, id: uid('el_'), x: el.x + 24, y: el.y + 24, z: nextZ(page) };
    page.elements.push(copy); selectedId = copy.id; scheduleSave(); render();
  }
  function centerHorizontal() { const page = currentPage(), el = page?.elements.find((x) => x.id === selectedId); if (!el || readOnly) return; el.x = Math.round((W - el.w) / 2); scheduleSave(); render(); }
  function centerVertical() { const page = currentPage(), el = page?.elements.find((x) => x.id === selectedId); if (!el || readOnly) return; el.y = Math.round((H - el.h) / 2); scheduleSave(); render(); }
  function onKeydown(e) {
    if (!pageId || presenting || readOnly || editingId) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && selectedId) { e.preventDefault(); duplicateSelected(); return; }
    if (!selectedId) return;
    const page = currentPage(), el = page?.elements.find((x) => x.id === selectedId); if (!el) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); el.x -= step; scheduleSave(); render(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); el.x += step; scheduleSave(); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); el.y -= step; scheduleSave(); render(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); el.y += step; scheduleSave(); render(); }
  }
  async function insertImage() {
    let url; try { url = await A.uploadImage(); } catch (e) { A.toast('图片上传失败：' + e.message, 'bad'); return; } if (!url) return;
    await addImageFromUrl(url);
  }
  async function addImageFromUrl(url) {
    const page = currentPage(); if (!page || presenting || readOnly) return;
    const [nw, nh] = await new Promise((resolve) => { const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.onerror = () => resolve([400, 300]); img.src = url; });
    // PowerPoint 默认宽屏画布为 13.333 × 7.5 英寸；这里按 96dpi 固定成 1280 × 720。
    // 图片原字节上传，并以整页可用区域为初始尺寸，不再被旧的 640px 上限缩小。
    const contentHeight = H - BODY_TOP - 30;
    const scale = Math.min(1, (W - 120) / nw, contentHeight / nh);
    const w = Math.round(nw * scale), h = Math.round(nh * scale);
    const el = { id: uid('el_'), type: 'image', x: Math.round((W - w) / 2), y: BODY_TOP + Math.round((contentHeight - h) / 2), w, h, z: nextZ(page), url, naturalW: nw, naturalH: nh };
    page.elements.push(el); selectedId = el.id; scheduleSave(); render();
  }
  async function pasteImage(e) {
    const page = currentPage();
    if (!page || presenting || readOnly || editingId) return;
    const item = [...(e.clipboardData?.items || [])].find((entry) => /^image\/(png|jpeg|webp)$/.test(entry.type));
    const file = item?.getAsFile();
    if (!file) return;
    e.preventDefault();
    try {
      const url = await A.uploadImageFile(file);
      if (!url) return;
      await addImageFromUrl(url);
      A.toast('已粘贴原图，可直接拖动或缩放');
    } catch (err) { A.toast('粘贴图片失败：' + err.message, 'bad'); }
  }
  function deleteSelected() { const page = currentPage(); if (!page || !selectedId || readOnly) return; page.elements = page.elements.filter((el) => el.id !== selectedId); selectedId = null; scheduleSave(); render(); }
  function bringToFront() { const page = currentPage(), el = page?.elements.find((x) => x.id === selectedId); if (!el || readOnly) return; el.z = nextZ(page); scheduleSave(); render(); }
  function sendToBack() { const page = currentPage(), el = page?.elements.find((x) => x.id === selectedId); if (!el || readOnly) return; el.z = Math.min(...page.elements.map((x) => x.z || 0)) - 1; scheduleSave(); render(); }
  function toggleEditFullscreen() {
    const fullscreenTarget = host; if (!fullscreenTarget || presenting || readOnly) return;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    const enter = fullscreenTarget.requestFullscreen || fullscreenTarget.webkitRequestFullscreen;
    if (document.fullscreenElement || document.webkitFullscreenElement) exit?.call(document);
    else if (enter) enter.call(fullscreenTarget).catch?.(() => A.toast('浏览器拒绝了全屏编辑请求，可按 F11 手动放大', 'bad'));
    else A.toast('这个浏览器不支持全屏编辑，可按 F11 手动放大', 'bad');
  }
  function onFullscreenChange() { if (host?.querySelector('.rs-shell') && !presenting) { updateToolbar(); requestAnimationFrame(scaleCanvas); } }
  function savePageOrder(order) { if (readOnly) return; pendingPageOrder = Array.isArray(order) ? order.slice() : null; scheduleSave(); }
  function setPresenting(value) { presenting = value; if (pageId) render(); }
  function setMasterVersion(value) { masterVersion = Number(value) === 1 ? 1 : 0; if (pageId) render(); }
  function setEditable(value) { readOnly = !value; if (pageId) render(); }
  function setPageActions(actions) { pageActions = actions && typeof actions === 'object' ? actions : {}; }
  function init(api) {
    A = api; host = document.querySelector('#rpt-page-custom');
    // 用 ResizeObserver 而不是只听 window resize：Ctrl+滚轮页面缩放、DevTools 开合等
    // 触发的布局变化不总会派发 window 的 resize 事件，ResizeObserver 直接盯着容器盒子本身。
    if (host && window.ResizeObserver) { resizeObserver = new ResizeObserver(scaleCanvas); resizeObserver.observe(host); }
    else window.addEventListener('resize', scaleCanvas);
    document.addEventListener('paste', pasteImage);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('keydown', onKeydown);
  }
  function setSaveHandler(handler) { saveHandler = typeof handler === 'function' ? handler : null; }
  return { init, setPages, getPages, addPage, deletePage, renamePage, mountPage, unmountPage, setPresenting, setMasterVersion, setEditable, setPageActions, savePageOrder, flushSave, setSaveHandler, buildPrintPage, pageCount: () => pages.length };
})();
