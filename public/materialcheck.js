const MaterialCheck = (() => {
  let A, subView = 'check', platform = 'tmall', libraryId = null;
  let libraries = []; // 当前平台下的词库列表 [{id,name,productCount}]
  let libraryDirectory = []; // 历史记录筛选用：两个平台全部词库的扁平列表 [{id,name,platform}]
  let products = [], universalKeywords = [], groups = [];

  const CATEGORIES = ['产品型号', '产品利益点', '日常销售利益点', '大促销售权益', '附加权益', '国补', '价格', '其它'];
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
    universalKeywords = j.universalKeywords;
    groups = j.groups;
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
  function renderCheckView() {
    const el = A.$('#mc-check-view');
    el.innerHTML = `
      <div class="mc-upload-zone" id="mc-upload-zone">点击选择图片，或把图片拖进这个区域（支持多选批量上传）</div>
      <div class="mc-batch-summary" id="mc-batch-summary"></div>
      <div class="mc-progress" id="mc-progress" hidden><div class="mc-progress-bar" id="mc-progress-bar"></div></div>
      <div id="mc-result-list"></div>`;
    A.$('#mc-upload-zone').onclick = () => A.$('#mc-file').click();
  }

  async function uploadFiles(fileList) {
    if (!products.length) return A.toast('先去「关键词库」配置至少一个产品', 'bad');
    const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const uploadPlatform = platform;
    const uploadLibraryId = libraryId;
    const list = A.$('#mc-result-list');
    const summary = A.$('#mc-batch-summary');
    const progress = A.$('#mc-progress');
    const progressBar = A.$('#mc-progress-bar');

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
        const result = await call(`/api/materialcheck/upload?filename=${encodeURIComponent(entry.file.name)}&batchId=${encodeURIComponent(batchId)}&platform=${encodeURIComponent(uploadPlatform)}&libraryId=${encodeURIComponent(uploadLibraryId)}`, {
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

    const meta = STATUS_META[result.status] || STATUS_META.error;
    const failed = result.status === 'ocr_failed';
    row.className = 'mc-row ' + meta.cls;
    const methodLabel = { filename: '文件名', ocr: 'OCR文字', manual: '人工选择' }[result.matchMethod] || '';

    let detail = '';
    if (result.missingKeywords?.length) {
      detail += `<div class="mc-chip-row">缺词：${result.missingKeywords.map((k) => `<span class="mc-chip mc-chip-warn">${escapeHtml(k)}</span>`).join('')}</div>`;
    }
    if (result.crossedKeywords?.length) {
      detail += `<div class="mc-chip-row">串词：${result.crossedKeywords.map((c) => `<span class="mc-chip mc-chip-bad">${escapeHtml(c.keyword)} · 属于「${escapeHtml(c.fromProductName)}」</span>`).join('')}</div>`;
    }
    if (result.warning) detail += `<div class="mc-warning">⚠ ${escapeHtml(result.warning)}</div>`;

    row.innerHTML = `
      <span class="mc-row-name">${escapeHtml(result.filename)}</span>
      <span class="mc-row-status">${meta.badge} · ${escapeHtml(result.productName || '')}${methodLabel ? ' · 匹配方式：' + methodLabel : ''}${failed ? ' <button class="mc-btn mc-row-retry">重试</button>' : ''}</span>
      ${detail}`;

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
      list.innerHTML = shown.map((r, i) => historyRowHtml(r, i)).join('');
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
    const missing = (r.missingKeywords || []).map((k) => `<span class="mc-chip mc-chip-warn">${escapeHtml(k)}</span>`).join('') || '（无缺词）';
    const crossed = (r.crossedKeywords || []).map((c) => `<span class="mc-chip mc-chip-bad">${escapeHtml(c.keyword)} · 属于「${escapeHtml(c.fromProductName)}」</span>`).join('') || '（无串词）';
    detailBody.innerHTML = `
      <p><b>${escapeHtml(r.filename)}</b> · ${platformLabel(r.platform)} · ${escapeHtml(libraryLabel(r.libraryId))} · ${escapeHtml(r.productName || '')} · ${new Date(r.timestamp).toLocaleString('zh-CN')}</p>
      <div class="mc-chip-row"><b>缺词：</b>${missing}</div>
      <div class="mc-chip-row"><b>串词：</b>${crossed}</div>
      <pre class="mc-ocr-text">${html}</pre>`;
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

  /** 关键词编辑器：chip 展示 + 分类徽标 + 输入/分类下拉/添加按钮，产品卡片和通用词卡片共用同一份逻辑。 */
  function mountKeywordEditor(root, list, onChange) {
    const chipsEl = root.querySelector('[data-role="chips"]');
    const inputEl = root.querySelector('[data-role="kw-input"]');
    const catEl = root.querySelector('[data-role="kw-cat"]');
    const addBtn = root.querySelector('[data-role="kw-add"]');

    // 显示顺序按分类顺序来（产品型号→产品利益点→…），跟添加先后无关；
    // data-i 仍然指向 list 里的原始下标，删除操作按这个下标定位，不受显示顺序影响
    const drawChips = () => {
      const order = list.map((_, i) => i).sort((a, b) => CATEGORIES.indexOf(keywordCategory(list[a])) - CATEGORIES.indexOf(keywordCategory(list[b])));
      chipsEl.innerHTML = order.map((i) => {
        const k = list[i];
        return `<span class="mc-chip">${escapeHtml(keywordText(k))}<small class="mc-cat-badge ${CAT_CLASS[keywordCategory(k)]}">${escapeHtml(keywordCategory(k))}</small><button type="button" class="mc-chip-del" data-i="${i}" aria-label="删除关键词「${escapeHtml(keywordText(k))}」">×</button></span>`;
      }).join('') || '<span class="mc-chip-empty">还没有关键词</span>';
      chipsEl.querySelectorAll('.mc-chip-del').forEach((x) => (x.onclick = () => {
        list.splice(Number(x.dataset.i), 1);
        drawChips();
        if (onChange) onChange();
      }));
    };
    drawChips();

    const add = () => {
      const v = inputEl.value.trim();
      if (!v) return;
      list.push({ text: v, category: catEl.value });
      inputEl.value = '';
      drawChips();
      if (onChange) onChange();
    };
    addBtn.onclick = add;
    inputEl.onkeydown = (e) => { if (e.key === 'Enter') add(); };
  }

  function keywordAddRowHtml() {
    return `
      <div class="mc-kw-add">
        <input placeholder="输入关键词…" data-role="kw-input" aria-label="输入关键词">
        <select class="mc-cat-select" data-role="kw-cat" aria-label="关键词分类">${catOptionsHtml}</select>
        <button class="mc-btn" data-role="kw-add">添加</button>
      </div>`;
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
   *  覆盖本地 products/universalKeywords/groups——这几个变量正被卡片上的 input/checkbox
   *  事件处理器直接引用着，贸然重新赋值会让后续编辑写到已经跟 DOM 脱钩的旧对象上，
   *  静默保存失败或者页面上敲的字丢了都不会有提示。手动点"保存关键词库"才做完整刷新。 */
  async function saveLibraryNow({ silent = false } = {}) {
    const errEl = A.$('#mc-lib-error');
    try {
      const saved = await call(`/api/materialcheck/products?platform=${encodeURIComponent(platform)}&libraryId=${encodeURIComponent(libraryId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products, universalKeywords, groups })
      });
      if (errEl) errEl.hidden = true;
      if (!silent) {
        products = saved.products; universalKeywords = saved.universalKeywords; groups = saved.groups;
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

  /** 产品卡片：groupsOfType 用来显示"当前属于哪个分组"（分组成员是在分组卡片上勾选的，这里只读展示）；
   *  siblings 是同一批产品（未分类区就是未分类的那批），用来生成"复制到…"的目标产品列表和拖拽排序范围。 */
  function productCardHtml(p, groupsOfType, siblings) {
    const group = (groupsOfType || []).find((g) => g.id === p.groupId);
    const groupLabel = group ? `<span class="mc-pcard-group">分组：${escapeHtml(group.name)}</span>` : '';
    const copyTargets = (siblings || []).filter((s) => s.id !== p.id);
    const copyOptionsHtml = copyTargets.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    return `
      <div class="mc-pcard" data-pid="${escapeHtml(p.id)}">
        <div class="mc-pcard-head">
          <button type="button" class="mc-pcard-handle" data-role="handle" aria-label="拖动调整「${escapeHtml(p.name)}」的顺序" title="拖动调整顺序">⠿</button>
          <input class="mc-pcard-name" data-role="name" value="${escapeHtml(p.name)}" placeholder="名称/型号…" aria-label="产品名称 / 型号">
          <input class="mc-kw-input-inline" placeholder="输入关键词…" data-role="kw-input" aria-label="输入关键词">
          <select class="mc-cat-select" data-role="kw-cat" aria-label="关键词分类">${catOptionsHtml}</select>
          <button class="mc-btn" data-role="kw-add">添加</button>
          <span class="mc-pcard-count" data-role="count">${p.keywords.length} 词</span>
        </div>
        <div class="mc-pcard-sub">
          <select class="mc-pcard-move" data-role="move" aria-label="移到其它分区" title="移到其它分区">${typeMoveOptionsHtml(p.type || '')}</select>
          ${groupLabel}
          <span class="mc-pcard-sub-spacer"></span>
          <button class="mc-btn" data-role="copy-to" ${copyTargets.length ? '' : 'disabled'}>复制到…</button>
          <button class="mc-btn mc-btn-danger mc-pcard-del" data-role="del">删除</button>
        </div>
        <div class="mc-copy-row" data-role="copy-row" hidden>
          <select data-role="copy-target" aria-label="复制关键词到哪个产品">${copyOptionsHtml}</select>
          <button class="mc-btn mc-btn-primary" data-role="copy-confirm">确定覆盖</button>
          <button class="mc-btn" data-role="copy-cancel">取消</button>
        </div>
        <div class="mc-chip-editor" data-role="chips"></div>
      </div>`;
  }

  /** 分组卡片：勾选成员（只列同类型下的产品）+ 一份组内共享关键词，替代原来固定的"XX组通用词"。 */
  function groupCardHtml(g, typeProducts) {
    const memberBoxes = (typeProducts || []).map((p) => `
        <label class="mc-gmember">
          <input type="checkbox" data-role="member" data-pid="${escapeHtml(p.id)}" ${p.groupId === g.id ? 'checked' : ''}>
          <span data-role="mname">${escapeHtml(p.name)}</span>
        </label>`).join('') || '<span class="mc-chip-empty">这个分区还没有产品</span>';
    return `
      <div class="mc-gcard" data-gid="${escapeHtml(g.id)}">
        <div class="mc-gcard-head">
          <input class="mc-gcard-name" data-role="gname" value="${escapeHtml(g.name)}" placeholder="分组名称…" aria-label="分组名称">
          <button class="mc-btn mc-btn-danger" data-role="gdel">删除分组</button>
        </div>
        <p class="mc-utab-hint">勾选属于这个分组的产品，组内成员之间共用下面这些词，不算缺词/串词</p>
        <div class="mc-gmembers" data-role="gmembers">${memberBoxes}</div>
        <div class="mc-chip-editor" data-role="chips"></div>
        ${keywordAddRowHtml()}
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
            <button class="mc-btn" data-role="add-group">+ 新建分组</button>
            <button class="mc-btn" data-role="add-product">+ 新增产品</button>
          </span>
        </div>
        <div class="mc-tsection-body" data-role="body">
          <div class="mc-gcards" data-role="groups"></div>
          <div class="mc-pcards-scroll" data-role="products"></div>
        </div>
      </div>`;
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
          <button class="mc-btn mc-btn-primary" id="mc-lib-save">保存关键词库</button>
        </div>
        <p class="mc-lib-error" id="mc-lib-error" hidden></p>
        <div class="mc-lib-card mc-lib-universal" data-role="universal-card">
          <h3>全局通用词</h3>
          <p class="mc-utab-hint">任何产品图上出现都不算问题</p>
          <div class="mc-chip-editor" data-role="chips"></div>
          ${keywordAddRowHtml()}
        </div>
        <div id="mc-tsections"></div>
        <div class="mc-tsection mc-tsec-none" id="mc-tsec-none" hidden>
          <div class="mc-tsection-head"><h3>未分类</h3></div>
          <div class="mc-pcards-scroll" data-role="products"></div>
        </div>
      </div>`;

    const productsOfType = (type) => type
      ? products.filter((p) => p.type === type)
      : products.filter((p) => !VALID_TYPES.includes(p.type));

    const groupsOfType = (type) => groups.filter((g) => g.type === type);

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
     *  拖拽过程本身已经把 DOM 顺序调整好了，dragend 时只需要把最终顺序同步回数据并触发自动保存。 */
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
          const before = (e.clientY - rect.top) < rect.height / 2;
          wrap.insertBefore(dragCard, before ? card : card.nextSibling);
        });
      });
    };

    const mountProductCards = (root, type) => {
      const wrap = root.querySelector('[data-role="products"]');
      const list = productsOfType(type);
      const typeGroups = type ? groupsOfType(type) : [];
      wrap.innerHTML = list.map((p) => productCardHtml(p, typeGroups, list)).join('') || (type ? '<p class="rv-empty">还没有产品，点上面「+ 新增产品」</p>' : '');
      [...wrap.querySelectorAll('.mc-pcard')].forEach((card, i) => {
        const p = list[i];
        card.querySelector('[data-role="name"]').oninput = (e) => {
          p.name = e.target.value;
          // 分组卡片上的勾选项标签是改名时直接patch的文字节点，不是靠drawAll()整体重画——
          // 重画会打断正在输入的名称输入框的光标位置/焦点
          root.querySelectorAll(`[data-role="member"][data-pid="${p.id}"]`).forEach((cb) => {
            const nameSpan = cb.parentElement.querySelector('[data-role="mname"]');
            if (nameSpan) nameSpan.textContent = p.name;
          });
          scheduleAutoSave();
        };
        card.querySelector('[data-role="move"]').onchange = (e) => { p.type = e.target.value; p.groupId = null; drawAll(); scheduleAutoSave(); };
        mountKeywordEditor(card, p.keywords, () => {
          card.querySelector('[data-role="count"]').textContent = `${p.keywords.length} 词`;
          scheduleAutoSave();
        });
        card.querySelector('[data-role="del"]').onclick = () => {
          products = products.filter((x) => x.id !== p.id);
          drawAll();
          scheduleAutoSave();
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

    const drawAll = () => {
      mountKeywordEditor(A.$('[data-role="universal-card"]'), universalKeywords, () => scheduleAutoSave());

      const tsecWrap = A.$('#mc-tsections');
      tsecWrap.innerHTML = TYPE_SECTIONS.map(typeSectionHtml).join('');
      TYPE_SECTIONS.forEach(([type]) => {
        const root = tsecWrap.querySelector(`.mc-tsection[data-type="${type}"]`);
        const typeGroups = groupsOfType(type);
        const typeProducts = productsOfType(type);

        const toggleBtn = root.querySelector('[data-role="toggle-section"]');
        toggleBtn.onclick = () => {
          if (collapsedSections.has(type)) collapsedSections.delete(type); else collapsedSections.add(type);
          const nowCollapsed = collapsedSections.has(type);
          root.classList.toggle('mc-tsection-collapsed', nowCollapsed);
          toggleBtn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        };

        const gwrap = root.querySelector('[data-role="groups"]');
        gwrap.innerHTML = typeGroups.map((g) => groupCardHtml(g, typeProducts)).join('');
        typeGroups.forEach((g) => {
          const gcard = gwrap.querySelector(`[data-gid="${g.id}"]`);
          mountKeywordEditor(gcard, g.keywords, () => scheduleAutoSave());
          gcard.querySelector('[data-role="gname"]').oninput = (e) => { g.name = e.target.value; scheduleAutoSave(); };
          gcard.querySelectorAll('[data-role="member"]').forEach((cb) => {
            cb.onchange = (e) => {
              const product = products.find((x) => x.id === e.target.dataset.pid);
              product.groupId = e.target.checked ? g.id : null;
              drawAll();
              scheduleAutoSave();
            };
          });
          gcard.querySelector('[data-role="gdel"]').onclick = () => {
            if (!confirm(`删除分组「${g.name}」？组内产品会变回未分组，这个分组的共享词会一并清除。`)) return;
            products.forEach((p) => { if (p.groupId === g.id) p.groupId = null; });
            groups = groups.filter((x) => x.id !== g.id);
            drawAll();
            scheduleAutoSave();
          };
        });
        root.querySelector('[data-role="add-group"]').onclick = () => {
          groups.push({ id: 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2), name: '新分组', type, keywords: [] });
          drawAll();
          scheduleAutoSave();
        };

        mountProductCards(root, type);
        root.querySelector('[data-role="add-product"]').onclick = () => {
          products.push({ id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2), name: '新产品', type, groupId: null, keywords: [] });
          drawAll();
          scheduleAutoSave();
        };
      });

      const noneSec = A.$('#mc-tsec-none');
      const noneList = productsOfType('');
      noneSec.hidden = noneList.length === 0;
      if (noneList.length) mountProductCards(noneSec, '');
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
  }

  function init(api) {
    A = api;
    A.$('#mc-tab-library').hidden = libraryRole() === 'none';
    A.$$('#mc-subview-switch .mc-subtab').forEach((b) => (b.onclick = () => switchSub(b.dataset.sub)));
    A.$('#mc-file').onchange = (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) uploadFiles(files); };

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
