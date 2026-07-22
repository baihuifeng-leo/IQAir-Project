const MaterialCheck = (() => {
  let A, subView = 'check', products = [], universalKeywords = [];

  async function call(url, opts) {
    const r = A.guard(await fetch(url, opts));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '请求失败');
    return j;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadProducts() {
    const j = await call('/api/materialcheck/products');
    products = j.products;
    universalKeywords = j.universalKeywords;
  }

  function switchSub(name) {
    subView = name;
    A.$$('#mc-subview-switch .mc-subtab').forEach((b) => b.classList.toggle('is-active', b.dataset.sub === name));
    A.$('#mc-check-view').hidden = name !== 'check';
    A.$('#mc-history-view').hidden = name !== 'history';
    A.$('#mc-library-view').hidden = name !== 'library';
    if (name === 'history') renderHistory();
    if (name === 'library') renderLibrary();
  }

  // ── 检测台 ──────────────────────────────────────────
  function renderCheckView() {
    const el = A.$('#mc-check-view');
    el.innerHTML = `
      <div class="mc-upload-zone" id="mc-upload-zone">点击选择图片，或把图片拖进这个区域（支持多选批量上传）</div>
      <div class="mc-batch-summary" id="mc-batch-summary"></div>
      <div id="mc-result-list"></div>`;
    A.$('#mc-upload-zone').onclick = () => A.$('#mc-file').click();
  }

  async function uploadFiles(fileList) {
    if (!products.length) return A.toast('先去「关键词库」配置至少一个产品', 'bad');
    const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const list = A.$('#mc-result-list');
    const summary = A.$('#mc-batch-summary');

    const rows = fileList.map((file) => {
      const row = document.createElement('div');
      row.className = 'mc-row mc-row-pending';
      row.innerHTML = `<span class="mc-row-name">${escapeHtml(file.name)}</span><span class="mc-row-status"><i class="mc-spin"></i> 识别中…</span>`;
      list.prepend(row);
      return { file, row };
    });

    let done = 0;
    const updateSummary = () => { summary.textContent = `本次上传 ${rows.length} 张 · 已完成 ${done} · 处理中 ${rows.length - done}`; };
    updateSummary();

    const CONCURRENCY = 3;
    let cursor = 0;
    async function worker() {
      while (cursor < rows.length) {
        const idx = cursor++;
        const { file, row } = rows[idx];
        try {
          const result = await call(`/api/materialcheck/upload?filename=${encodeURIComponent(file.name)}&batchId=${encodeURIComponent(batchId)}`, {
            method: 'POST',
            headers: { 'Content-Type': file.type },
            body: file
          });
          renderResult(row, result);
        } catch (e) {
          row.className = 'mc-row mc-row-error';
          row.querySelector('.mc-row-status').textContent = '上传失败：' + e.message;
        }
        done++; updateSummary();
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  }

  function renderResult(row, result) {
    if (result.needsManualPick) {
      row.className = 'mc-row mc-row-pick';
      const options = products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
      row.innerHTML = `
        <span class="mc-row-name">${escapeHtml(result.filename)}</span>
        <span class="mc-row-status">需要选择产品：
          <select class="mc-pick-select"><option value="">— 选择产品 —</option>${options}</select>
          <button class="mc-btn mc-btn-primary mc-pick-confirm">确定</button>
        </span>
        <details class="mc-row-ocr"><summary>查看识别文字</summary><pre>${escapeHtml(result.ocrText)}</pre></details>`;
      row.querySelector('.mc-pick-confirm').onclick = async () => {
        const productId = row.querySelector('.mc-pick-select').value;
        if (!productId) return A.toast('先选一个产品', 'bad');
        try {
          const resolved = await call('/api/materialcheck/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pendingId: result.pendingId, productId })
          });
          renderResult(row, resolved);
        } catch (e) { A.toast(e.message, 'bad'); }
      };
      return;
    }

    const ok = result.status === 'pass';
    const failed = result.status === 'ocr_failed';
    row.className = 'mc-row ' + (failed ? 'mc-row-error' : ok ? 'mc-row-ok' : 'mc-row-bad');
    const badge = failed ? '⚠ 识别失败' : ok ? '✓ 通过' : '✕ 不通过';
    const methodLabel = { filename: '文件名', ocr: 'OCR文字', manual: '人工选择' }[result.matchMethod] || '';

    let detail = '';
    if (result.missingKeywords?.length) {
      detail += `<div class="mc-chip-row">缺词：${result.missingKeywords.map((k) => `<span class="mc-chip mc-chip-bad">${escapeHtml(k)}</span>`).join('')}</div>`;
    }
    if (result.crossedKeywords?.length) {
      detail += `<div class="mc-chip-row">串词：${result.crossedKeywords.map((c) => `<span class="mc-chip mc-chip-bad">${escapeHtml(c.keyword)} · 属于「${escapeHtml(c.fromProductName)}」</span>`).join('')}</div>`;
    }
    if (result.warning) detail += `<div class="mc-warning">⚠ ${escapeHtml(result.warning)}</div>`;

    row.innerHTML = `
      <span class="mc-row-name">${escapeHtml(result.filename)}</span>
      <span class="mc-row-status">${badge} · ${escapeHtml(result.productName || '')}${methodLabel ? ' · 匹配方式：' + methodLabel : ''}</span>
      ${detail}`;
  }

  // ── 历史记录 ────────────────────────────────────────
  let historyRows = [], detailMask, detailBody;

  async function renderHistory() {
    const el = A.$('#mc-history-view');
    el.innerHTML = '<p class="rv-empty">读取中…</p>';
    try {
      const j = await call('/api/materialcheck/records?limit=1000');
      historyRows = j.records;
    } catch (e) { el.innerHTML = ''; return A.toast(e.message, 'bad'); }

    el.innerHTML = `
      <div class="mc-filter-bar">
        <select id="mc-f-product"><option value="">全部产品</option>${products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>
        <select id="mc-f-status"><option value="">全部状态</option><option value="pass">通过</option><option value="fail">不通过</option><option value="ocr_failed">识别失败</option></select>
      </div>
      <div class="mc-history-list" id="mc-history-list"></div>`;

    const draw = () => {
      const pf = A.$('#mc-f-product').value, sf = A.$('#mc-f-status').value;
      const shown = historyRows.filter((r) => (!pf || r.productId === pf) && (!sf || r.status === sf));
      const list = A.$('#mc-history-list');
      if (!shown.length) { list.innerHTML = '<p class="rv-empty">没有匹配的记录</p>'; return; }
      list.innerHTML = shown.map((r, i) => historyRowHtml(r, i)).join('');
      shown.forEach((r, i) => { list.querySelector(`[data-hi="${i}"]`).onclick = () => openHistoryDetail(r); });
    };
    A.$('#mc-f-product').onchange = draw;
    A.$('#mc-f-status').onchange = draw;
    draw();
  }

  function historyRowHtml(r, i) {
    const badge = r.status === 'pass' ? '✓ 通过' : r.status === 'ocr_failed' ? '⚠ 识别失败' : '✕ 不通过';
    const cls = r.status === 'pass' ? 'mc-row-ok' : r.status === 'ocr_failed' ? 'mc-row-error' : 'mc-row-bad';
    return `<div class="mc-history-row ${cls}" data-hi="${i}">
      <span class="mc-row-name">${escapeHtml(r.filename)}</span>
      <span class="mc-row-status">${badge} · ${escapeHtml(r.productName || '')} · ${new Date(r.timestamp).toLocaleString('zh-CN')} · ${escapeHtml(r.uploadedBy)}</span>
    </div>`;
  }

  function buildDetailSheet() {
    detailMask = document.createElement('div');
    detailMask.className = 'sheet-mask';
    detailMask.hidden = true;
    detailMask.innerHTML = `
      <div class="sheet sheet-wide" role="dialog">
        <div class="sheet-head"><h2>检测详情</h2><button class="kill" id="mc-detail-close" title="关闭">×</button></div>
        <div class="sheet-body" id="mc-detail-body"></div>
      </div>`;
    document.body.appendChild(detailMask);
    detailBody = detailMask.querySelector('#mc-detail-body');
    detailMask.querySelector('#mc-detail-close').onclick = () => (detailMask.hidden = true);
    detailMask.onclick = (e) => { if (e.target === detailMask) detailMask.hidden = true; };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !detailMask.hidden) detailMask.hidden = true; });
  }

  function openHistoryDetail(r) {
    if (!detailMask) buildDetailSheet();
    let html = escapeHtml(r.ocrText || '（没有识别到文字）');
    (r.crossedKeywords || []).forEach((c) => {
      html = html.split(escapeHtml(c.keyword)).join(`<mark class="mc-mark-bad">${escapeHtml(c.keyword)}</mark>`);
    });
    const missing = (r.missingKeywords || []).map((k) => `<span class="mc-chip mc-chip-bad">${escapeHtml(k)}</span>`).join('') || '（无缺词）';
    const crossed = (r.crossedKeywords || []).map((c) => `<span class="mc-chip mc-chip-bad">${escapeHtml(c.keyword)} · 属于「${escapeHtml(c.fromProductName)}」</span>`).join('') || '（无串词）';
    detailBody.innerHTML = `
      <p><b>${escapeHtml(r.filename)}</b> · ${escapeHtml(r.productName || '')} · ${new Date(r.timestamp).toLocaleString('zh-CN')}</p>
      <div class="mc-chip-row"><b>缺词：</b>${missing}</div>
      <div class="mc-chip-row"><b>串词：</b>${crossed}</div>
      <pre class="mc-ocr-text">${html}</pre>`;
    detailMask.hidden = false;
  }

  // ── 关键词库（Task 8 填充） ────────────────────────────
  async function renderLibrary() {
    A.$('#mc-library-view').innerHTML = '<p class="rv-empty">开发中…</p>';
  }

  function init(api) {
    A = api;
    A.$('#mc-tab-library').hidden = !A.me.admin;
    A.$$('#mc-subview-switch .mc-subtab').forEach((b) => (b.onclick = () => switchSub(b.dataset.sub)));
    A.$('#mc-file').onchange = (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) uploadFiles(files); };

    renderCheckView();
    loadProducts().catch((e) => A.toast(e.message, 'bad'));

    const scroll = A.$('#mc-scroll');
    ['dragenter', 'dragover'].forEach((ev) => scroll.addEventListener(ev, (e) => { e.preventDefault(); scroll.classList.add('drop-hot'); }));
    ['dragleave', 'drop'].forEach((ev) => scroll.addEventListener(ev, () => scroll.classList.remove('drop-hot')));
    scroll.addEventListener('drop', (e) => {
      e.preventDefault();
      if (subView !== 'check') return;
      const files = [...e.dataTransfer.files].filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
      if (files.length) uploadFiles(files);
    });
  }

  return { init };
})();
