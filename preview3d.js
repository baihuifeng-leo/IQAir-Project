/* ═══════════════════════════════════════════════════════════
   preview3d.js — 竞品 3D 预览
   三个轴分别显示颗粒物CADR、甲醛CADR、价格哪个维度，以及每个轴
   显示的文字，都可以在「⚙ 坐标轴」里自定义——默认是价格摆在竖直
   方向（视觉纵轴），水平面两个方向是颗粒物CADR、甲醛CADR，跟这个
   项目一直以来的习惯一致，但不再是写死的。
   注意 ECharts-GL 的 3D 坐标系里，视觉上"竖起来"的那根轴技术上
   其实是 zAxis3D，xAxis3D/yAxis3D 才是水平面的两个方向——axisMap
   里的 x/y/z 对应的正是这三个技术轴，不要被"z 是竖的"这个直觉
   误导（在这里 z 确实是竖的，但那是因为默认把价格分给了 z，不是
   技术轴名本身决定的）。
   气泡大小可以在「性价比 / 5-6月销售额 / 5-6月销量」三种口径
   之间切换：三个轴的空间已经占满了，销售表现这两项新数据改用
   气泡大小来承载，而不是硬塞成第四根轴。
   ═══════════════════════════════════════════════════════════ */
const Preview3D = (() => {
  let A, data = null, chart = null, ro = null, sizeMode = 'costEff', autoRotate = true, fullscreenOn = false;
  const hidden = new Set();   // 被隐藏（取消勾选）的品牌

  // ECharts 的 label.fontFamily 走 Canvas 2D 的 font 属性，不认 CSS 的
  // var(--f-mono)，这里把 styles.css 里同一个等宽字体栈抄一份过来。
  const FONT_MONO = 'ui-monospace, "JetBrains Mono", "SFMono-Regular", "Cascadia Mono", Consolas, monospace';

  /* ── 坐标轴：三个数据维度可以自由分配到 x/y/z 三个轴，每个轴
     显示的文字也能自定义——跟 sizeMode/autoRotate 一样是纯前端的
     会话状态，不持久化，刷新页面回到默认（价格＝z、颗粒物＝x、
     甲醛＝y），保持跟这个视图其它设置一致的行为方式。 ── */
  const DIMS = {
    pmCadr: { label: '颗粒物 CADR', short: '颗粒物CADR' },
    hchoCadr: { label: '甲醛 CADR', short: '甲醛CADR' },
    price: { label: '价格 (¥)', short: '价格' }
  };
  let axisMap = { x: 'pmCadr', y: 'hchoCadr', z: 'price' };
  const axisLabels = { pmCadr: DIMS.pmCadr.label, hchoCadr: DIMS.hchoCadr.label, price: DIMS.price.label };

  const SIZE_MODES = {
    costEff: { label: '性价比', calc: (p) => (p.price > 0 ? ((p.pmCadr + p.hchoCadr) / p.price) * 1000 : 0), fmt: (v) => v.toFixed(1), hint: '气泡越大，性价比（两项CADR之和 / 价格）越高。' },
    sales: { label: '销售额', calc: (p) => p.sales || 0, fmt: (v) => `¥${Math.round(v).toLocaleString()}`, hint: '气泡越大，5-6月销售额越高。' },
    qty: { label: '销量', calc: (p) => p.qty || 0, fmt: (v) => Math.round(v).toLocaleString(), hint: '气泡越大，5-6月销量越高。' }
  };

  async function call(url, opts) {
    const r = A.guard(await fetch(url, opts));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '请求失败');
    return j;
  }

  const withCostEff = (p) => ({ ...p, costEff: p.price > 0 ? ((p.pmCadr + p.hchoCadr) / p.price) * 1000 : 0 });

  /**
   * 标题颜色跟气泡色走，但深色背景 + 深色品牌色（比如深棕、深灰）
   * 直接拿来做文字会糊、看不清——跟白色按亮度差值混一部分提亮，
   * 亮的品牌色（比如青色、黄色）本来就清楚，不用动；只在暗的时候
   * 补亮，色相还是那个品牌色，不会变成大家都一个颜色。
   */
  function labelColor(hex) {
    const h = String(hex || '').replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) || 0, g = parseInt(h.slice(2, 4), 16) || 0, b = parseInt(h.slice(4, 6), 16) || 0;
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    if (yiq >= 150) return hex;
    const mix = 0.65 - (yiq / 150) * 0.35; // 越暗混得越多，最暗混 65%，刚好够 150 门槛的混 30%
    const nr = Math.round(r + (255 - r) * mix), ng = Math.round(g + (255 - g) * mix), nb = Math.round(b + (255 - b) * mix);
    return `rgb(${nr}, ${ng}, ${nb})`;
  }

  /* ── 图表配置 ───────────────────────────────────────── */
  const axisStyle = (scale) => ({
    axisLine: { lineStyle: { color: '#33456a' } },
    splitLine: { lineStyle: { color: '#17203292' } },
    axisLabel: { color: '#79879f', fontSize: 11 * scale },
    nameTextStyle: { color: '#e9eef8', fontSize: 12.5 * scale, fontWeight: 600, padding: [0, 0, 0, 0] },
    axisPointer: { lineStyle: { color: '#4ee0c1' } }
  });

  function buildOption() {
    const mode = SIZE_MODES[sizeMode];
    const all = data.products.filter((p) => p.price > 0).map(withCostEff);
    const shown = all.filter((p) => !hidden.has(p.brand));
    const vals = shown.map((p) => mode.calc(p));
    const lo = Math.min(...vals, 0), hi = Math.max(...vals, 1);
    // 全屏是给「看细节」用的，光靠画布变大不够——气泡本身的基础大小和标签字号
    // 也要跟着放大一档，不然占屏比例反而变小，越看越费劲
    const scale = fullscreenOn ? 1.5 : 1;
    const AXIS = axisStyle(scale);
    const size = (v) => (15 + Math.sqrt(Math.max(0, (v - lo) / ((hi - lo) || 1))) * 34) * scale;

    const points = shown.map((p) => ({
      name: `${p.brand} ${p.model}`,
      value: [p[axisMap.x], p[axisMap.y], p[axisMap.z]],
      brand: p.brand, model: p.model, price: p.price, pmCadr: p.pmCadr, hchoCadr: p.hchoCadr,
      costEff: p.costEff, sales: p.sales || 0, qty: p.qty || 0, url: p.url,
      itemStyle: { color: p.color, opacity: 0.9 },
      symbolSize: size(mode.calc(p)),
      // 标题颜色跟着气泡自己的品牌色走，不再统一用一个灰白色——
      // 之前气泡五颜六色、标题却都是一个色，看着是两张皮；换成
      // 等宽字体 + 品牌色，标题和气泡才像一个整体。
      // 试过再加 textShadowBlur 做"发光"，Canvas 2D 画多行文字时
      // 阴影会跟粗描边糊成一整块实心矩形，跟 tooltip 那种 CSS 阴影
      // 完全是两个效果（CSS 是精细的发光描边，Canvas 的 shadowBlur
      // 是对整个绘制路径做模糊扩散）——这条路走不通，去掉了。
      label: {
        show: true, formatter: `${p.brand}\n${p.model}`, position: 'top', distance: 7 * scale, lineHeight: 15 * scale,
        color: labelColor(p.color), fontFamily: FONT_MONO, fontSize: 11.5 * scale, fontWeight: 600,
        textBorderColor: '#0b1220', textBorderWidth: 2.5
      }
    }));

    return {
      backgroundColor: 'transparent',
      tooltip: {
        formatter: (pr) => {
          const d = pr.data;
          return `<div class="p3d-tip">
            <div class="p3d-tip-head" style="color:${d.itemStyle.color}">${esc(d.brand)}</div>
            <div class="p3d-tip-model">${esc(d.model)}</div>
            <div class="p3d-tip-row"><span>颗粒物 CADR</span><b>${d.pmCadr.toLocaleString()}</b></div>
            <div class="p3d-tip-row"><span>甲醛 CADR</span><b>${d.hchoCadr.toLocaleString()}</b></div>
            <div class="p3d-tip-row"><span>价格</span><b>¥${d.price.toLocaleString()}</b></div>
            <div class="p3d-tip-row${sizeMode === 'costEff' ? ' cur' : ''}"><span>性价比指数${sizeMode === 'costEff' ? ' ●' : ''}</span><b>${d.costEff.toFixed(1)}</b></div>
            <div class="p3d-tip-row${sizeMode === 'sales' ? ' cur' : ''}"><span>5-6月销售额${sizeMode === 'sales' ? ' ●' : ''}</span><b>¥${Math.round(d.sales).toLocaleString()}</b></div>
            <div class="p3d-tip-row${sizeMode === 'qty' ? ' cur' : ''}"><span>5-6月销量${sizeMode === 'qty' ? ' ●' : ''}</span><b>${Math.round(d.qty).toLocaleString()}</b></div>
            ${d.url ? '<div class="p3d-tip-link">点击气泡跳转商品页 ↗</div>' : ''}
          </div>`;
        },
        backgroundColor: '#101725f2', borderColor: '#1f2b42', borderWidth: 1, padding: 0,
        extraCssText: 'box-shadow:0 20px 44px -18px #000;border-radius:10px;'
      },
      xAxis3D: { type: 'value', name: axisLabels[axisMap.x] || DIMS[axisMap.x].label, min: 0, ...AXIS },
      yAxis3D: { type: 'value', name: axisLabels[axisMap.y] || DIMS[axisMap.y].label, min: 0, ...AXIS },
      zAxis3D: { type: 'value', name: axisLabels[axisMap.z] || DIMS[axisMap.z].label, min: 0, ...AXIS },
      grid3D: {
        boxWidth: 100, boxHeight: 76, boxDepth: 76,
        environment: 'transparent',
        axisLine: { lineStyle: { color: '#33456a' } },
        splitLine: { show: true, lineStyle: { color: '#17203292' } },
        viewControl: {
          autoRotate, autoRotateSpeed: 5, autoRotateAfterStill: 2.5,
          distance: 215, alpha: 20, beta: 30, damping: 0.86,
          panSensitivity: 0.8, zoomSensitivity: 0.9
        },
        light: {
          main: { intensity: 1.15, shadow: false, alpha: 30, beta: 20 },
          ambient: { intensity: 0.45 }
        },
        postEffect: { enable: true, SSAO: { enable: true, radius: 4, intensity: 1.1 } },
        temporalSuperSampling: { enable: true }
      },
      series: [{
        type: 'scatter3D',
        data: points,
        symbol: 'circle',
        emphasis: { itemStyle: { opacity: 1, borderWidth: 1.5, borderColor: '#fff' } }
      }]
    };
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ── 渲染 ───────────────────────────────────────────── */
  function ensureChart() {
    if (chart) return chart;
    const box = A.$('#p3d-chart');
    chart = echarts.init(box, null, { renderer: 'canvas' });
    chart.on('click', (params) => {
      if (params.data && params.data.url) window.open(params.data.url, '_blank', 'noopener');
    });
    if (!ro) {
      // 折叠/展开左侧工作台是 CSS transition（420ms）连续变宽度，容器尺寸
      // 每一帧都在变，ResizeObserver 也就每一帧都触发一次——2D 图表 resize
      // 很便宜感觉不出来，但这是 WebGL + SSAO 后处理 + 超采样的 3D 图，
      // 420ms 里被这么高频重绘就会看着卡。等尺寸稳定了再重绘一次就够了。
      let resizeTimer = null;
      ro = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => chart && chart.resize(), 120);
      });
      ro.observe(box);
    }
    return chart;
  }

  function render() {
    renderAxisDesc();
    const empty = A.$('#p3d-empty'), box = A.$('#p3d-chart');
    if (!data || !data.products.length) {
      empty.hidden = false;
      box.hidden = true;
      return;
    }
    empty.hidden = true;
    box.hidden = false;
    ensureChart().setOption(buildOption(), true);
    renderStats();
  }

  function renderStats() {
    const bar = A.$('#p3d-stats');
    if (!data || !data.products.length) { bar.innerHTML = ''; return; }
    const prices = data.products.map((p) => p.price).filter((n) => n > 0);
    const tiles = [
      [data.products.length, '产品数'],
      [data.brands.length, '品牌数'],
      [`¥${Math.min(...prices).toLocaleString()} – ¥${Math.max(...prices).toLocaleString()}`, '价格区间'],
      [hidden.size ? `${data.brands.length - hidden.size} / ${data.brands.length}` : '全部', '当前展示品牌']
    ];
    bar.innerHTML = '';
    tiles.forEach(([v, k]) => {
      const c = document.createElement('div');
      c.className = 'p3d-stat';
      c.innerHTML = `<b></b><span></span>`;
      c.querySelector('b').textContent = v;
      c.querySelector('span').textContent = k;
      bar.appendChild(c);
    });
  }

  // 用户没改过文本就用简称（不带单位，标题里干净）；改过了就说明用户
  // 有自己的说法，标题、提示文字都得跟着用户改的这个词，不然会显得
  // "设置了却没生效"
  const axisText = (dim) => (axisLabels[dim] !== DIMS[dim].label ? axisLabels[dim] : DIMS[dim].short);

  /** 标题、侧栏提示都要跟着 axisMap/axisLabels 描述当前是哪个维度在哪个方向，不能再是写死的文案 */
  function renderAxisDesc() {
    const sub = A.$('#p3d-subtitle');
    if (sub) sub.textContent = `${axisText(axisMap.z)}（纵轴）× ${axisText(axisMap.x)} × ${axisText(axisMap.y)} · 三维竞品定位`;
    renderSizeMode();
  }

  function renderSizeMode() {
    const box = A.$('#p3d-sizemode');
    if (!box) return;
    [...box.children].forEach((btn) => btn.classList.toggle('on', btn.dataset.mode === sizeMode));
    const hint = A.$('#p3d-sizehint');
    if (hint) hint.textContent = `纵轴（竖直方向）是${axisText(axisMap.z)}，水平面两个方向分别是${axisText(axisMap.x)}、${axisText(axisMap.y)}；${SIZE_MODES[sizeMode].hint}滚轮缩放，点气泡跳转商品页${autoRotate ? '，拖动可临时接管视角' : '，拖动旋转视角'}。`;
  }

  function setSizeMode(mode) {
    if (mode === sizeMode || !SIZE_MODES[mode]) return;
    sizeMode = mode;
    if (mode !== 'costEff' && data && data.products.length) {
      const shown = data.products.filter((p) => !hidden.has(p.brand));
      if (shown.length && shown.every((p) => !(p[mode] || SIZE_MODES[mode].calc(p)))) {
        A.toast(`当前数据没有${SIZE_MODES[mode].label}信息，气泡都会显示为最小——重新导入含该列的表格即可`, 'bad');
      }
    }
    renderSizeMode();
    render();
  }

  function renderAutoRotateBtn() {
    const btn = A.$('#p3d-autorotate');
    if (!btn) return;
    btn.classList.toggle('on', autoRotate);
    btn.textContent = autoRotate ? '⟲ 自动旋转：开' : '⟲ 自动旋转：关';
  }

  function setAutoRotate(v) {
    autoRotate = v;
    renderAutoRotateBtn();
    renderSizeMode();
    render();
  }

  /* ── 坐标轴设置：三个数据维度自由分配到 x/y/z，文字也能自定义 ── */
  let axisSheetBox = null;
  const AXIS_ROWS = [
    { axis: 'x', title: 'X 轴（水平面）' },
    { axis: 'y', title: 'Y 轴（水平面）' },
    { axis: 'z', title: 'Z 轴（竖直方向）' }
  ];

  function buildAxisSheet() {
    axisSheetBox = document.createElement('div');
    axisSheetBox.className = 'sheet-mask';
    axisSheetBox.hidden = true;
    axisSheetBox.innerHTML = `
      <div class="sheet" role="dialog" aria-label="坐标轴设置">
        <div class="sheet-head">
          <h2>坐标轴设置</h2>
          <button class="kill" id="p3d-axis-close" title="关闭">×</button>
        </div>
        <div class="sheet-body">
          <p class="rail-hint">三个方向分别显示哪个数据维度可以自由调换，显示的文字也能自己改——只在你本次浏览有效，刷新页面会回到默认。</p>
          <div id="p3d-axis-rows" class="p3d-axis-rows"></div>
          <button class="ghost" id="p3d-axis-reset">恢复默认</button>
        </div>
      </div>`;
    // 挂在 .p3d-canvas 下面，不是 document.body——浏览器全屏 API 只渲染
    // 被全屏化元素的子树，挂在 body 下的弹层在全屏时会被整个挡住，
    // 用户点了「坐标轴」却什么也看不见
    A.$('.p3d-canvas').appendChild(axisSheetBox);

    axisSheetBox.querySelector('#p3d-axis-close').onclick = closeAxisSheet;
    axisSheetBox.onclick = (e) => { if (e.target === axisSheetBox) closeAxisSheet(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !axisSheetBox.hidden) closeAxisSheet(); });
    axisSheetBox.querySelector('#p3d-axis-reset').onclick = () => {
      axisMap = { x: 'pmCadr', y: 'hchoCadr', z: 'price' };
      Object.keys(DIMS).forEach((k) => { axisLabels[k] = DIMS[k].label; });
      renderAxisSheetRows();
      render();
    };
  }

  function renderAxisSheetRows() {
    const wrap = axisSheetBox.querySelector('#p3d-axis-rows');
    wrap.innerHTML = '';
    AXIS_ROWS.forEach(({ axis, title }) => {
      const dim = axisMap[axis];
      const row = document.createElement('div');
      row.className = 'p3d-axis-row';
      row.innerHTML = `<b></b><select></select><input type="text" maxlength="14" placeholder="显示文字">`;
      row.querySelector('b').textContent = title;

      const sel = row.querySelector('select');
      Object.keys(DIMS).forEach((k) => {
        const opt = document.createElement('option');
        opt.value = k; opt.textContent = DIMS[k].label; opt.selected = k === dim;
        sel.appendChild(opt);
      });
      sel.onchange = () => setAxisDim(axis, sel.value);

      const inp = row.querySelector('input');
      inp.value = axisLabels[dim];
      inp.onchange = () => setAxisLabel(dim, inp.value);

      wrap.appendChild(row);
    });
  }

  /** 选了某个轴已经在用的维度，就跟原来占用它的轴互换位置——三个轴任何时候
   *  都对应三个不同维度，不用额外弹提示说"这个维度已经被占用了" */
  function setAxisDim(axis, dim) {
    if (axisMap[axis] === dim) return;
    const other = Object.keys(axisMap).find((a) => a !== axis && axisMap[a] === dim);
    if (other) axisMap[other] = axisMap[axis];
    axisMap[axis] = dim;
    renderAxisSheetRows();
    render();
  }

  function setAxisLabel(dim, text) {
    axisLabels[dim] = text.trim() || DIMS[dim].label;
    render();
  }

  function openAxisSheet() {
    if (!axisSheetBox) buildAxisSheet();
    renderAxisSheetRows();
    axisSheetBox.hidden = false;
  }
  function closeAxisSheet() { if (axisSheetBox) axisSheetBox.hidden = true; }

  /* ── 全屏：只对 .p3d-canvas 这个元素发起，rail 天然被排除在外，
     不用额外写 CSS 去隐藏侧栏——这是 Fullscreen API 本身的语义 ── */
  function renderFullscreenBtn() {
    const btn = A.$('#p3d-fullscreen');
    if (!btn) return;
    btn.classList.toggle('on', fullscreenOn);
    btn.textContent = fullscreenOn ? '⛶ 退出全屏' : '⛶ 全屏';
  }

  function toggleFullscreen() {
    if (fullscreenOn) { document.exitFullscreen?.(); return; }
    const el = A.$('.p3d-canvas');
    if (!el?.requestFullscreen) { A.toast('这个浏览器不支持全屏 API', 'bad'); return; }
    el.requestFullscreen().catch(() => A.toast('浏览器拒绝了全屏请求', 'bad'));
  }

  function onFullscreenChange() {
    fullscreenOn = document.fullscreenElement === A.$('.p3d-canvas');
    renderFullscreenBtn();
    render();
    requestAnimationFrame(() => chart && chart.resize());
  }

  /* ── 侧栏：导入与品牌筛选 ─────────────────────────────── */
  function renderRail() {
    const list = A.$('#p3d-brands');
    list.innerHTML = '';
    if (!data || !data.brands.length) { list.innerHTML = '<p class="rail-hint">还没有数据。</p>'; return; }

    data.brands.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'rv-brow p3d-brow' + (hidden.has(b.name) ? ' off' : '');
      row.innerHTML = `<i></i><div><b></b><span></span></div>`;
      row.querySelector('i').style.background = b.color;
      row.querySelector('b').textContent = b.name;
      row.querySelector('span').textContent = `${b.count} 款`;
      row.title = hidden.has(b.name) ? '点击显示这个品牌' : '点击隐藏这个品牌';
      row.onclick = () => {
        if (hidden.has(b.name)) hidden.delete(b.name); else hidden.add(b.name);
        render(); renderRail();
      };
      list.appendChild(row);
    });
  }

  async function doImport(file) {
    if (!/\.xlsx$/i.test(file.name)) return A.toast('只支持 .xlsx', 'bad');
    const btn = A.$('#p3d-import-btn');
    btn.disabled = true; btn.textContent = '解析中…';
    try {
      const r = await call('/api/products3d/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file
      });
      A.toast(`已导入 ${r.total} 款产品，覆盖 ${r.brands} 个品牌${r.skipped ? `，跳过 ${r.skipped} 行` : ''}`);
      hidden.clear();
      await refresh();
    } catch (e) {
      A.toast('导入失败：' + e.message, 'bad');
    } finally {
      btn.disabled = false; btn.textContent = '导入 / 更新 Excel';
    }
  }

  async function refresh() {
    try { data = await call('/api/products3d/summary'); }
    catch { data = null; }
    render();
    renderRail();
  }

  /** 切到这个 tab 时才第一次真正渲染——之前是 hidden，容器宽高是 0，echarts 会算错尺寸 */
  function onShow() {
    if (!data) return refresh();
    if (chart) requestAnimationFrame(() => chart.resize());
    else render();
  }

  function init(api) {
    A = api;
    const pick = A.$('#p3d-file');

    A.$('#p3d-import-btn').onclick = () => { pick.value = ''; pick.click(); };
    pick.onchange = () => { if (pick.files[0]) doImport(pick.files[0]); };

    const drop = A.$('#p3d-drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hot'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('hot')));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) doImport(f);
    });

    A.$('#p3d-show-all').onclick = () => { hidden.clear(); render(); renderRail(); };

    A.$('#p3d-sizemode').onclick = (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (btn) setSizeMode(btn.dataset.mode);
    };
    renderSizeMode();

    A.$('#p3d-autorotate').onclick = () => setAutoRotate(!autoRotate);
    renderAutoRotateBtn();

    A.$('#p3d-axis-btn').onclick = openAxisSheet;

    A.$('#p3d-fullscreen').onclick = toggleFullscreen;
    document.addEventListener('fullscreenchange', onFullscreenChange);
    renderFullscreenBtn();
  }

  return { init, refresh, render, onShow };
})();
