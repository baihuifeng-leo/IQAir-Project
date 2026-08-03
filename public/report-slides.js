/* report-slides.js — 个人报告自定义页：零依赖 PPT 式画布编辑器 */
const ReportSlides = (() => {
  'use strict';
  const W = 1280, H = 720, DEFAULT_FONT_SIZE = 28;
  let A, pages = [], pageId = null, host, presenting = false, selectedId = null, editingId = null;
  let saveTimer = null, saving = false, queued = false, pendingPageOrder = null;

  const currentPage = () => pages.find((p) => p.id === pageId) || null;
  const uid = (prefix) => A.uid(prefix);
  const call = async (url, opts) => {
    const r = A.guard(await fetch(url, opts)); const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '请求失败'); return j;
  };
  const nextZ = (page) => Math.max(0, ...page.elements.map((el) => Number(el.z) || 0)) + 1;
  const canvasScale = () => host.querySelector('.rs-canvas')?.getBoundingClientRect().width / W || 1;

  function scheduleSave() {
    if (presenting) return;
    clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 600);
  }
  async function flushSave() {
    if (saving) { queued = true; return; }
    saving = true;
    const pageOrder = pendingPageOrder; pendingPageOrder = null;
    try { await call('/api/reports/personal/slides/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slides: pages, ...(pageOrder ? { pageOrder } : {}) }) }); }
    catch (e) { A.toast('自定义页保存失败：' + e.message, 'bad'); }
    finally { saving = false; if (queued) { queued = false; flushSave(); } }
  }

  function mkBtn(label, fn, title) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost rs-toolbar-btn';
    b.textContent = label; if (title) b.title = title; b.onclick = fn; return b;
  }
  function mountPage(id) { pageId = id; selectedId = null; editingId = null; render(); }
  function unmountPage() { pageId = null; selectedId = null; editingId = null; if (host) host.replaceChildren(); }
  function setPages(nextPages) { pages = Array.isArray(nextPages) ? nextPages : []; if (pageId && !currentPage()) unmountPage(); }
  function addPage() { const page = { id: uid('pg_'), name: '', elements: [] }; pages.push(page); scheduleSave(); return page; }
  function deletePage(id) { const at = pages.findIndex((p) => p.id === id); if (at < 0) return false; pages.splice(at, 1); if (pageId === id) unmountPage(); scheduleSave(); return true; }
  function renamePage(id, name) { const page = pages.find((item) => item.id === id); if (!page) return false; page.name = String(name || '').trim().slice(0, 40); scheduleSave(); return true; }

  function render() {
    const page = currentPage(); if (!host || !page) return;
    host.replaceChildren();
    const shell = document.createElement('div'); shell.className = 'rs-shell' + (presenting ? ' presenting' : '');
    if (!presenting) shell.appendChild(renderToolbar(page));
    const viewport = document.createElement('div'); viewport.className = 'rs-viewport';
    const canvas = document.createElement('div'); canvas.className = 'rs-canvas'; canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', onCanvasPointerDown);
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
    bar.append(mkBtn(fullscreen ? '退出全屏编辑' : '全屏编辑', toggleEditFullscreen, fullscreen ? '退出全屏编辑' : '放大当前画布进行编辑'), mkBtn('新建文字', addTextElement), mkBtn('插入图片', insertImage));
    [['置顶', bringToFront], ['置底', sendToBack], ['删除', deleteSelected]].forEach(([l, fn]) => { const b = mkBtn(l, fn); b.disabled = !el; bar.appendChild(b); });
    if (el?.type === 'text') {
      const edit = mkBtn('编辑文字', () => enterTextEdit(el)); edit.disabled = editingId === el.id; bar.appendChild(edit);
      const size = document.createElement('input'); size.type = 'number'; size.min = '10'; size.max = '160'; size.className = 'rs-toolbar-size'; size.value = el.fontSize || DEFAULT_FONT_SIZE;
      size.onchange = () => { el.fontSize = Math.max(10, Math.min(160, Number(size.value) || DEFAULT_FONT_SIZE)); scheduleSave(); render(); }; bar.appendChild(size);
      const color = document.createElement('input'); color.type = 'color'; color.className = 'rs-toolbar-color'; color.value = el.color || '#808080';
      color.oninput = () => { el.color = color.value; scheduleSave(); const box = host.querySelector('.rs-text'); if (box) box.style.color = el.color; }; bar.appendChild(color);
      [['B', 'bold'], ['I', 'italic']].forEach(([label, key]) => { const b = mkBtn(label, () => { el[key] = !el[key]; scheduleSave(); render(); }); b.classList.toggle('on', !!el[key]); bar.appendChild(b); });
      [['left', '左'], ['center', '中'], ['right', '右']].forEach(([align, label]) => { const b = mkBtn(label, () => { el.align = align; scheduleSave(); render(); }); b.classList.toggle('on', (el.align || 'left') === align); bar.appendChild(b); });
    }
    return bar;
  }
  function updateToolbar() {
    if (presenting) return;
    const old = host?.querySelector('.rs-toolbar'), page = currentPage();
    if (old && page) old.replaceWith(renderToolbar(page));
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
      if (!presenting) {
        node.addEventListener('dblclick', (e) => { e.stopPropagation(); enterTextEdit(el); });
        if (isEditing) {
          box.addEventListener('pointerdown', (e) => e.stopPropagation());
          box.addEventListener('input', () => { el.text = box.value.slice(0, 4000); autoGrowHeight(box, el); scheduleSave(); });
          box.addEventListener('blur', () => commitTextEdit(el));
          box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); box.blur(); } });
        }
      }
      node.appendChild(box);
    } else { const img = document.createElement('img'); img.className = 'rs-image'; img.src = el.url; img.draggable = false; node.appendChild(img); }
    if (!presenting && el.id === selectedId) attachHandles(node, el);
    return node;
  }
  function onCanvasPointerDown(e) { if (e.target === e.currentTarget) { selectedId = null; editingId = null; render(); } }
  function startMove(e, el) {
    if (presenting || editingId === el.id || e.target.classList.contains('rs-handle')) return;
    e.stopPropagation(); selectedId = el.id;
    host.querySelectorAll('.rs-el.sel').forEach((node) => { node.classList.remove('sel'); node.querySelectorAll('.rs-handle').forEach((handle) => handle.remove()); });
    e.currentTarget.classList.add('sel'); attachHandles(e.currentTarget, el); updateToolbar();
    const sx = e.clientX, sy = e.clientY, ox = el.x, oy = el.y, k = canvasScale();
    const move = (m) => { el.x = Math.round(ox + (m.clientX - sx) / k); el.y = Math.round(oy + (m.clientY - sy) / k); const n = host.querySelector(`.rs-el[data-id="${el.id}"]`); if (n) { n.style.left = el.x + 'px'; n.style.top = el.y + 'px'; } };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); scheduleSave(); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }
  function attachHandles(node, el) {
    const handles = el.type === 'text' ? ['l', 'r'] : ['nw', 'ne', 'sw', 'se'];
    handles.forEach((side) => { const h = document.createElement('div'); h.className = 'rs-handle rs-handle-' + side; h.addEventListener('pointerdown', (e) => el.type === 'text' ? startTextResize(e, el, side) : startImageResize(e, el, side)); node.appendChild(h); });
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
  function autoGrowHeight(box, el) { if (!box) return; box.style.height = 'auto'; el.h = Math.max(34, box.scrollHeight); const node = box.closest('.rs-el'); if (node) node.style.height = el.h + 'px'; }
  function enterTextEdit(el) { if (presenting) return; selectedId = editingId = el.id; render(); const box = host.querySelector(`.rs-el[data-id="${el.id}"] .rs-text`); if (!box) return; box.focus(); const range = document.createRange(); range.selectNodeContents(box); range.collapse(false); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
  function commitTextEdit(el) { if (editingId === el.id) editingId = null; scheduleSave(); render(); }
  function addTextElement() { const page = currentPage(); if (!page || presenting) return; const el = { id: uid('el_'), type: 'text', x: 160, y: 140, w: 420, h: 42, z: nextZ(page), text: '双击编辑文字', fontSize: DEFAULT_FONT_SIZE, color: null, bold: false, italic: false, align: 'left' }; page.elements.push(el); selectedId = el.id; scheduleSave(); render(); enterTextEdit(el); }
  async function insertImage() {
    const page = currentPage(); if (!page || presenting) return; let url; try { url = await A.uploadImage(); } catch (e) { A.toast('图片上传失败：' + e.message, 'bad'); return; } if (!url) return;
    const [nw, nh] = await new Promise((resolve) => { const img = new Image(); img.onload = () => resolve([img.naturalWidth, img.naturalHeight]); img.onerror = () => resolve([400, 300]); img.src = url; });
    const scale = Math.min(1, 640 / Math.max(nw, nh)), w = Math.round(nw * scale), h = Math.round(nh * scale); const el = { id: uid('el_'), type: 'image', x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h, z: nextZ(page), url, naturalW: nw, naturalH: nh }; page.elements.push(el); selectedId = el.id; scheduleSave(); render();
  }
  function deleteSelected() { const page = currentPage(); if (!page || !selectedId) return; page.elements = page.elements.filter((el) => el.id !== selectedId); selectedId = null; scheduleSave(); render(); }
  function bringToFront() { const page = currentPage(), el = page?.elements.find((x) => x.id === selectedId); if (!el) return; el.z = nextZ(page); scheduleSave(); render(); }
  function sendToBack() { const page = currentPage(), el = page?.elements.find((x) => x.id === selectedId); if (!el) return; el.z = Math.min(...page.elements.map((x) => x.z || 0)) - 1; scheduleSave(); render(); }
  function toggleEditFullscreen() {
    const fullscreenTarget = host; if (!fullscreenTarget || presenting) return;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    const enter = fullscreenTarget.requestFullscreen || fullscreenTarget.webkitRequestFullscreen;
    if (document.fullscreenElement || document.webkitFullscreenElement) exit?.call(document);
    else if (enter) enter.call(fullscreenTarget).catch?.(() => A.toast('浏览器拒绝了全屏编辑请求，可按 F11 手动放大', 'bad'));
    else A.toast('这个浏览器不支持全屏编辑，可按 F11 手动放大', 'bad');
  }
  function onFullscreenChange() { if (host?.querySelector('.rs-shell') && !presenting) { updateToolbar(); requestAnimationFrame(scaleCanvas); } }
  function savePageOrder(order) { pendingPageOrder = Array.isArray(order) ? order.slice() : null; scheduleSave(); }
  function setPresenting(value) { presenting = value; if (pageId) render(); }
  function init(api) { A = api; host = document.querySelector('#rpt-page-custom'); window.addEventListener('resize', scaleCanvas); document.addEventListener('fullscreenchange', onFullscreenChange); document.addEventListener('webkitfullscreenchange', onFullscreenChange); }
  return { init, setPages, addPage, deletePage, renamePage, mountPage, unmountPage, setPresenting, savePageOrder, flushSave, pageCount: () => pages.length };
})();
