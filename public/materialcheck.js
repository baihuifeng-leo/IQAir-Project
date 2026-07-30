const MaterialCheck = (() => {
  let A, subView = 'check', platform = 'tmall', libraryId = null;
  let libraries = []; // 当前平台下的词库列表 [{id,name,productCount}]
  let libraryDirectory = []; // 历史记录筛选用：两个平台全部词库的扁平列表 [{id,name,platform}]
  let products = [];

  const CATEGORIES = ['产品型号', '产品利益点', '日常销售利益点', '大促销售权益', '附加权益', '国补', '价格', '其它'];
  // 同一个产品的 1:1 和 3:4 素材文案有重叠也有差异（3:4 通常比 1:1 多一段满赠/权益说明），
  // 关键词加一个"适用比例"属性：通用（both，默认）/仅1:1/仅3:4——检测页判定缺词时
  // 只按上传素材实际的比例去要求对应子集，不再一刀切要求全部词都出现在两种比例里。
  const RATIO_OPTIONS = ['both', '1:1', '3:4'];
  const RATIO_LABEL = { both: '通用', '1:1': '仅1:1', '3:4': '仅3:4' };
  const RATIO_CLASS = { both: 'mc-ratio-both', '1:1': 'mc-ratio-11', '3:4': 'mc-ratio-34' };
  // pass/warn/error 是新三态；fail 是 v2 上线前的旧记录留下的值，不迁移，历史筛选里仍要能选到
  const STATUS_META = {
    pass: { cls: 'mc-row-ok', badge: '✓ 通过' },
    warn: { cls: 'mc-row-warn', badge: '⚠ 提醒' },
    error: { cls: 'mc-row-bad', badge: '✕ 报错' },
    fail: { cls: 'mc-row-bad', badge: '✕ 不通过' },
    ocr_failed: { cls: 'mc-row-error', badge: '⚠ 识别失败' }
  };

  function libraryRole() {
    return A.me.admin ? 'edit' : (A.me.materialLibraryRole || 'view');
  }

  async function call(url, opts) {
    const r = A.guard(await fetch(url, opts));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '请求失败');
    return j;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function keywordText(k) { return typeof k === 'string' ? k : String((k && k.text) || ''); }
  function keywordCategory(k) { return (k && typeof k === 'object' && CATEGORIES.includes(k.category)) ? k.category : '其它'; }
  function keywordRatio(k) { return (k && typeof k === 'object' && RATIO_OPTIONS.includes(k.ratio)) ? k.ratio : 'both'; }

  /** priceIssue = {expected, found}，found 是图里实际找到的候选价格数字数组（可能是空数组）。 */
  function priceIssueLabel(pi) {
    const expected = `￥${pi.expected}`;
    if (!pi.found || !pi.found.length) return `${expected}（图里没找到价格）`;
    return `${expected}（图里写的是 ￥${pi.found.join('、￥')}）`;
  }

  async function loadLibraries() {
    const j = await call(`/api/materialcheck/libraries?platform=${encodeURIComponent(platform)}`);
    libraries = j.libraries;
    const saved = sessionStorage.getItem(`mc-library-${platform}`);
    libraryId = (saved && libraries.some((l) => l.id === saved)) ? saved : (libraries[0]?.id || null);
    if (libraryId) sessionStorage.setItem(`mc-library-${platform}`, libraryId);
  }

  function renderLibrarySwitch() {
    const sel = A.$('#mc-library-switch');
    sel.innerHTML = libraries.map((l) =>
      `<option value="${escapeHtml(l.id)}" ${l.id === libraryId ? 'selected' : ''}>${escapeHtml(l.name)}（${l.productCount}）</option>`
    ).join('');
  }

  async function loadProducts() {
    const j = await call(`/api/materialcheck/products?platform=${encodeURIComponent(platform)}&libraryId=${encodeURIComponent(libraryId)}`);
    products = j.products;
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

  async function switchPlatform(next) {
    clearTimeout(autoSaveTimer); // 切平台前把还没触发的自动保存定时器清掉，避免存错地方
    platform = next;
    sessionStorage.setItem('mc-platform', platform);
    try {
      await loadLibraries();
      renderLibrarySwitch();
      await loadProducts();
    } catch (e) { A.toast(e.message, 'bad'); }
    renderCheckView();
    if (subView === 'library') renderLibrary();
    if (subView === 'history') renderHistory();
  }

  async function switchLibrary(next) {
    clearTimeout(autoSaveTimer); // 切词库前同理
    libraryId = next;
    sessionStorage.setItem(`mc-library-${platform}`, libraryId);
    try { await loadProducts(); } catch (e) { A.toast(e.message, 'bad'); }
    if (subView === 'library') renderLibrary();
    if (subView === 'history') renderHistory();
  }

  // ── 检测台 ──────────────────────────────────────────
  // 1:1 和 3:4 素材的文案不完全一样（词库那边已经按比例细分了必需词），
  // 检测时必须知道这张图是哪个比例才能套对应的必需词子集，所以入口按比例拆成两个，
  // 而不是一个入口再让用户额外选一次——拖进哪个区域就按哪个比例处理。
  function renderCheckView() {
    const el = A.$('#mc-check-view');
    el.innerHTML = `
      <div class="mc-upload-row">
        <div class="mc-upload-zone" id="mc-upload-zone-11"><strong>1:1 素材</strong><br>点击选择图片，或拖进这个区域（支持多选批量上传）</div>
        <div class="mc-upload-zone" id="mc-upload-zone-34"><strong>3:4 素材</strong><br>点击选择图片，或拖进这个区域（支持多选批量上传）</div>
      </div>
      <input type="file" id="mc-file-11" accept="image/png,image/jpeg,image/webp" multiple hidden>
      <input type="file" id="mc-file-34" accept="image/png,image/jpeg,image/webp" multiple hidden>
      <div class="mc-batch-summary" id="mc-batch-summary"></div>
      <div class="mc-progress" id="mc-progress" hidden><div class="mc-progress-bar" id="mc-progress-bar"></div></div>
      <div id="mc-result-list"></div>`;

    [['11', '1:1'], ['34', '3:4']].forEach(([suffix, ratio]) => {
      const zone = A.$(`#mc-upload-zone-${suffix}`);
      const fileInput = A.$(`#mc-file-${suffix}`);
      zone.onclick = () => fileInput.click();
      fileInput.onchange = (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        if (files.length) uploadFiles(files, ratio);
      };
      ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drop-hot'); }));
      ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('drop-hot')));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        const files = [...e.dataTransfer.files].filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
        if (files.length) uploadFiles(files, ratio);
      });
    });
  }

  async function uploadFiles(fileList, ratio) {
    if (!products.length) return A.toast('先去「关键词库」配置至少一个产品', 'bad');
    const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const uploadPlatform = platform;
    const uploadLibraryId = libraryId;
    const list = A.$('#mc-result-list');
    const summary = A.$('#mc-batch-summary');
    const progress = A.$('#mc-progress');
    const progressBar = A.$('#mc-progress-bar');
    const batch = document.createElement('details');
    batch.className = 'mc-detect-batch';
    batch.open = true;
    batch.innerHTML = `<summary><span class="mc-history-batch-title">本次上传 · ${ratio} 素材</span><span class="mc-history-batch-count">${fileList.length} 张素材</span></summary><div class="mc-detect-batch-rows"></div>`;
    const batchRows = batch.querySelector('.mc-detect-batch-rows');
    list.prepend(batch);

    const rows = fileList.map((file) => {
      const row = document.createElement('div');
      row.className = 'mc-row mc-row-pending';
      row.innerHTML = `<span class="mc-row-name">${escapeHtml(file.name)}</span><span class="mc-row-status"><i class="mc-spin"></i> 识别中…</span>`;
      batchRows.append(row);
      return { file, row, state: 'processing' }; // state: processing | needsPick | done
    });

    const updateSummary = () => {
      const done = rows.filter((r) => r.state === 'done').length;
      const pendingPick = rows.filter((r) => r.state === 'needsPick').length;
      const processing = rows.length - done - pendingPick;
      summary.textContent = `本次上传 ${rows.length} 张 · 已完成 ${done} · 待选择 ${pendingPick} · 处理中 ${processing}`;
      // 整批总进度条：按"识别/判定已经跑完"算进度，待人工选择也算跑完了自己那部分，只是还差人点一下
      progress.hidden = false;
      progressBar.style.width = `${rows.length ? Math.round(((done + pendingPick) / rows.length) * 100) : 0}%`;
    };
    updateSummary();

    async function runOne(entry) {
      entry.state = 'processing';
      entry.row.className = 'mc-row mc-row-pending';
      entry.row.innerHTML = `<span class="mc-row-name">${escapeHtml(entry.file.name)}</span><span class="mc-row-status"><i class="mc-spin"></i> 识别中…</span>`;
      updateSummary();
      try {
        const result = await call(`/api/materialcheck/upload?filename=${encodeURIComponent(entry.file.name)}&batchId=${encodeURIComponent(batchId)}&platform=${encodeURIComponent(uploadPlatform)}&libraryId=${encodeURIComponent(uploadLibraryId)}&ratio=${encodeURIComponent(ratio)}`, {
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

  const KWD_STATUS_TITLE = {
    missing: '素材里没有找到这个词',
    fuzzy: '不是逐字一致，靠归一化规则判定命中',
    exact: '素材原文逐字命中'
  };

  /** 检测台结果卡片里"查看明细"面板：把 matchAgainstProduct 返回的 matchedKeywords
   *  （产品自己词库里每个适用词的命中三态）画成手动展开的明细列表，缺失排最前面，
   *  规则命中的附上具体理由（从 normalize() 的规则表反推出来的，不是写死的猜测）。 */
  function keywordDetailHtml(matchedKeywords, options = {}) {
    if (!matchedKeywords || !matchedKeywords.length) {
      return options.emptyMessage ? `<p class="mc-kw-detail-empty">${escapeHtml(options.emptyMessage)}</p>` : '';
    }
    const missCount = matchedKeywords.filter((k) => k.status === 'missing').length;
    const fuzzyCount = matchedKeywords.filter((k) => k.status === 'fuzzy').length;
    const items = matchedKeywords.map((kw) => {
      const reasonText = (kw.reasons || []).join('、');
      const title = kw.status === 'fuzzy' ? `${KWD_STATUS_TITLE.fuzzy}：${reasonText}` : KWD_STATUS_TITLE[kw.status];
      const actionText = kw.status === 'missing'
        ? '未命中'
        : kw.status === 'fuzzy'
          ? `系统处理：${reasonText || '归一化判定'}`
          : '逐字命中';
      return `<span class="mc-chip mc-kwd-${kw.status}" title="${escapeHtml(title)}">
        <span class="mc-kwd-cat-dot ${CAT_CLASS[kw.category] || ''}"></span>${escapeHtml(kw.text)}<span class="mc-kwd-action">${escapeHtml(actionText)}</span>
      </span>`;
    }).join('');
    return `<details class="mc-kw-detail"${options.open ? ' open' : ''}>
      <summary>关键词处理明细（共 ${matchedKeywords.length} 词 · ${missCount} 缺失 · ${fuzzyCount} 规则命中）</summary>
      <div class="mc-kw-detail-list">${items}</div>
    </details>`;
  }

  /** 检测结果和历史详情共用的素材预览入口：点击打开可拖动的小窗，不打断关键词对照。 */
  function sourcePreviewHtml(imagePath, filename, options = {}) {
    if (!imagePath) return '';
    return `<button type="button" class="mc-source-preview" data-mc-preview-src="${escapeHtml(imagePath)}" data-mc-preview-caption="${escapeHtml(filename)}"${options.hover ? ' data-mc-preview-hover="true"' : ''} title="悬停预览；点击固定或关闭">◫ <span>预览素材</span></button>`;
  }

  let sourcePreviewPanel = null;

  function closeSourcePreview() {
    if (sourcePreviewPanel) {
      sourcePreviewPanel.hidden = true;
      delete sourcePreviewPanel.dataset.previewMode;
    }
  }

  function moveSourcePreview(left, top) {
    const panel = sourcePreviewPanel;
    const pad = 12;
    const maxLeft = Math.max(pad, innerWidth - panel.offsetWidth - pad);
    const maxTop = Math.max(pad, innerHeight - panel.offsetHeight - pad);
    panel.style.left = Math.min(Math.max(pad, left), maxLeft) + 'px';
    panel.style.top = Math.min(Math.max(pad, top), maxTop) + 'px';
    panel.style.right = 'auto';
  }

  /** 根据素材本身的宽高比给预览窗定初始大小；只在图片大到放不进屏幕时才等比缩小。 */
  function fitSourcePreviewToImage(panel, image) {
    if (!image.naturalWidth || !image.naturalHeight) return;
    const maxWidth = Math.max(260, innerWidth - 48);
    const maxImageHeight = Math.max(220, innerHeight - 100);
    const scale = Math.min(1, maxWidth / image.naturalWidth, maxImageHeight / image.naturalHeight);
    panel.style.width = Math.round(image.naturalWidth * scale) + 'px';
    placeSourcePreview(panel, panel._mcPreviewAnchor);
  }

  function placeSourcePreview(panel, anchor) {
    if (!anchor || !anchor.isConnected) {
      moveSourcePreview(innerWidth - panel.offsetWidth - 24, 82);
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const rightSide = rect.right + 12;
    const left = rightSide + panel.offsetWidth <= innerWidth - 12 ? rightSide : rect.left - panel.offsetWidth - 12;
    moveSourcePreview(left, rect.top);
  }

  function ensureSourcePreviewPanel() {
    if (sourcePreviewPanel) return sourcePreviewPanel;
    const panel = document.createElement('section');
    panel.className = 'mc-source-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '素材预览');
    panel.innerHTML = `
      <div class="mc-source-panel-head" data-role="drag"><span class="mc-source-panel-title"></span><button type="button" class="mc-source-panel-close" aria-label="关闭素材预览">×</button></div>
      <img class="mc-source-panel-image" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">
      <span class="mc-source-panel-resize" data-role="resize" title="拖动调整预览大小" aria-hidden="true"></span>`;
    document.body.appendChild(panel);

    panel.querySelector('.mc-source-panel-close').onclick = closeSourcePreview;
    const handle = panel.querySelector('[data-role="drag"]');
    let drag = null;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      handle.setPointerCapture(e.pointerId);
      panel.classList.add('is-dragging');
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => { if (drag) moveSourcePreview(e.clientX - drag.dx, e.clientY - drag.dy); });
    const stopDrag = () => { drag = null; panel.classList.remove('is-dragging'); };
    handle.addEventListener('pointerup', stopDrag);
    handle.addEventListener('pointercancel', stopDrag);

    const resizeHandle = panel.querySelector('[data-role="resize"]');
    let resize = null;
    resizeHandle.addEventListener('pointerdown', (e) => {
      const rect = panel.getBoundingClientRect();
      resize = { startX: e.clientX, startWidth: rect.width };
      resizeHandle.setPointerCapture(e.pointerId);
      panel.classList.add('is-resizing');
      e.preventDefault();
      e.stopPropagation();
    });
    resizeHandle.addEventListener('pointermove', (e) => {
      if (!resize) return;
      const image = panel.querySelector('.mc-source-panel-image');
      // 窗口再宽也不能让图片因高度上限被截成“宽窗小图”。按原图比例反算最大宽度，
      // 让拖动后的窗口和图片仍然保持同一个展示比例。
      const ratioBound = image.naturalWidth && image.naturalHeight
        ? (innerHeight - 100) * image.naturalWidth / image.naturalHeight
        : innerWidth - 24;
      const width = Math.min(Math.max(260, resize.startWidth + e.clientX - resize.startX), innerWidth - 24, ratioBound);
      panel.style.width = Math.round(width) + 'px';
      moveSourcePreview(parseFloat(panel.style.left) || 12, parseFloat(panel.style.top) || 12);
    });
    const stopResize = () => { resize = null; panel.classList.remove('is-resizing'); };
    resizeHandle.addEventListener('pointerup', stopResize);
    resizeHandle.addEventListener('pointercancel', stopResize);

    document.addEventListener('pointerdown', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && !e.target.closest('[data-mc-preview-src]')) closeSourcePreview();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) closeSourcePreview(); });
    window.addEventListener('resize', () => { if (!panel.hidden) moveSourcePreview(parseFloat(panel.style.left) || 12, parseFloat(panel.style.top) || 12); });
    sourcePreviewPanel = panel;
    return panel;
  }

  function openSourcePreview(src, caption, options = {}) {
    const panel = ensureSourcePreviewPanel();
    panel._mcPreviewAnchor = options.anchor || null;
    panel.dataset.previewMode = options.mode || 'pinned';
    panel.dataset.previewSrc = src;
    panel.querySelector('.mc-source-panel-title').textContent = caption || '素材预览';
    const image = panel.querySelector('.mc-source-panel-image');
    image.alt = caption || '被检测的素材';
    image.onload = () => fitSourcePreviewToImage(panel, image);
    image.src = src;
    panel.hidden = false;
    requestAnimationFrame(() => {
      placeSourcePreview(panel, panel._mcPreviewAnchor);
      if (image.complete) fitSourcePreviewToImage(panel, image);
    });
  }

  function wireSourcePreviews(root) {
    root.querySelectorAll('[data-mc-preview-src]').forEach((button) => {
      const src = button.dataset.mcPreviewSrc;
      const caption = button.dataset.mcPreviewCaption;
      if (button.dataset.mcPreviewHover) {
        button.addEventListener('mouseenter', () => openSourcePreview(src, caption, { anchor: button, mode: 'hover' }));
        button.addEventListener('mouseleave', () => {
          if (sourcePreviewPanel?.dataset.previewMode === 'hover') closeSourcePreview();
        });
      }
      button.addEventListener('click', () => {
        const panel = ensureSourcePreviewPanel();
        const isSamePinnedPreview = !panel.hidden && panel.dataset.previewSrc === src && panel.dataset.previewMode === 'pinned';
        if (isSamePinnedPreview) closeSourcePreview();
        else openSourcePreview(src, caption, { anchor: button, mode: 'pinned' });
      });
    });
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

    const meta = STATUS_META[result.status] || STATUS_META.error;
    const failed = result.status === 'ocr_failed';
    row.className = 'mc-row ' + meta.cls;
    const methodLabel = { filename: '文件名候选', ocr: 'OCR文字', ocr_override_filename: 'OCR文字（覆盖文件名候选）', manual: '人工选择' }[result.matchMethod] || '';

    let detail = '';
    if (result.missingKeywords?.length) {
      detail += `<div class="mc-chip-row">缺词：${result.missingKeywords.map((k) => `<span class="mc-chip mc-chip-warn">${escapeHtml(k)}</span>`).join('')}</div>`;
    }
    if (result.extraKeywords?.length) {
      detail += `<div class="mc-chip-row">串词：${result.extraKeywords.map((k) => `<span class="mc-chip mc-chip-bad">${escapeHtml(k)}</span>`).join('')}</div>`;
    }
    if (result.unregisteredKeywords?.length) {
      detail += `<div class="mc-chip-row mc-unregistered-row"><b>未入库词：</b><span class="mc-unregistered-note">仅供核对，不影响通过</span>${result.unregisteredKeywords.map((k) => `<span class="mc-chip mc-chip-note">${escapeHtml(k)}</span>`).join('')}</div>`;
    }
    if (result.priceIssue) {
      detail += `<div class="mc-chip-row">价格不对：<span class="mc-chip mc-chip-bad">${priceIssueLabel(result.priceIssue)}</span></div>`;
    }
    if (result.warning) detail += `<div class="mc-warning">⚠ ${escapeHtml(result.warning)}</div>`;
    detail += keywordDetailHtml(result.matchedKeywords);

    row.innerHTML = `
      <span class="mc-row-name">${escapeHtml(result.filename)}</span>
      <span class="mc-row-status">${meta.badge} · ${escapeHtml(result.productName || '')}${result.ratio ? ' · ' + result.ratio + ' 素材' : ''}${methodLabel ? ' · 匹配方式：' + methodLabel : ''}${failed ? ' <button class="mc-btn mc-row-retry">重试</button>' : ''}</span>
      ${sourcePreviewHtml(result.imagePath, result.filename, { hover: true })}
      ${detail}`;

    wireSourcePreviews(row);

    if (failed) {
      row.querySelector('.mc-row-retry').onclick = () => { if (ctx.onRetry) ctx.onRetry(); };
    }
  }

  // ── 历史记录 ────────────────────────────────────────
  let historyRows = [], detailMask, detailBody;

  async function loadLibraryDirectory() {
    const dir = [];
    for (const pf of ['tmall', 'jd']) {
      const j = await call(`/api/materialcheck/libraries?platform=${encodeURIComponent(pf)}`);
      j.libraries.forEach((l) => dir.push({ id: l.id, name: l.name, platform: pf }));
    }
    libraryDirectory = dir;
  }

  function libraryLabel(id) {
    if (!id) return '（迁移前/未知）';
    const l = libraryDirectory.find((x) => x.id === id);
    return l ? l.name : '（已删除的词库）';
  }

  async function renderHistory() {
    const el = A.$('#mc-history-view');
    el.innerHTML = '<p class="rv-empty">读取中…</p>';
    try {
      const [recJ] = await Promise.all([call('/api/materialcheck/records?limit=1000'), loadLibraryDirectory()]);
      historyRows = recJ.records;
    } catch (e) { el.innerHTML = ''; return A.toast(e.message, 'bad'); }

    el.innerHTML = `
      <div class="mc-filter-bar">
        <select id="mc-f-platform">
          <option value="">全部平台</option>
          <option value="tmall">天猫</option>
          <option value="jd">京东</option>
          <option value="__legacy__">（未知平台，旧记录）</option>
        </select>
        <select id="mc-f-library">
          <option value="">全部词库</option>
          ${libraryDirectory.map((l) => `<option value="${escapeHtml(l.id)}">${platformLabel(l.platform)} · ${escapeHtml(l.name)}</option>`).join('')}
          <option value="__legacy__">（迁移前/未知词库）</option>
        </select>
        <select id="mc-f-product"><option value="">全部产品</option>${products.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select>
        <select id="mc-f-status">
          <option value="">全部状态</option>
          <option value="pass">通过</option>
          <option value="warn">提醒</option>
          <option value="error">报错</option>
          <option value="fail">不通过（旧数据）</option>
          <option value="ocr_failed">识别失败</option>
        </select>
      </div>
      <div class="mc-history-list" id="mc-history-list"></div>`;

    const draw = () => {
      const plf = A.$('#mc-f-platform').value, lf = A.$('#mc-f-library').value, pf = A.$('#mc-f-product').value, sf = A.$('#mc-f-status').value;
      const shown = historyRows.filter((r) =>
        (!plf || (plf === '__legacy__' ? !r.platform : r.platform === plf)) &&
        (!lf || (lf === '__legacy__' ? !r.libraryId : r.libraryId === lf)) &&
        (!pf || r.productId === pf) &&
        (!sf || r.status === sf)
      );
      const list = A.$('#mc-history-list');
      if (!shown.length) { list.innerHTML = '<p class="rv-empty">没有匹配的记录</p>'; return; }
      const batches = new Map();
      shown.forEach((r, i) => {
        const key = r.batchId || '__legacy__';
        if (!batches.has(key)) batches.set(key, []);
        batches.get(key).push({ r, i });
      });
      list.innerHTML = Array.from(batches.entries()).map(([batchId, rows], batchIndex) => historyBatchHtml(batchId, rows, batchIndex)).join('');
      shown.forEach((r, i) => { list.querySelector(`[data-hi="${i}"]`).onclick = () => openHistoryDetail(r); });
    };
    A.$('#mc-f-platform').onchange = draw;
    A.$('#mc-f-library').onchange = draw;
    A.$('#mc-f-product').onchange = draw;
    A.$('#mc-f-status').onchange = draw;
    draw();
  }

  function platformLabel(p) {
    return p === 'tmall' ? '天猫' : p === 'jd' ? '京东' : '（未知平台）';
  }

  function historyRowHtml(r, i) {
    const meta = STATUS_META[r.status] || STATUS_META.error;
    return `<div class="mc-history-row ${meta.cls}" data-hi="${i}">
      <span class="mc-row-name">${escapeHtml(r.filename)}</span>
      <span class="mc-row-status">${meta.badge} · ${platformLabel(r.platform)} · ${escapeHtml(libraryLabel(r.libraryId))} · ${escapeHtml(r.productName || '')} · ${new Date(r.timestamp).toLocaleString('zh-CN')} · ${escapeHtml(r.uploadedBy)}</span>
    </div>`;
  }

  function historyBatchHtml(batchId, rows, batchIndex) {
    const latest = rows[0].r;
    const when = new Date(latest.timestamp).toLocaleString('zh-CN');
    const batchName = batchId === '__legacy__' ? '未标记上传批次' : `上传批次 · ${when}`;
    const batchHint = batchId === '__legacy__' ? '历史数据' : `${rows.length} 张素材`;
    return `<details class="mc-history-batch"${batchIndex === 0 ? ' open' : ''}>
      <summary><span class="mc-history-batch-title">${escapeHtml(batchName)}</span><span class="mc-history-batch-count">${escapeHtml(batchHint)}</span></summary>
      <div class="mc-history-batch-rows">${rows.map(({ r, i }) => historyRowHtml(r, i)).join('')}</div>
    </details>`;
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
    (r.extraKeywords || []).forEach((k) => {
      html = html.split(escapeHtml(k)).join(`<mark class="mc-mark-bad">${escapeHtml(k)}</mark>`);
    });
    const missing = (r.missingKeywords || []).map((k) => `<span class="mc-chip mc-chip-warn">${escapeHtml(k)}</span>`).join('') || '（无缺词）';
    const extra = (r.extraKeywords || []).map((k) => `<span class="mc-chip mc-chip-bad">${escapeHtml(k)}</span>`).join('') || '（无串词）';
    const unregistered = (r.unregisteredKeywords || []).map((k) => `<span class="mc-chip mc-chip-note">${escapeHtml(k)}</span>`).join('') || '（无未入库词）';
    const priceRow = r.priceIssue
      ? `<div class="mc-chip-row"><b>价格：</b><span class="mc-chip mc-chip-bad">${priceIssueLabel(r.priceIssue)}</span></div>`
      : '';
    detailBody.innerHTML = `
      <p><b>${escapeHtml(r.filename)}</b> · ${platformLabel(r.platform)} · ${escapeHtml(libraryLabel(r.libraryId))} · ${escapeHtml(r.productName || '')} · ${new Date(r.timestamp).toLocaleString('zh-CN')} ${sourcePreviewHtml(r.imagePath, r.filename)}</p>
      <div class="mc-chip-row"><b>缺词：</b>${missing}</div>
      <div class="mc-chip-row"><b>串词：</b>${extra}</div>
      <div class="mc-chip-row mc-unregistered-row"><b>未入库词：</b><span class="mc-unregistered-note">仅供核对，不影响通过</span>${unregistered}</div>
      ${priceRow}
      ${keywordDetailHtml(r.matchedKeywords, { open: true, emptyMessage: '这条历史记录没有保存逐词处理明细。' })}
      <pre class="mc-ocr-text">${html}</pre>`;
    wireSourcePreviews(detailBody);
    detailMask.hidden = false;
  }

  // ── 关键词库 ────────────────────────────────────────
  const CAT_CLASS = {
    '产品型号': 'mc-cat-model', '产品利益点': 'mc-cat-benefit', '日常销售利益点': 'mc-cat-daily',
    '大促销售权益': 'mc-cat-promo', '附加权益': 'mc-cat-extra', '国补': 'mc-cat-subsidy',
    '价格': 'mc-cat-price', '其它': 'mc-cat-other'
  };
  // 产品按类型分区展示：每个分区里先放该类型下自定义的共享分组，再放该类型下的产品卡片
  const TYPE_SECTIONS = [
    ['machine', '机器'],
    ['filter', '滤芯'],
    ['accessory', '附件']
  ];
  const VALID_TYPES = TYPE_SECTIONS.map(([v]) => v);
  /** 哪些分区被折叠了（点标题折叠/展开）。只是页面显示状态，不落盘，drawAll() 重画时靠这个 Set 保持住。 */
  let collapsedSections = new Set();

  const catOptionsHtml = CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('');
  const ratioOptionsHtml = RATIO_OPTIONS.map((r) => `<option value="${r}" ${r === 'both' ? 'selected' : ''}>${RATIO_LABEL[r]}</option>`).join('');

  /** 关键词编辑器：chip 展示 + 分类/比例徽标 + 输入/分类/比例下拉/添加按钮，产品卡片和通用词卡片共用同一份逻辑。 */
  function mountKeywordEditor(root, list, onChange) {
    const chipsEl = root.querySelector('[data-role="chips"]');
    const inputEl = root.querySelector('[data-role="kw-input"]');
    const catEl = root.querySelector('[data-role="kw-cat"]');
    const ratioEl = root.querySelector('[data-role="kw-ratio"]');
    const addBtn = root.querySelector('[data-role="kw-add"]');

    // 显示顺序按分类顺序来（产品型号→产品利益点→…），跟添加先后无关；
    // data-i 仍然指向 list 里的原始下标，删除/改分类操作按这个下标定位，不受显示顺序影响
    const drawChips = (enterIndex) => {
      const order = list.map((_, i) => i).sort((a, b) => CATEGORIES.indexOf(keywordCategory(list[a])) - CATEGORIES.indexOf(keywordCategory(list[b])));
      chipsEl.innerHTML = order.map((i) => {
        const k = list[i];
        const cat = keywordCategory(k);
        const ratio = keywordRatio(k);
        const catOpts = CATEGORIES.map((c) => `<option value="${c}" ${c === cat ? 'selected' : ''}>${c}</option>`).join('');
        const ratioOpts = RATIO_OPTIONS.map((r) => `<option value="${r}" ${r === ratio ? 'selected' : ''}>${RATIO_LABEL[r]}</option>`).join('');
        return `<span class="mc-chip${i === enterIndex ? ' mc-chip-enter' : ''}" data-i="${i}" data-cat="${escapeHtml(cat)}"><span class="mc-chip-text" data-i="${i}" title="点击编辑文字">${escapeHtml(keywordText(k))}</span><select class="mc-cat-badge-select ${CAT_CLASS[cat]}" data-i="${i}" aria-label="「${escapeHtml(keywordText(k))}」的分类">${catOpts}</select><select class="mc-ratio-badge-select ${RATIO_CLASS[ratio]}" data-i="${i}" aria-label="「${escapeHtml(keywordText(k))}」的适用比例">${ratioOpts}</select><button type="button" class="mc-chip-del" data-i="${i}" aria-label="删除关键词「${escapeHtml(keywordText(k))}」">×</button></span>`;
      }).join('') || '<span class="mc-chip-empty">还没有关键词</span>';
      if (enterIndex != null) {
        const enterEl = chipsEl.querySelector(`.mc-chip[data-i="${enterIndex}"]`);
        // 双 rAF：先让浏览器把"刚进场"的初始态（缩小/透明）画上一帧，下一帧再摘掉类触发过渡，
        // 否则类在同一次 innerHTML 赋值里就已经生效，浏览器观察不到状态变化，动画不会播放
        if (enterEl) requestAnimationFrame(() => requestAnimationFrame(() => enterEl.classList.remove('mc-chip-enter')));
      }
      // 关键词文字本身可以点开直接改，不用删了重加——单击文字部分变成输入框，
      // Enter/失焦提交，Esc 放弃；空文本不允许提交（跟新增关键词一个校验）
      chipsEl.querySelectorAll('.mc-chip-text').forEach((span) => (span.onclick = () => {
        if (span.querySelector('input')) return;
        const i = Number(span.dataset.i);
        const original = keywordText(list[i]);
        span.textContent = '';
        const input = document.createElement('input');
        input.className = 'mc-chip-text-input';
        input.value = original;
        // 按字符数算宽度（ch 单位）在中文场景下会严重偏窄——ch 是按西文"0"的宽度定义的，
        // 中文字符实际渲染宽度接近两个 ch，用字符数直接乘会让中文关键词的输入框挤成一团。
        // 改成拿一个不可见的镜像 span（继承同样的字体）量出真实渲染宽度，中英文混排也准。
        const measureEl = document.createElement('span');
        measureEl.className = 'mc-chip-text-measure';
        span.appendChild(measureEl);
        const sizeInput = () => {
          measureEl.textContent = input.value || ' ';
          input.style.width = (measureEl.offsetWidth + 16) + 'px';
        };
        span.appendChild(input);
        sizeInput();
        input.oninput = sizeInput;
        input.focus();
        input.select();
        let settled = false;
        const commit = () => {
          if (settled) return;
          settled = true;
          const v = input.value.trim();
          if (v && v !== original) {
            list[i] = { text: v, category: keywordCategory(list[i]), ratio: keywordRatio(list[i]) };
            drawChips();
            if (onChange) onChange();
          } else {
            drawChips();
          }
        };
        input.onblur = commit;
        input.onkeydown = (e) => {
          // stopPropagation：这个输入框在浮窗里时，Esc 不能既取消文字编辑
          // 又被浮窗那层全局监听器当成"关闭整个浮窗"，一次按键只该有一个效果
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); settled = true; drawChips(); }
        };
      }));
      chipsEl.querySelectorAll('.mc-cat-badge-select').forEach((sel) => (sel.onchange = () => {
        const i = Number(sel.dataset.i);
        list[i] = { text: keywordText(list[i]), category: sel.value, ratio: keywordRatio(list[i]) };
        drawChips();
        if (onChange) onChange();
      }));
      chipsEl.querySelectorAll('.mc-ratio-badge-select').forEach((sel) => (sel.onchange = () => {
        const i = Number(sel.dataset.i);
        list[i] = { text: keywordText(list[i]), category: keywordCategory(list[i]), ratio: sel.value };
        drawChips();
        if (onChange) onChange();
      }));
      chipsEl.querySelectorAll('.mc-chip-del').forEach((x) => (x.onclick = () => {
        const i = Number(x.dataset.i);
        const chipEl = chipsEl.querySelector(`.mc-chip[data-i="${i}"]`);
        const removeNow = () => {
          list.splice(i, 1);
          drawChips();
          if (onChange) onChange();
        };
        if (!chipEl) return removeNow();
        chipEl.classList.add('mc-chip-leaving');
        setTimeout(removeNow, 150);
      }));
    };
    drawChips();

    const add = () => {
      const v = inputEl.value.trim();
      if (!v) return;
      list.push({ text: v, category: catEl.value, ratio: ratioEl ? ratioEl.value : 'both' });
      inputEl.value = '';
      drawChips(list.length - 1);
      if (onChange) onChange();
    };
    addBtn.onclick = add;
    inputEl.onkeydown = (e) => { if (e.key === 'Enter') add(); };
  }

  /** 产品原来的类型主要通过所在分区决定；这个下拉框只用来纠错、把产品挪到别的分区，
   *  所以只列真实类型，"未分类"只在产品当前确实没归类时才作为一个可见选项出现（不能手动挪回未分类）。 */
  function typeMoveOptionsHtml(current) {
    const opts = TYPE_SECTIONS.map(([v, label]) => [v, label]);
    if (!VALID_TYPES.includes(current)) opts.unshift(['', '未分类']);
    return opts.map(([v, label]) => `<option value="${v}" ${current === v ? 'selected' : ''}>${label}</option>`).join('');
  }

  let autoSaveTimer = null;

  /** 立即保存当前关键词库。silent=true 用于自动保存：不重画整个页面、不拿服务端返回值
   *  覆盖本地 products——这个变量正被卡片上的 input/checkbox 事件处理器直接引用着，
   *  贸然重新赋值会让后续编辑写到已经跟 DOM 脱钩的旧对象上，静默保存失败或者页面上
   *  敲的字丢了都不会有提示。手动点"保存关键词库"才做完整刷新。 */
  async function saveLibraryNow({ silent = false } = {}) {
    const errEl = A.$('#mc-lib-error');
    try {
      const saved = await call(`/api/materialcheck/products?platform=${encodeURIComponent(platform)}&libraryId=${encodeURIComponent(libraryId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products })
      });
      if (errEl) errEl.hidden = true;
      if (!silent) {
        products = saved.products;
        await loadLibraries();
        renderLibrarySwitch();
        A.toast('关键词库已保存');
        renderLibrary();
      }
    } catch (e) {
      if (errEl) { errEl.hidden = false; errEl.textContent = e.message; }
    }
  }

  /** 停顿 0.7 秒自动保存一次，节奏跟价格带沙盘/竞品对位页面的自动保存一致。 */
  function scheduleAutoSave() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => saveLibraryNow({ silent: true }), 700);
  }

  /** 有待触发的自动保存定时器时立即执行，不用等 0.7 秒——浮窗里切换到下一个/
   *  上一个产品前用这个，避免刚改完还没落盘的内容因为立刻挪走节点而丢失。 */
  function flushAutoSave() {
    if (!autoSaveTimer) return;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    saveLibraryNow({ silent: true });
  }

  /** 卡片封面图：手动传的封面（imageUrl）优先，其次是最近一条已匹配到这个产品的检测记录图（autoImage）；
   *  两者都没有就是占位图标——分区色底 + 完整产品名（不再缩成首字，名字长的话最多显示三行）。 */
  function productCoverHtml(p) {
    const src = p.imageUrl || p.autoImage;
    if (src) return `<img data-role="cover-img" src="${escapeHtml(src)}" alt="" loading="lazy">`;
    const name = escapeHtml(String(p.name || '').trim() || '未命名产品');
    return `<div class="mc-pcard-cover-empty" data-role="cover-empty">${name}</div>`;
  }

  /** 封面操作按钮：删除封面只在确实传过手动封面（imageUrl）时才出现——
   *  没传过就没什么好删的，删了也只是退回 autoImage/占位图，不是清空数据。 */
  function coverActionsHtml(p) {
    return `
      <div class="mc-pcard-cover-actions">
        <button type="button" class="mc-pcard-cover-btn" data-role="cover-btn" title="更换封面图">更换封面</button>
        ${p.imageUrl ? '<button type="button" class="mc-pcard-cover-btn" data-role="cover-remove" title="删除封面图，恢复自动封面">删除封面</button>' : ''}
      </div>`;
  }

  /** 产品卡片：siblings 是同一批产品（未分类区就是未分类的那批），用来生成"复制到…"的目标产品列表和拖拽排序范围。 */
  function productCardHtml(p, siblings) {
    const copyTargets = (siblings || []).filter((s) => s.id !== p.id);
    const copyOptionsHtml = copyTargets.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    return `
      <div class="mc-pcard" data-pid="${escapeHtml(p.id)}">
        <div class="mc-pcard-cover" data-role="cover">
          ${productCoverHtml(p)}
          ${coverActionsHtml(p)}
          <input type="file" class="mc-pcard-cover-file" data-role="cover-file" accept="image/png,image/jpeg,image/webp" aria-label="上传「${escapeHtml(p.name)}」的封面图" hidden>
        </div>
        <button type="button" class="mc-pcard-expand-btn" data-role="expand" title="放大编辑" aria-label="放大编辑「${escapeHtml(p.name)}」">⛶</button>
        <div class="mc-pcard-body">
          <div class="mc-pcard-head">
            <button type="button" class="mc-pcard-handle" data-role="handle" aria-label="拖动调整「${escapeHtml(p.name)}」的顺序" title="拖动调整顺序">⠿</button>
            <input class="mc-pcard-name" data-role="name" value="${escapeHtml(p.name)}" placeholder="名称/型号…" aria-label="产品名称 / 型号">
            <input class="mc-pcard-price" data-role="price" type="number" min="0" step="1" value="${p.price != null ? p.price : ''}" placeholder="价格" aria-label="预期价格" title="设置后会强校验：素材图里的价格必须跟这个一致，不一致直接判报错">
            <span class="mc-pcard-count" data-role="count">${p.keywords.length} 词</span>
            <select class="mc-pcard-move" data-role="move" aria-label="移到其它分区" title="移到其它分区">${typeMoveOptionsHtml(p.type || '')}</select>
            <button class="mc-btn" data-role="copy-to" ${copyTargets.length ? '' : 'disabled'}>复制到…</button>
            <button class="mc-btn mc-btn-danger mc-pcard-del" data-role="del">删除</button>
          </div>
          <div class="mc-copy-row" data-role="copy-row" hidden>
            <select data-role="copy-target" aria-label="复制关键词到哪个产品">${copyOptionsHtml}</select>
            <button class="mc-btn mc-btn-primary" data-role="copy-confirm">确定覆盖</button>
            <button class="mc-btn" data-role="copy-cancel">取消</button>
          </div>
          <div class="mc-pcard-kwrow">
            <input class="mc-kw-input-inline" placeholder="输入关键词…" data-role="kw-input" aria-label="输入关键词">
            <select class="mc-cat-select" data-role="kw-cat" aria-label="关键词分类">${catOptionsHtml}</select>
            <select class="mc-ratio-select" data-role="kw-ratio" aria-label="关键词适用比例" title="这个词只出现在1:1或3:4素材里，还是两种都要求？">${ratioOptionsHtml}</select>
            <button class="mc-btn" data-role="kw-add">添加</button>
          </div>
          <div class="mc-chip-editor-wrap">
            <div class="mc-chip-editor" data-role="chips"></div>
          </div>
        </div>
      </div>`;
  }

  function typeSectionHtml([type, label]) {
    const collapsed = collapsedSections.has(type);
    return `
      <div class="mc-tsection mc-tsec-${type}${collapsed ? ' mc-tsection-collapsed' : ''}" data-type="${type}">
        <div class="mc-tsection-head">
          <button type="button" class="mc-tsection-toggle" data-role="toggle-section" aria-expanded="${collapsed ? 'false' : 'true'}">
            <span class="mc-tsection-chevron" aria-hidden="true">▾</span>
            <h3>${label}</h3>
          </button>
          <span class="mc-tsection-actions">
            <button class="mc-btn" data-role="add-product">+ 新增产品</button>
          </span>
        </div>
        <div class="mc-tsection-body" data-role="body">
          <div class="mc-tsection-body-inner">
            <div class="mc-pcards-grid" data-role="products"></div>
          </div>
        </div>
      </div>`;
  }

  // ── 产品卡片展开浮窗——不是重新渲染一份内容，是把点开的那张卡片的
  //    .mc-pcard-cover / .mc-pcard-body 两个节点原样挪进浮窗的两个槽位里，
  //    关闭时再挪回卡片原来的位置。这样关键词编辑器（mountKeywordEditor）
  //    绑定的 DOM 引用、闭包里的 onChange/自动保存都还是同一套，不用另外
  //    维护一份浮窗专用的状态或重新 mount 一次。 ──
  let expandMask, expandCoverSlot, expandBodySlot, expandedCard;
  let expandLegendEl, legendActiveCat = null;

  /** 光标在任何输入控件里时，方向键应该只是移动光标/选项，不该被浮窗的
   *  上一个/下一个快捷键抢走。 */
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  /** 浮窗里"上一个/下一个"按的是当前网格里实际显示的卡片顺序（跨分区连续），
   *  不是 products 数组的原始顺序——用户眼睛看到的排列跟切换顺序要一致。 */
  function expandGridCards() {
    return [...document.querySelectorAll('#mc-library-view .mc-pcard')];
  }

  function expandNeighbor(dir) {
    const cards = expandGridCards();
    const idx = cards.indexOf(expandedCard);
    if (idx === -1) return null;
    const j = idx + dir;
    return (j >= 0 && j < cards.length) ? cards[j] : null;
  }

  function updateExpandNavButtons() {
    const cards = expandGridCards();
    const idx = cards.indexOf(expandedCard);
    expandMask.querySelector('#mc-expand-prev').disabled = idx <= 0;
    expandMask.querySelector('#mc-expand-next').disabled = idx === -1 || idx >= cards.length - 1;
  }

  /** 分类图例：数每个分类当前渲染出来几个 chip（直接数 DOM，不用另外拿 keywords 数组），
   *  数量为 0 的分类不显示图例项。点一个分类：其它图例变灰，右侧对应分类的 chip
   *  放大突出、其余 chip 变灰变淡但留在原位；再点一次已选中的取消筛选。
   *  不侵入 mountKeywordEditor 内部逻辑——图例状态全靠外部监听 DOM 变化重算。 */
  function legendCounts() {
    const counts = {};
    CATEGORIES.forEach((c) => (counts[c] = 0));
    expandBodySlot.querySelectorAll('.mc-chip[data-cat]').forEach((el) => {
      if (counts[el.dataset.cat] != null) counts[el.dataset.cat]++;
    });
    return counts;
  }

  function renderExpandLegend() {
    if (!expandLegendEl || !expandedCard) return;
    const counts = legendCounts();
    expandLegendEl.innerHTML = CATEGORIES.filter((c) => counts[c] > 0).map((c) => {
      const cls = [CAT_CLASS[c]];
      if (c === legendActiveCat) cls.push('mc-legend-active');
      else if (legendActiveCat) cls.push('mc-legend-dim');
      return `<button type="button" class="mc-legend-item ${cls.join(' ')}" data-cat="${escapeHtml(c)}">` +
        `<span class="mc-legend-swatch"></span><span class="mc-legend-label">${escapeHtml(c)}</span><span class="mc-legend-count">${counts[c]}</span></button>`;
    }).join('');
    expandLegendEl.querySelectorAll('.mc-legend-item').forEach((btn) => (btn.onclick = () => {
      const c = btn.dataset.cat;
      legendActiveCat = legendActiveCat === c ? null : c;
      renderExpandLegend();
      applyLegendFilterToChips();
    }));
  }

  function applyLegendFilterToChips() {
    expandBodySlot.querySelectorAll('.mc-chip[data-cat]').forEach((chip) => {
      const match = chip.dataset.cat === legendActiveCat;
      chip.classList.toggle('mc-chip-legend-focus', !!legendActiveCat && match);
      chip.classList.toggle('mc-chip-legend-dim', !!legendActiveCat && !match);
    });
  }

  /** 切换到相邻产品：先把当前产品的未落盘修改立即存掉（不等 0.7 秒的自动保存定时器），
   *  再把封面/内容节点从旧卡片挪到新卡片，中间配合 CSS 类做一次轻微滑动+淡入淡出。 */
  function switchExpand(dir) {
    const target = expandNeighbor(dir);
    if (!target) return;
    flushAutoSave();
    const goingNext = dir > 0;
    const layout = expandMask.querySelector('.mc-expand-layout');
    layout.classList.add(goingNext ? 'mc-expand-slide-out-left' : 'mc-expand-slide-out-right');
    setTimeout(() => {
      const oldCard = expandedCard;
      oldCard.appendChild(expandCoverSlot.querySelector('.mc-pcard-cover'));
      oldCard.appendChild(expandBodySlot.querySelector('.mc-pcard-body'));
      oldCard.classList.remove('mc-pcard-expanding');

      expandedCard = target;
      legendActiveCat = null; // 切换产品后图例筛选状态清空，避免带着上一个产品的分类筛选看新产品
      expandCoverSlot.appendChild(target.querySelector('.mc-pcard-cover'));
      expandBodySlot.appendChild(target.querySelector('.mc-pcard-body'));
      target.classList.add('mc-pcard-expanding');

      layout.classList.remove('mc-expand-slide-out-left', 'mc-expand-slide-out-right');
      layout.classList.add(goingNext ? 'mc-expand-slide-in-right' : 'mc-expand-slide-in-left');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        layout.classList.remove('mc-expand-slide-in-right', 'mc-expand-slide-in-left');
      }));
      updateExpandNavButtons();
    }, 160);
  }

  function buildExpandSheet() {
    expandMask = document.createElement('div');
    expandMask.className = 'sheet-mask mc-expand-mask';
    expandMask.hidden = true;
    expandMask.innerHTML = `
      <div class="mc-expand-sheet" role="dialog" aria-label="放大编辑产品">
        <button type="button" class="mc-expand-close" id="mc-expand-close" title="关闭">×</button>
        <button type="button" class="mc-expand-nav mc-expand-prev" id="mc-expand-prev" title="上一个产品" aria-label="上一个产品">‹</button>
        <button type="button" class="mc-expand-nav mc-expand-next" id="mc-expand-next" title="下一个产品" aria-label="下一个产品">›</button>
        <div class="mc-expand-layout">
          <div class="mc-expand-cover-slot" data-role="cover-slot">
            <div class="mc-expand-legend" data-role="legend"></div>
          </div>
          <div class="mc-expand-body-slot" data-role="body-slot"></div>
        </div>
      </div>`;
    document.body.appendChild(expandMask);
    expandCoverSlot = expandMask.querySelector('[data-role="cover-slot"]');
    expandBodySlot = expandMask.querySelector('[data-role="body-slot"]');
    expandLegendEl = expandMask.querySelector('[data-role="legend"]');
    expandMask.querySelector('#mc-expand-close').onclick = closeExpand;
    expandMask.querySelector('#mc-expand-prev').onclick = () => switchExpand(-1);
    expandMask.querySelector('#mc-expand-next').onclick = () => switchExpand(1);
    expandMask.onclick = (e) => { if (e.target === expandMask) closeExpand(); };
    document.addEventListener('keydown', (e) => {
      if (!expandMask || expandMask.hidden) return;
      if (e.key === 'Escape') { closeExpand(); return; }
      if (isTypingTarget(document.activeElement)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); switchExpand(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); switchExpand(1); }
    });
    // 关键词区任何重绘（新增/删除/改分类/文字改名，都走 drawChips() 的 innerHTML 整体替换）
    // 都会触发这个 childList 变化，图例的分类计数、当前筛选高亮跟着自动重算，
    // 不用在 mountKeywordEditor 内部埋一个图例专用的回调。
    new MutationObserver(() => {
      renderExpandLegend();
      applyLegendFilterToChips();
    }).observe(expandBodySlot, { childList: true, subtree: true });
  }

  function openExpand(card) {
    if (!expandMask) buildExpandSheet();
    expandedCard = card;
    legendActiveCat = null;
    expandCoverSlot.appendChild(card.querySelector('.mc-pcard-cover'));
    expandBodySlot.appendChild(card.querySelector('.mc-pcard-body'));
    card.classList.add('mc-pcard-expanding');
    expandMask.hidden = false;
    updateExpandNavButtons();
  }

  function closeExpand() {
    if (!expandedCard) return;
    expandedCard.appendChild(expandCoverSlot.querySelector('.mc-pcard-cover'));
    expandedCard.appendChild(expandBodySlot.querySelector('.mc-pcard-body'));
    expandedCard.classList.remove('mc-pcard-expanding');
    expandedCard = null;
    legendActiveCat = null;
    expandMask.hidden = true;
  }

  // ── 批量自动识别（词库维护动作，不写检测记录，也不直接改真实词库——
  //    候选词先进审核页，人工确认后才走已有的保存关键词库接口落盘） ──
  let autobuildMask, autobuildBody;
  function stripSpaces(s) { return String(s || '').replace(/\s+/g, ''); }

  function buildAutobuildSheet() {
    autobuildMask = document.createElement('div');
    autobuildMask.className = 'sheet-mask';
    autobuildMask.hidden = true;
    autobuildMask.innerHTML = `
      <div class="sheet sheet-wide" role="dialog">
        <div class="sheet-head"><h2>批量自动识别</h2><button class="kill" id="mc-ab-close" title="关闭">×</button></div>
        <div class="sheet-body" id="mc-ab-body"></div>
      </div>`;
    document.body.appendChild(autobuildMask);
    autobuildBody = autobuildMask.querySelector('#mc-ab-body');
    autobuildMask.querySelector('#mc-ab-close').onclick = () => (autobuildMask.hidden = true);
    autobuildMask.onclick = (e) => { if (e.target === autobuildMask) autobuildMask.hidden = true; };
  }

  /** 按产品分组候选词：同一个产品可能有好几张图，候选词要合并去重（按去空格后的文字）。
   *  每个候选词带着扫描它那张图所属的比例入口（e.ratio）；同一个词如果在 1:1 和 3:4
   *  两边的扫描里都出现过，说明是两种素材共用的，升级成"通用"。 */
  function autobuildGroups(entries) {
    const groups = new Map();
    entries.forEach((e) => {
      if (e.status !== 'resolved' || !e.candidates.length) return;
      let g = groups.get(e.productId);
      if (!g) { g = { productName: e.productName, cands: new Map() }; groups.set(e.productId, g); }
      e.candidates.forEach((text) => {
        const norm = stripSpaces(text);
        const existing = g.cands.get(norm);
        if (!existing) g.cands.set(norm, { text, checked: true, ratio: e.ratio });
        else if (existing.ratio !== e.ratio) existing.ratio = 'both';
      });
    });
    return groups;
  }

  function drawAutobuildReview(entries) {
    const scanning = entries.filter((e) => e.status === 'scanning');
    const unresolved = entries.filter((e) => e.status === 'unresolved');
    const errored = entries.filter((e) => e.status === 'error');
    const groups = autobuildGroups(entries);
    const doneCount = entries.length - scanning.length;

    let html = '';
    if (scanning.length) {
      html += `<div class="mc-progress"><div class="mc-progress-bar" style="width:${Math.round((doneCount / entries.length) * 100)}%"></div></div>
        <p class="rv-empty">识别中… ${doneCount}/${entries.length}</p>`;
    }

    if (unresolved.length) {
      html += `<h3>无法判断产品，需要手动指定（${unresolved.length}）</h3>`;
      html += unresolved.map((e) => {
        const pool = e.candidateProducts.length ? e.candidateProducts : products;
        const opts = pool.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
        return `<div class="mc-ab-unresolved" data-eid="${e.eid}">
          <span class="mc-row-name">${escapeHtml(e.filename)}</span>
          <select class="mc-pick-select" data-role="pick"><option value="">— 选择产品 —</option>${opts}</select>
          <button class="mc-btn" data-role="pick-confirm">确定</button>
        </div>`;
      }).join('');
    }

    if (errored.length) {
      html += `<h3>识别失败（${errored.length}）</h3>` + errored.map((e) =>
        `<div class="mc-ab-unresolved"><span class="mc-row-name">${escapeHtml(e.filename)}</span><span class="mc-row-status">${escapeHtml(e.errorMsg)}</span></div>`
      ).join('');
    }

    if (groups.size) {
      html += `<h3>识别出的候选关键词（默认全选，取消勾选不需要的）</h3>`;
      html += [...groups.entries()].map(([pid, g]) => {
        const items = [...g.cands.entries()];
        return `<div class="mc-ab-group" data-pid="${escapeHtml(pid)}">
          <div class="mc-ab-group-head">${escapeHtml(g.productName)}<span class="mc-pcard-count">${items.length} 条新候选</span></div>
          <div class="mc-ab-cands">${items.map(([norm, c]) =>
            `<label class="mc-ab-cand"><input type="checkbox" data-norm="${escapeHtml(norm)}" ${c.checked ? 'checked' : ''}>${escapeHtml(c.text)}<span class="mc-ab-cand-ratio ${RATIO_CLASS[c.ratio]}">${RATIO_LABEL[c.ratio]}</span></label>`
          ).join('')}</div>
        </div>`;
      }).join('');
    } else if (!scanning.length && !unresolved.length) {
      html += '<p class="rv-empty">没有识别出新的候选关键词</p>';
    }

    const canConfirm = !scanning.length && groups.size > 0;
    html += `<div class="mc-ab-actions">
      <button class="mc-btn" id="mc-ab-cancel">取消</button>
      <button class="mc-btn mc-btn-primary" id="mc-ab-confirm" ${canConfirm ? '' : 'disabled'}>确认导入</button>
    </div>`;

    autobuildBody.innerHTML = html;

    autobuildBody.querySelectorAll('[data-role="pick-confirm"]').forEach((btn) => {
      btn.onclick = async () => {
        const wrap = btn.closest('.mc-ab-unresolved');
        const e = entries.find((x) => x.eid === wrap.dataset.eid);
        const productId = wrap.querySelector('[data-role="pick"]').value;
        if (!productId) return A.toast('先选一个产品', 'bad');
        const product = products.find((p) => p.id === productId);
        try {
          const j = await call('/api/materialcheck/autobuild/candidates', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform, libraryId, productId, ocrText: e.ocrText })
          });
          e.status = 'resolved';
          e.productId = productId;
          e.productName = product ? product.name : '';
          e.candidates = j.candidates;
        } catch (err) { A.toast(err.message, 'bad'); }
        drawAutobuildReview(entries);
      };
    });

    autobuildBody.querySelectorAll('.mc-ab-group').forEach((groupEl) => {
      const g = groups.get(groupEl.dataset.pid);
      groupEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.onchange = () => { g.cands.get(cb.dataset.norm).checked = cb.checked; };
      });
    });

    const cancelBtn = autobuildBody.querySelector('#mc-ab-cancel');
    if (cancelBtn) cancelBtn.onclick = () => { autobuildMask.hidden = true; };

    const confirmBtn = autobuildBody.querySelector('#mc-ab-confirm');
    if (confirmBtn && !confirmBtn.disabled) {
      confirmBtn.onclick = () => {
        let addedCount = 0;
        groups.forEach((g, pid) => {
          const product = products.find((p) => p.id === pid);
          if (!product) return;
          g.cands.forEach((c) => {
            if (!c.checked) return;
            product.keywords.push({ text: c.text, category: '其它', ratio: c.ratio });
            addedCount++;
          });
        });
        autobuildMask.hidden = true;
        A.toast(`已导入 ${addedCount} 条新关键词，正在保存…`);
        saveLibraryNow({ silent: false });
      };
    }
  }

  let autobuildSeq = 0;

  async function openAutobuild(fileList, ratio) {
    if (!products.length) return A.toast('先去下面新增至少一个产品，再批量识别', 'bad');
    if (!autobuildMask) buildAutobuildSheet();
    const entries = fileList.map((file) => ({
      eid: 'e' + (autobuildSeq++), file, filename: file.name, status: 'scanning', ratio,
      productId: null, productName: null, candidates: [], candidateProducts: [], ocrText: '', errorMsg: ''
    }));
    autobuildMask.hidden = false;
    drawAutobuildReview(entries);

    const scanPlatform = platform, scanLibraryId = libraryId;
    async function scanOne(e) {
      try {
        const result = await call(`/api/materialcheck/autobuild/scan?filename=${encodeURIComponent(e.filename)}&platform=${encodeURIComponent(scanPlatform)}&libraryId=${encodeURIComponent(scanLibraryId)}&ratio=${encodeURIComponent(e.ratio)}`, {
          method: 'POST', headers: { 'Content-Type': e.file.type }, body: e.file
        });
        if (result.ratioMismatch) A.toast(`${e.filename}：${result.ratioMismatch}`, 'bad');
        e.ocrText = result.ocrText;
        if (result.productId) {
          e.status = 'resolved';
          e.productId = result.productId;
          e.productName = result.productName;
          e.candidates = result.candidates;
        } else {
          e.status = 'unresolved';
          e.candidateProducts = result.candidateProducts || [];
        }
      } catch (err) {
        e.status = 'error';
        e.errorMsg = err.message;
      }
      drawAutobuildReview(entries);
    }

    const CONCURRENCY = 3;
    let cursor = 0;
    async function worker() {
      while (cursor < entries.length) {
        const idx = cursor++;
        await scanOne(entries[idx]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  }

  async function renderLibrary() {
    const el = A.$('#mc-library-view');
    const role = libraryRole();
    if (role === 'none') { el.innerHTML = '<p class="rv-empty">没有查看关键词库的权限</p>'; return; }
    const readOnly = role !== 'edit';

    el.innerHTML = `
      <div class="${readOnly ? 'mc-lib-disabled' : ''}">
        ${readOnly ? '<p class="mc-warning">你只有查看权限，改动不会被保存——找管理员开编辑权限。</p>' : ''}
        <div class="mc-lib-actionbar">
          <div class="mc-lib-ops">
            <button class="mc-btn" id="mc-lib-op-new">+ 新建词库</button>
            <button class="mc-btn" id="mc-lib-op-copy">复制词库</button>
            <button class="mc-btn" id="mc-lib-op-rename">重命名</button>
            <button class="mc-btn mc-btn-danger" id="mc-lib-op-delete">删除词库</button>
          </div>
          <div class="mc-lib-name-row" id="mc-lib-name-row" hidden>
            <input id="mc-lib-name-input" placeholder="词库名称…" aria-label="词库名称">
            <button class="mc-btn mc-btn-primary" id="mc-lib-name-confirm">确定</button>
            <button class="mc-btn" id="mc-lib-name-cancel">取消</button>
          </div>
          <span class="mc-lib-spacer"></span>
          <button class="mc-btn" id="mc-lib-autobuild-11">批量识别 1:1 素材…</button>
          <button class="mc-btn" id="mc-lib-autobuild-34">批量识别 3:4 素材…</button>
          <input type="file" id="mc-autobuild-file-11" accept="image/png,image/jpeg,image/webp" multiple hidden>
          <input type="file" id="mc-autobuild-file-34" accept="image/png,image/jpeg,image/webp" multiple hidden>
          <button class="mc-btn mc-btn-primary" id="mc-lib-save">保存关键词库</button>
        </div>
        <p class="mc-lib-error" id="mc-lib-error" hidden></p>
        <div id="mc-tsections"></div>
        <div class="mc-tsection mc-tsec-none" id="mc-tsec-none" hidden>
          <div class="mc-tsection-head"><h3>未分类</h3></div>
          <div class="mc-pcards-grid" data-role="products"></div>
        </div>
      </div>`;

    const productsOfType = (type) => type
      ? products.filter((p) => p.type === type)
      : products.filter((p) => !VALID_TYPES.includes(p.type));

    /** 把 orderedIds（拖拽后某个分区/未分类列表的新顺序）写回全局 products 数组：
     *  这个分区涉及的产品整体搬到它们原来所在的第一个位置，不打乱其它分区产品的相对顺序。 */
    const applyReorder = (list, orderedIds) => {
      const idSet = new Set(list.map((p) => p.id));
      const firstIdx = products.findIndex((p) => idSet.has(p.id));
      const rest = products.filter((p) => !idSet.has(p.id));
      const ordered = orderedIds.map((id) => list.find((p) => p.id === id));
      rest.splice(firstIdx, 0, ...ordered);
      products = rest;
    };

    /** 原生拖拽排序，范围限定在同一个分区/未分类列表内部；不重新整体 drawAll()，
     *  拖拽过程本身已经把 DOM 顺序调整好了，dragend 时只需要把最终顺序同步回数据并触发自动保存。
     *  卡片现在是多列网格，"插到前面还是后面"不能只看 Y 轴了：同一行内比较 X 轴，
     *  跨行才看 Y 轴——用被拖过的卡片跟当前悬停卡片顶边是否接近来判断是不是同一行。 */
    const wireDragReorder = (wrap, list) => {
      let dragCard = null;
      [...wrap.querySelectorAll('.mc-pcard')].forEach((card) => {
        const handle = card.querySelector('[data-role="handle"]');
        if (!handle) return;
        handle.draggable = true;
        handle.addEventListener('dragstart', (e) => {
          dragCard = card;
          card.classList.add('mc-pcard-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', card.dataset.pid);
        });
        handle.addEventListener('dragend', () => {
          card.classList.remove('mc-pcard-dragging');
          if (dragCard) {
            const orderedIds = [...wrap.querySelectorAll('.mc-pcard')].map((c) => c.dataset.pid);
            applyReorder(list, orderedIds);
            scheduleAutoSave();
          }
          dragCard = null;
        });
        card.addEventListener('dragover', (e) => {
          if (!dragCard || dragCard === card) return;
          e.preventDefault();
          const rect = card.getBoundingClientRect();
          const dragRect = dragCard.getBoundingClientRect();
          const sameRow = Math.abs(rect.top - dragRect.top) < rect.height / 2;
          const before = sameRow ? (e.clientX - rect.left) < rect.width / 2 : (e.clientY - rect.top) < rect.height / 2;
          wrap.insertBefore(dragCard, before ? card : card.nextSibling);
        });
      });
    };

    const mountProductCards = (root, type) => {
      const wrap = root.querySelector('[data-role="products"]');
      const list = productsOfType(type);
      wrap.innerHTML = list.map((p) => productCardHtml(p, list)).join('') || (type ? '<p class="rv-empty">还没有产品，点上面「+ 新增产品」</p>' : '');
      [...wrap.querySelectorAll('.mc-pcard')].forEach((card, i) => {
        const p = list[i];
        card.querySelector('[data-role="expand"]').onclick = () => openExpand(card);
        card.querySelector('[data-role="name"]').oninput = (e) => {
          p.name = e.target.value;
          scheduleAutoSave();
        };
        card.querySelector('[data-role="price"]').oninput = (e) => {
          const v = e.target.value.trim();
          p.price = v === '' ? null : Number(v);
          scheduleAutoSave();
        };
        card.querySelector('[data-role="move"]').onchange = (e) => { p.type = e.target.value; drawAll(); scheduleAutoSave(); };
        // 词数徽标在 .mc-pcard-body 里——卡片展开时这个节点被挪进了浮窗，
        // 不再是 card 的子节点，所以这里要在挂载时就把引用存住，而不是每次
        // onChange 都从 card 重新查一遍（挪走之后 card.querySelector 会找不到，
        // 加/删/改关键词只要是在展开态下做的都会当场报错）
        const countEl = card.querySelector('[data-role="count"]');
        mountKeywordEditor(card, p.keywords, () => {
          countEl.textContent = `${p.keywords.length} 词`;
          scheduleAutoSave();
        });
        // 封面图：优先级最高的是这里手动传的（imageUrl），复用已有的通用图片直传接口，
        // 不经过素材质检自己的 OCR 流水线——这只是换一张展示图，不是要发起一次检测。
        // "更换封面"/"删除封面"按钮是否显示取决于当前有没有手动封面，改动后要整体重画
        // 封面区（图/占位 + 操作按钮），所以抽成 refreshCover 统一处理，两条路径都调它。
        const cover = card.querySelector('[data-role="cover"]');
        const coverFile = card.querySelector('[data-role="cover-file"]');
        const wireCoverButtons = () => {
          cover.querySelector('[data-role="cover-btn"]').onclick = () => coverFile.click();
          const removeBtn = cover.querySelector('[data-role="cover-remove"]');
          if (removeBtn) removeBtn.onclick = () => {
            p.imageUrl = null;
            refreshCover();
            scheduleAutoSave();
          };
        };
        const refreshCover = () => {
          cover.querySelectorAll('[data-role="cover-img"], [data-role="cover-empty"], .mc-pcard-cover-actions').forEach((n) => n.remove());
          cover.insertAdjacentHTML('afterbegin', productCoverHtml(p));
          coverFile.insertAdjacentHTML('beforebegin', coverActionsHtml(p));
          wireCoverButtons();
        };
        wireCoverButtons();
        coverFile.onchange = async (e) => {
          const file = e.target.files[0];
          e.target.value = '';
          if (!file) return;
          try {
            const result = await call('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
            p.imageUrl = result.url;
            refreshCover();
            scheduleAutoSave();
          } catch (err) { A.toast(err.message, 'bad'); }
        };
        card.querySelector('[data-role="del"]').onclick = () => {
          card.classList.add('mc-pcard-leaving');
          setTimeout(() => {
            products = products.filter((x) => x.id !== p.id);
            drawAll();
            scheduleAutoSave();
          }, 160);
        };
        const copyBtn = card.querySelector('[data-role="copy-to"]');
        if (copyBtn && !copyBtn.disabled) {
          const copyRow = card.querySelector('[data-role="copy-row"]');
          copyBtn.onclick = () => { copyRow.hidden = !copyRow.hidden; };
          card.querySelector('[data-role="copy-cancel"]').onclick = () => { copyRow.hidden = true; };
          card.querySelector('[data-role="copy-confirm"]').onclick = () => {
            const targetId = card.querySelector('[data-role="copy-target"]').value;
            if (!targetId) return;
            const target = products.find((x) => x.id === targetId);
            if (!confirm(`这会覆盖「${target.name}」当前的所有关键词，确定吗？`)) return;
            target.keywords = JSON.parse(JSON.stringify(p.keywords));
            A.toast(`已把关键词复制到「${target.name}」`);
            drawAll();
            scheduleAutoSave();
          };
        }
      });
      wireDragReorder(wrap, list);
    };

    const renderSections = () => {
      const tsecWrap = A.$('#mc-tsections');
      tsecWrap.innerHTML = TYPE_SECTIONS.map(typeSectionHtml).join('');
      TYPE_SECTIONS.forEach(([type]) => {
        const root = tsecWrap.querySelector(`.mc-tsection[data-type="${type}"]`);

        const toggleBtn = root.querySelector('[data-role="toggle-section"]');
        toggleBtn.onclick = () => {
          if (collapsedSections.has(type)) collapsedSections.delete(type); else collapsedSections.add(type);
          const nowCollapsed = collapsedSections.has(type);
          root.classList.toggle('mc-tsection-collapsed', nowCollapsed);
          toggleBtn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        };

        mountProductCards(root, type);
        root.querySelector('[data-role="add-product"]').onclick = () => {
          products.push({ id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2), name: '新产品', type, keywords: [], price: null });
          drawAll();
          scheduleAutoSave();
        };
      });

      const noneSec = A.$('#mc-tsec-none');
      const noneList = productsOfType('');
      noneSec.hidden = noneList.length === 0;
      if (noneList.length) mountProductCards(noneSec, '');
    };

    // FLIP：新增/删除/换分区/复制这些会整体重画的操作，靠"重画前记住旧位置→重画后
    // 把每张卡片瞬间摆回旧位置→下一帧统一松开做位移过渡"制造"平滑挪动"的错觉，
    // 而不是真的逐帧计算布局。新出现的卡片没有旧位置可比，走淡入+缩放的进场动画。
    const drawAll = () => {
      // 新增/删除/挪分区这些操作的按钮就长在卡片的 .mc-pcard-body 里，展开态时
      // 这个节点正待在浮窗里——重画前先把它挪回卡片、关掉浮窗，避免整个网格被
      // 重新渲染之后，浮窗还攥着一个已经从 DOM 里摘掉的旧节点。
      closeExpand();
      const before = new Map([...el.querySelectorAll('.mc-pcard')].map((c) => [c.dataset.pid, c.getBoundingClientRect()]));
      renderSections();
      const cards = [...el.querySelectorAll('.mc-pcard')];
      cards.forEach((c) => {
        const old = before.get(c.dataset.pid);
        if (!old) { c.classList.add('mc-pcard-enter'); return; }
        const now = c.getBoundingClientRect();
        const dx = old.left - now.left, dy = old.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        c.style.transition = 'none';
        c.style.transform = `translate(${dx}px, ${dy}px)`;
      });
      void el.offsetHeight; // 强制回流，钉住上面摆好的旧位置，避免直接跳到新位置
      requestAnimationFrame(() => {
        cards.forEach((c) => {
          c.style.transition = 'transform var(--slow)';
          c.style.transform = '';
          c.classList.remove('mc-pcard-enter');
        });
        // 位移动画播完之后把内联 transition 清掉，不然它会一直只声明 transform 一个属性，
        // 盖掉样式表里 hover 时阴影/边框颜色本该有的过渡
        setTimeout(() => cards.forEach((c) => { c.style.transition = ''; }), 450);
      });
    };

    drawAll();

    // 请求进行中禁用按钮，避免网络慢的时候重复点击发出重复请求；正常收尾走 renderLibrary() 整体重画，
    // 这里的 finally 主要是兜底失败路径（renderLibrary 不会跑，按钮必须自己恢复可点）
    const withBusy = (btn, fn) => async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try { await fn(); }
      finally { btn.disabled = false; }
    };

    // 词库操作：新建/复制/重命名共用同一条内联输入行，删除走 confirm() 二次确认
    let opMode = null;
    const nameRow = A.$('#mc-lib-name-row');
    const nameInput = A.$('#mc-lib-name-input');
    const showNameRow = (mode, prefill = '') => { opMode = mode; nameRow.hidden = false; nameInput.value = prefill; nameInput.focus(); };
    const hideNameRow = () => { opMode = null; nameRow.hidden = true; nameInput.value = ''; };

    A.$('#mc-lib-op-new').onclick = () => showNameRow('new');
    A.$('#mc-lib-op-copy').onclick = () => showNameRow('copy');
    A.$('#mc-lib-op-rename').onclick = () => showNameRow('rename', libraries.find((l) => l.id === libraryId)?.name || '');
    A.$('#mc-lib-name-cancel').onclick = hideNameRow;

    const confirmName = async () => {
      const name = nameInput.value.trim();
      if (!name) return A.toast('名字不能为空', 'bad');
      clearTimeout(autoSaveTimer); // 新建/复制/重命名都会切到别的词库，清掉还没触发的自动保存
      try {
        if (opMode === 'new') {
          const lib = await call(`/api/materialcheck/libraries?platform=${encodeURIComponent(platform)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
          });
          libraryId = lib.id;
          sessionStorage.setItem(`mc-library-${platform}`, libraryId);
          await loadLibraries();
          await loadProducts();
          A.toast('已新建词库');
        } else if (opMode === 'copy') {
          const lib = await call(`/api/materialcheck/libraries/copy?platform=${encodeURIComponent(platform)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: libraryId, name })
          });
          libraryId = lib.id;
          sessionStorage.setItem(`mc-library-${platform}`, libraryId);
          await loadLibraries();
          await loadProducts();
          A.toast('已复制词库');
        } else if (opMode === 'rename') {
          await call(`/api/materialcheck/libraries/rename?platform=${encodeURIComponent(platform)}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: libraryId, name })
          });
          await loadLibraries();
          A.toast('已重命名');
        }
        renderLibrarySwitch();
        hideNameRow();
        renderLibrary();
      } catch (e) { A.toast(e.message, 'bad'); }
    };
    const nameConfirmBtn = A.$('#mc-lib-name-confirm');
    nameConfirmBtn.onclick = withBusy(nameConfirmBtn, confirmName);
    nameInput.onkeydown = (e) => { if (e.key === 'Enter') confirmName(); if (e.key === 'Escape') hideNameRow(); };

    const deleteBtn = A.$('#mc-lib-op-delete');
    deleteBtn.onclick = withBusy(deleteBtn, async () => {
      const lib = libraries.find((l) => l.id === libraryId);
      if (!confirm(`删除词库「${lib?.name}」？里面的产品和关键词都会被删掉，且不可恢复。`)) return;
      clearTimeout(autoSaveTimer); // 词库都要被删了，别再让待触发的自动保存往它身上存
      try {
        await call(`/api/materialcheck/libraries?platform=${encodeURIComponent(platform)}&id=${encodeURIComponent(libraryId)}`, { method: 'DELETE' });
        await loadLibraries();
        renderLibrarySwitch();
        await loadProducts();
        A.toast('已删除词库');
        renderLibrary();
      } catch (e) { A.toast(e.message, 'bad'); }
    });

    const saveBtn = A.$('#mc-lib-save');
    saveBtn.onclick = withBusy(saveBtn, async () => {
      clearTimeout(autoSaveTimer); // 手动保存立即执行，不用再等那个待触发的自动保存
      await saveLibraryNow({ silent: false });
    });

    if (!readOnly) {
      [['11', '1:1'], ['34', '3:4']].forEach(([suffix, ratio]) => {
        const abFile = A.$(`#mc-autobuild-file-${suffix}`);
        A.$(`#mc-lib-autobuild-${suffix}`).onclick = () => abFile.click();
        abFile.onchange = (e) => {
          const files = [...e.target.files];
          e.target.value = '';
          if (files.length) openAutobuild(files, ratio);
        };
      });
    }
  }

  function init(api) {
    A = api;
    A.$('#mc-tab-library').hidden = libraryRole() === 'none';
    A.$$('#mc-subview-switch .mc-subtab').forEach((b) => (b.onclick = () => switchSub(b.dataset.sub)));

    platform = sessionStorage.getItem('mc-platform') || 'tmall';
    const platformSwitch = A.$('#mc-platform-switch');
    platformSwitch.value = platform;
    platformSwitch.onchange = () => switchPlatform(platformSwitch.value);

    const librarySwitch = A.$('#mc-library-switch');
    librarySwitch.onchange = () => switchLibrary(librarySwitch.value);

    renderCheckView();
    (async () => {
      try {
        await loadLibraries();
        renderLibrarySwitch();
        await loadProducts();
        renderCheckView();
      } catch (e) { A.toast(e.message, 'bad'); }
    })();
  }

  return { init };
})();
