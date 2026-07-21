/* ═══════════════════════════════════════════════════════════
   preview3d.js — 竞品 3D 预览
   渲染层是 Three.js 场景引擎（preview3d-scene.js，深空辉光·缎面版，
   替代了原来的 ECharts-GL）；本文件只管数据/交互/侧栏 UI，把要画的
   点和坐标轴描述喂给引擎。
   三个轴分别显示颗粒物CADR、甲醛CADR、价格哪个维度，以及每个轴
   显示的文字，都可以在「⚙ 坐标轴」里自定义——默认价格在竖直方向
   （axisMap.z），水平面两个方向是颗粒物CADR、甲醛CADR。坐标轴量程
   和刻度按当前显示的数据现算，任何维度分到任何轴都成立。
   气泡大小可以在「性价比 / 5-6月销售额 / 5-6月销量」三种口径
   之间切换：三个轴的空间已经占满了，销售表现这两项新数据改用
   气泡大小来承载，而不是硬塞成第四根轴。
   ═══════════════════════════════════════════════════════════ */
const Preview3D = (() => {
  // prefers-reduced-motion 下自动旋转默认关（装饰性动效约束）；用户仍可手动打开
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let A, data = null, scene = null, ro = null, sizeMode = 'qty', autoRotate = !REDUCED, fullscreenOn = false;
  const hidden = new Set();   // 被隐藏（取消勾选）的品牌

  /* ── 坐标轴：三个数据维度可以自由分配到 x/y/z 三个轴，每个轴
     显示的文字也能自定义。默认价格＝z、颗粒物＝x、甲醛＝y；改动会
     自动存到账号（users.json 的 p3dAxis 字段，见 saveAxisPref），
     换设备登录也是自己上次调好的样子，跟 sizeMode/autoRotate 那种
     纯会话状态（不持久化）不一样。 ── */
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
   * 标题颜色跟气泡色走，但深色品牌色（比如深棕、深灰）直接拿来做文字
   * 在深空底上会糊、看不清——往白混，对比度已经够的颜色不用动，
   * 色相还是那个品牌色，不会变成大家都一个颜色。
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

  /* ── 场景数据构建 ───────────────────────────────────── */
  // 刻度：挑一个让轴上落 3~5 个刻度的"整数"步长（1/2/2.5/5 ×10^n），
  // 量程取到步长的整数倍——三个轴可以被分配任意维度，必须现算
  function niceAxis(maxV) {
    const raw = Math.max(maxV, 1) * 1.06;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    let step = pow * 10;
    for (const m of [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5]) {
      if (Math.ceil(raw / (m * pow)) <= 5) { step = m * pow; break; }
    }
    const max = Math.ceil(raw / step) * step;
    const ticks = [];
    for (let v = step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(6));
    return { max, ticks };
  }

  // 刻度文字：价格轴用 ¥Xk 缩写（16000 一长串数字会挤成一堆），CADR 轴直接给数
  const DIM_FMT = {
    price: (v) => (v >= 1000 ? `¥${+(v / 1000).toFixed(1)}k` : `¥${v}`),
    pmCadr: (v) => String(v),
    hchoCadr: (v) => String(v)
  };

  function tipHTML(d) {
    return `<div class="p3d-tip">
      <div class="p3d-tip-head" style="color:${d.color}">${esc(d.brand)}</div>
      <div class="p3d-tip-model">${esc(d.model)}</div>
      <div class="p3d-tip-row"><span>颗粒物 CADR</span><b>${d.pmCadr.toLocaleString()}</b></div>
      <div class="p3d-tip-row"><span>甲醛 CADR</span><b>${d.hchoCadr.toLocaleString()}</b></div>
      <div class="p3d-tip-row"><span>价格</span><b>¥${d.price.toLocaleString()}</b></div>
      <div class="p3d-tip-row${sizeMode === 'costEff' ? ' cur' : ''}"><span>性价比指数${sizeMode === 'costEff' ? ' ●' : ''}</span><b>${d.costEff.toFixed(1)}</b></div>
      <div class="p3d-tip-row${sizeMode === 'sales' ? ' cur' : ''}"><span>5-6月销售额${sizeMode === 'sales' ? ' ●' : ''}</span><b>¥${Math.round(d.sales || 0).toLocaleString()}</b></div>
      <div class="p3d-tip-row${sizeMode === 'qty' ? ' cur' : ''}"><span>5-6月销量${sizeMode === 'qty' ? ' ●' : ''}</span><b>${Math.round(d.qty || 0).toLocaleString()}</b></div>
      ${d.url ? '<div class="p3d-tip-link">点击气泡跳转商品页 ↗</div>' : ''}
    </div>`;
  }

  function buildSceneData() {
    const mode = SIZE_MODES[sizeMode];
    const all = data.products.filter((p) => p.price > 0).map(withCostEff);
    const shown = all.filter((p) => !hidden.has(p.brand));
    const vals = shown.map((p) => Math.sqrt(Math.max(0, mode.calc(p))));
    const lo = Math.min(...vals, 0), hi = Math.max(...vals, 1);
    // 全屏和默认状态气泡大小必须一致——之前全屏额外 ×1.5 过，被反馈跟
    // 默认态比例对不上，已去掉；基数/增量是首版 1.7/3.4 的 ×0.75
    // （首版实测视觉密度偏高，大球互相叠、显乱）
    const radius = (p) => 1.28 + ((Math.sqrt(Math.max(0, mode.calc(p))) - lo) / ((hi - lo) || 1)) * 2.55;

    const axes = {};
    for (const axis of ['x', 'y', 'z']) {
      const dim = axisMap[axis];
      const { max, ticks } = niceAxis(Math.max(...shown.map((p) => p[dim]), 1));
      axes[axis] = { name: axisLabels[dim] || DIMS[dim].label, max, ticks, fmt: DIM_FMT[dim] || String };
    }

    const points = shown.map((p) => ({
      ax: p[axisMap.x], ay: p[axisMap.y], az: p[axisMap.z],
      radius: radius(p),
      brand: p.brand, model: p.model, color: p.color,
      labelColor: labelColor(p.color),
      url: p.url,
      tipHTML: tipHTML(p)
    }));

    return { points, axes };
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ── 渲染 ───────────────────────────────────────────── */
  let sceneFailed = false;
  let firstBuild = true;

  function ensureScene() {
    if (scene || sceneFailed) return scene;
    const box = A.$('#p3d-chart');
    scene = window.P3DScene.create(box);
    if (!scene) {
      // WebGL 起不来（远程桌面/老浏览器）——给出解释而不是白屏
      sceneFailed = true;
      A.toast('这个浏览器无法创建 3D 画面（WebGL 不可用）', 'bad');
      return null;
    }
    scene.setAutoRotate(autoRotate);
    if (!ro) {
      // 窗口拖拽调整大小、进出全屏这些场景下容器尺寸会连续变化，
      // ResizeObserver 也就跟着连续触发——高频触发 WebGL resize（重建
      // framebuffer）会看着卡，等尺寸稳定了再调一次就够了。
      let resizeTimer = null;
      ro = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => scene && scene.resize(), 120);
      });
      ro.observe(box);
    }
    scene.resize();
    return scene;
  }

  function render() {
    renderAxisDesc();
    const empty = A.$('#p3d-empty'), box = A.$('#p3d-chart');
    if (!data || !data.products.length) {
      empty.hidden = false;
      box.hidden = true;
      return;
    }
    // 场景引擎是 ES module（deferred），比经典脚本晚就绪——首次渲染
    // 如果引擎还没挂上来，等它的 ready 事件再补一次渲染
    if (!window.P3DScene) {
      document.addEventListener('p3dscene-ready', () => render(), { once: true });
      return;
    }
    empty.hidden = true;
    box.hidden = false;
    const s = ensureScene();
    if (!s) { empty.hidden = false; box.hidden = true; return; }
    const { points, axes } = buildSceneData();
    // 首次建场景播完整下落；之后的重建（换轴/口径/品牌筛选/导入）只做短就位
    s.setData(points, axes, firstBuild ? 'drop' : 'pop');
    firstBuild = false;
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
    if (scene) scene.setAutoRotate(v);
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
          <p class="rail-hint">三个方向分别显示哪个数据维度可以自由调换，显示的文字也能自己改——改完自动保存到你的账号，换设备登录也是这个样子。</p>
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
      saveAxisPref();
    };
  }

  /** 坐标轴改动即生效即保存，不用额外的"保存"按钮——跟功能显示设置
   *  （settings.js）那类个人偏好开关体验一致；保存失败也不回退本地
   *  显示（用户还在对话框里改着），只是提示一下、下次可能得重改。 */
  async function saveAxisPref() {
    try {
      const r = A.guard(await fetch('/api/users/' + A.me.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ p3dAxis: { map: axisMap, labels: axisLabels } })
      }));
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '保存失败');
      A.me.p3dAxis = { map: { ...axisMap }, labels: { ...axisLabels } };
    } catch (e) {
      if (e.expired) return;
      A.toast('坐标轴设置没能保存到账号，换设备可能看不到：' + e.message, 'bad');
    }
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
    saveAxisPref();
  }

  function setAxisLabel(dim, text) {
    axisLabels[dim] = text.trim() || DIMS[dim].label;
    render();
    saveAxisPref();
  }

  function openAxisSheet() {
    if (!axisSheetBox) buildAxisSheet();
    renderAxisSheetRows();
    axisSheetBox.hidden = false;
  }
  function closeAxisSheet() { if (axisSheetBox) axisSheetBox.hidden = true; }

  /* ── 全屏：只对 .p3d-canvas 这个元素发起，标题行的工具条也在它里面，
     所以全屏时依然能用——这是 Fullscreen API 本身的语义 ── */
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
    // 用 JS 直接切 class，不完全依赖 :fullscreen 伪类的样式重算——实测浏览器
    // 进入/退出全屏这个时机，:fullscreen 触发的 var()/自定义属性重算偶发滞后
    // （气泡口径切换标签就踩过这个坑），class 切换的重算没有这层不确定性
    A.$('.p3d-canvas').classList.toggle('p3d-fs', fullscreenOn);
    render();
    requestAnimationFrame(() => scene && scene.resize());
  }

  /* ── 标题栏「品牌」下拉菜单：筛选显示/隐藏 ───────────── */
  function syncBrandMenu() {
    const list = A.$('#p3d-brands');
    const btn = A.$('#p3d-brand-btn');
    list.innerHTML = '';
    if (!data || !data.brands.length) {
      list.innerHTML = '<p class="rail-hint">还没有数据。</p>';
      btn.textContent = '品牌 ▾';
      return;
    }
    btn.textContent = hidden.size ? `品牌 (${data.brands.length - hidden.size}/${data.brands.length}) ▾` : '品牌 ▾';

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
        render(); syncBrandMenu();
      };
      list.appendChild(row);
    });
  }

  function wireBrandMenu() {
    const wrap = A.$('#p3d-brand-wrap'), btn = A.$('#p3d-brand-btn'), menu = A.$('#p3d-brand-menu');
    btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    document.addEventListener('click', (e) => { if (!menu.hidden && !wrap.contains(e.target)) menu.hidden = true; });
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
    syncBrandMenu();
  }

  /** 切到这个 tab 时才第一次真正渲染——之前是 hidden，容器宽高是 0，画布会算错尺寸 */
  function onShow() {
    if (!data) return refresh();
    // 场景已存在 = 不是首次进入——重播一遍完整下落（拍板：每次切进 tab 都播）
    if (scene) requestAnimationFrame(() => { scene.resize(); scene.playEntry('drop'); });
    else render();
  }

  function init(api) {
    A = api;

    const saved = A.me.p3dAxis;
    if (saved && saved.map && DIMS[saved.map.x] && DIMS[saved.map.y] && DIMS[saved.map.z]) {
      axisMap = { x: saved.map.x, y: saved.map.y, z: saved.map.z };
      if (saved.labels) Object.keys(DIMS).forEach((k) => { if (saved.labels[k]) axisLabels[k] = saved.labels[k]; });
    }

    const pick = A.$('#p3d-file');

    A.$('#p3d-import-btn').onclick = () => { pick.value = ''; pick.click(); };
    pick.onchange = () => { if (pick.files[0]) doImport(pick.files[0]); };

    // 拖拽导入：没有专门的拖拽框了，直接把文件拖进整块图表区域即可
    const dropZone = A.$('.p3d-chart-wrap');
    ['dragenter', 'dragover'].forEach((ev) => dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('drop-hot'); }));
    ['dragleave', 'drop'].forEach((ev) => dropZone.addEventListener(ev, () => dropZone.classList.remove('drop-hot')));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) doImport(f);
    });

    wireBrandMenu();
    A.$('#p3d-show-all').onclick = () => { hidden.clear(); render(); syncBrandMenu(); };

    A.wireInfoPanel('#p3d-info-wrap', '#p3d-info-btn', '#p3d-info-panel');

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

    // 切走这个 tab 时（.view 被加 hidden）暂停渲染循环，切回来再恢复——
    // 不然离开页面后 WebGL 还在后台整帧渲染白烧 GPU
    const view = document.getElementById('view-preview3d');
    if (view) new MutationObserver(() => {
      if (scene) scene.setActive(!view.hidden);
    }).observe(view, { attributes: true, attributeFilter: ['hidden'] });
  }

  return { init, refresh, render, onShow };
})();
