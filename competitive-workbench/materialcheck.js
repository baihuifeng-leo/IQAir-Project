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
      return { file, row, state: 'processing' }; // state: processing | needsPick | done
    });

    const updateSummary = () => {
      const done = rows.filter((r) => r.state === 'done').length;
      const pendingPick = rows.filter((r) => r.state === 'needsPick').length;
      const processing = rows.length - done - pendingPick;
      summary.textContent = `本次上传 ${rows.length} 张 · 已完成 ${done} · 待选择 ${pendingPick} · 处理中 ${processing}`;
    };
    updateSummary();

    async function runOne(entry) {
      entry.state = 'processing';
      entry.row.className = 'mc-row mc-row-pending';
      entry.row.innerHTML = `<span class="mc-row-name">${escapeHtml(entry.file.name)}</span><span class="mc-row-status"><i class="mc-spin"></i> 识别中…</span>`;
      updateSummary();
      try {
        const result = await call(`/api/materialcheck/upload?filename=${encodeURIComponent(entry.file.name)}&batchId=${encodeURIComponent(batchId)}`, {
          method: 'POST',
          headers: { 'Content-Type': entry.file.type },
          body: entry.file
        });
        entry.state = result.needsManualPick ? 'needsPick' : 'done';
        renderResult(entry.row, result, {
          onRetry: () => runOne(entry),
          onResolved: () => { entry.state = 'done'; updateSummary(); }
        });
      } catch (e) {
        entry.state = 'done';
        entry.row.className = 'mc-row mc-row-error';
        entry.row.querySelector('.mc-row-status').textContent = '上传失败：' + e.message;
      }
      updateSummary();
    }

    const CONCURRENCY = 3;
    let cursor = 0;
    async function worker() {
      while (cursor < rows.length) {
        const idx = cursor++;
        await runOne(rows[idx]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  }

  function renderResult(row, result, ctx = {}) {
    if (result.needsManualPick) {
      row.className = 'mc-row mc-row-pick';
      const options = products.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
      const pickLabel = result.lowConfidence ? '识别置信度低，请核对：' : '需要选择产品：';
      row.innerHTML = `
        <span class="mc-row-name">${escapeHtml(result.filename)}</span>
        <span class="mc-row-status">${pickLabel}
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
          renderResult(row, resolved, ctx);
          if (ctx.onResolved) ctx.onResolved();
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
      <span class="mc-row-status">${badge} · ${escapeHtml(result.productName || '')}${methodLabel ? ' · 匹配方式：' + methodLabel : ''}${failed ? ' <button class="mc-btn mc-row-retry">重试</button>' : ''}</span>
      ${detail}`;

    if (failed) {
      row.querySelector('.mc-row-retry').onclick = () => { if (ctx.onRetry) ctx.onRetry(); };
    }
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
        <select id="mc-f-product"><option value="">全部产品</option>${products.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select>
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

  // ── 关键词库 ────────────────────────────────────────
  async function renderLibrary() {
    const el = A.$('#mc-library-view');
    if (!A.me.admin) { el.innerHTML = '<p class="rv-empty">只有管理员能管理关键词库</p>'; return; }

    el.innerHTML = `
      <div class="mc-lib">
        <div class="mc-lib-products">
          <div class="mc-lib-head"><h3>产品</h3><button class="mc-btn" id="mc-add-product">+ 新增产品</button></div>
          <div id="mc-product-list"></div>
        </div>
        <div class="mc-lib-detail" id="mc-lib-detail"></div>
      </div>
      <div class="mc-universal">
        <h3>通用词（任何产品图上出现都不算问题）</h3>
        <div class="mc-chip-editor" id="mc-universal-chips"></div>
        <div class="mc-kw-add"><input placeholder="输入通用词，回车添加" id="mc-universal-input"><button class="mc-btn" id="mc-universal-add-btn">添加</button></div>
        <button class="mc-btn mc-btn-primary" id="mc-lib-save">保存关键词库</button>
        <p class="mc-lib-error" id="mc-lib-error" hidden></p>
      </div>`;

    let selected = products[0]?.id || null;

    const drawProductList = () => {
      A.$('#mc-product-list').innerHTML = products.map((p) => `
        <div class="mc-product-item ${p.id === selected ? 'is-active' : ''}" data-id="${escapeHtml(p.id)}">
          <span>${escapeHtml(p.name)}</span><small>${p.keywords.length} 词</small>
        </div>`).join('') || '<p class="rv-empty">还没有产品</p>';
      A.$$('#mc-product-list .mc-product-item').forEach((it) => {
        it.onclick = () => { selected = it.dataset.id; drawProductList(); drawDetail(); };
      });
    };

    const drawDetail = () => {
      const detail = A.$('#mc-lib-detail');
      const p = products.find((x) => x.id === selected);
      if (!p) { detail.innerHTML = '<p class="rv-empty">选一个产品</p>'; return; }
      detail.innerHTML = `
        <div class="mc-kw-editor">
          <label>产品名称 / 型号</label>
          <input class="mc-kw-name" value="${escapeHtml(p.name)}">
          <label>专属关键词</label>
          <div class="mc-chip-editor" id="mc-kw-chips"></div>
          <div class="mc-kw-add"><input placeholder="输入关键词，回车添加" id="mc-kw-input"><button class="mc-btn" id="mc-kw-add-btn">添加</button></div>
          <button class="mc-btn mc-btn-danger" id="mc-del-product">删除这个产品</button>
        </div>`;

      const drawChips = () => {
        A.$('#mc-kw-chips').innerHTML = p.keywords.map((k, i) => `<span class="mc-chip">${escapeHtml(k)}<i data-i="${i}">×</i></span>`).join('');
        A.$$('#mc-kw-chips i').forEach((x) => (x.onclick = () => { p.keywords.splice(Number(x.dataset.i), 1); drawChips(); drawProductList(); }));
      };
      drawChips();

      A.$('.mc-kw-name').oninput = (e) => { p.name = e.target.value; };

      const addKw = () => {
        const input = A.$('#mc-kw-input');
        const v = input.value.trim();
        if (!v) return;
        p.keywords.push(v); input.value = ''; drawChips(); drawProductList();
      };
      A.$('#mc-kw-add-btn').onclick = addKw;
      A.$('#mc-kw-input').onkeydown = (e) => { if (e.key === 'Enter') addKw(); };

      A.$('#mc-del-product').onclick = () => {
        products = products.filter((x) => x.id !== p.id);
        selected = products[0]?.id || null;
        drawProductList(); drawDetail();
      };
    };

    A.$('#mc-add-product').onclick = () => {
      const p = { id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2), name: '新产品', keywords: [] };
      products.push(p); selected = p.id; drawProductList(); drawDetail();
    };

    const drawUniversal = () => {
      A.$('#mc-universal-chips').innerHTML = universalKeywords.map((k, i) => `<span class="mc-chip">${escapeHtml(k)}<i data-i="${i}">×</i></span>`).join('');
      A.$$('#mc-universal-chips i').forEach((x) => (x.onclick = () => { universalKeywords.splice(Number(x.dataset.i), 1); drawUniversal(); }));
    };
    const addUniversal = () => {
      const input = A.$('#mc-universal-input');
      const v = input.value.trim();
      if (!v) return;
      universalKeywords.push(v); input.value = ''; drawUniversal();
    };
    A.$('#mc-universal-add-btn').onclick = addUniversal;
    A.$('#mc-universal-input').onkeydown = (e) => { if (e.key === 'Enter') addUniversal(); };

    A.$('#mc-lib-save').onclick = async () => {
      const errEl = A.$('#mc-lib-error');
      errEl.hidden = true;
      try {
        const saved = await call('/api/materialcheck/products', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ products, universalKeywords })
        });
        products = saved.products; universalKeywords = saved.universalKeywords;
        A.toast('关键词库已保存');
        drawProductList(); drawDetail(); drawUniversal();
      } catch (e) {
        errEl.hidden = false; errEl.textContent = e.message;
      }
    };

    drawProductList(); drawDetail(); drawUniversal();
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
