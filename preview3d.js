/* ═══════════════════════════════════════════════════════════
   preview3d.js — 竞品 3D 预览（Three.js 渲染）
   三个轴分别显示颗粒物CADR、甲醛CADR、价格哪个维度，以及每个轴
   显示的文字，都可以在「⚙ 坐标轴」里自定义——默认是价格摆在竖直
   方向（视觉纵轴），水平面两个方向是颗粒物CADR、甲醛CADR，跟这个
   项目一直以来的习惯一致，但不再是写死的。
   axisMap 里的 x/y/z 是"数据维度槽位"的技术名字，不是三维空间的
   哪根轴——渲染时固定把 axisMap.z 画在世界坐标的竖直 Y 轴，
   axisMap.x/y 画在水平面（世界 X / 世界 -Z），这样「z 默认是竖的」
   这个使用习惯不用哪个下游代码都记住，只在 dataToWorld() 一处翻译。
   气泡大小可以在「性价比 / 5-6月销售额 / 5-6月销量」三种口径
   之间切换：三个轴的空间已经占满了，销售表现这两项新数据改用
   气泡大小来承载，而不是硬塞成第四根轴。

   渲染引擎：原来用 ECharts-GL，标签发光试过 Canvas2D 的
   shadowBlur 会糊成实心色块（见旧版注释），做不出干净的发光描边；
   这版换成原生 Three.js——数据点是真正带光照/高光的 3D 球体
   （MeshStandardMaterial + 灯光，随视角转动时高光会跟着动，不是
   ECharts 那种平涂圆点），标签用 CSS2DRenderer 叠成 HTML，
   text-shadow 天然就是干净的描边发光，没有 Canvas2D 那个坑；
   叠加 UnrealBloomPass 做真实 Bloom，比 CSS 模糊圆斑更有层次。
   Three.js 是懒加载的（首次进这个 tab 才 import），不影响其它
   tab 的加载速度。
   ═══════════════════════════════════════════════════════════ */
const Preview3D = (() => {
  let A, data = null, sizeMode = 'costEff', autoRotate = true, fullscreenOn = false;
  const hidden = new Set();   // 被隐藏（取消勾选）的品牌

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
    const mix = 0.65 - (yiq / 150) * 0.35;
    const nr = Math.round(r + (255 - r) * mix), ng = Math.round(g + (255 - g) * mix), nb = Math.round(b + (255 - b) * mix);
    return `rgb(${nr}, ${ng}, ${nb})`;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ═══ Three.js 引擎：懒加载,一次创建后长期复用 ═══════════════ */
  let THREE = null, engine = null, engineFailed = false;
  let renderToken = 0; // 并发保护：设置项快速连点时,只有最后一次 render() 生效

  const WORLD = { x: 62, y: 46, z: 46 }; // 场景box的世界坐标尺寸，跟原 grid3D boxWidth/Height/Depth 成比例

  async function ensureEngine() {
    if (engine || engineFailed) return engine;
    const box = A.$('#p3d-chart');
    try {
      const [THREEmod, ctrl, css2d, comp, rp, bloom, out] = await Promise.all([
        import('./three.module.min.js'),
        import('./three-orbitcontrols.js'),
        import('./three-css2drenderer.js'),
        import('./three-effectcomposer.js'),
        import('./three-renderpass.js'),
        import('./three-unrealbloompass.js'),
        import('./three-outputpass.js')
      ]);
      THREE = THREEmod;
      const { OrbitControls } = ctrl;
      const { CSS2DRenderer, CSS2DObject } = css2d;
      const { EffectComposer } = comp;
      const { RenderPass } = rp;
      const { UnrealBloomPass } = bloom;
      const { OutputPass } = out;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);
      box.appendChild(renderer.domElement);

      const labelRenderer = new CSS2DRenderer();
      labelRenderer.domElement.className = 'p3d-label-layer';
      box.appendChild(labelRenderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, 1, 1, 900);

      const controls = new OrbitControls(camera, labelRenderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.088;
      controls.rotateSpeed = 0.62;
      controls.zoomSpeed = 0.85;
      controls.minDistance = 42;
      controls.maxDistance = 320;
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = 1.15;
      controls.target.set(WORLD.x / 2, WORLD.y / 2, -WORLD.z / 2);
      camera.position.set(WORLD.x / 2 + 78, WORLD.y / 2 + 62, -WORLD.z / 2 + 108);

      scene.add(new THREE.AmbientLight(0xaebfe0, 0.62));
      const key = new THREE.DirectionalLight(0xffffff, 1.25);
      key.position.set(60, 90, 70);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x6b98ff, 0.4);
      fill.position.set(-70, 20, -40);
      scene.add(fill);

      const composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.62, 0.5, 0.32);
      composer.addPass(bloomPass);
      composer.addPass(new OutputPass());

      const raycaster = new THREE.Raycaster();
      const pointerNDC = new THREE.Vector2();

      const dataGroup = new THREE.Group();
      const axisGroup = new THREE.Group();
      scene.add(axisGroup, dataGroup);

      const tooltip = document.createElement('div');
      tooltip.className = 'p3d-tooltip';
      box.appendChild(tooltip);

      const loading = document.createElement('div');
      loading.className = 'p3d-loading';
      loading.textContent = '正在初始化 3D 引擎…';
      box.appendChild(loading);

      let hoverMesh = null;
      let raf = null;

      function frame() {
        raf = requestAnimationFrame(frame);
        controls.update();
        composer.render();
        labelRenderer.render(scene, camera);
      }

      function pickAt(clientX, clientY) {
        const r = renderer.domElement.getBoundingClientRect();
        pointerNDC.x = ((clientX - r.left) / r.width) * 2 - 1;
        pointerNDC.y = -((clientY - r.top) / r.height) * 2 + 1;
        raycaster.setFromCamera(pointerNDC, camera);
        const hit = raycaster.intersectObjects(dataGroup.children, false).filter((i) => i.object.userData?.point);
        return hit[0]?.object || null;
      }

      function showTooltip(mesh, clientX, clientY) {
        const d = mesh.userData.point;
        tooltip.innerHTML = `<div class="p3d-tip">
          <div class="p3d-tip-head" style="color:${d.itemColor}">${esc(d.brand)}</div>
          <div class="p3d-tip-model">${esc(d.model)}</div>
          <div class="p3d-tip-row"><span>颗粒物 CADR</span><b>${d.pmCadr.toLocaleString()}</b></div>
          <div class="p3d-tip-row"><span>甲醛 CADR</span><b>${d.hchoCadr.toLocaleString()}</b></div>
          <div class="p3d-tip-row"><span>价格</span><b>¥${d.price.toLocaleString()}</b></div>
          <div class="p3d-tip-row${sizeMode === 'costEff' ? ' cur' : ''}"><span>性价比指数${sizeMode === 'costEff' ? ' ●' : ''}</span><b>${d.costEff.toFixed(1)}</b></div>
          <div class="p3d-tip-row${sizeMode === 'sales' ? ' cur' : ''}"><span>5-6月销售额${sizeMode === 'sales' ? ' ●' : ''}</span><b>¥${Math.round(d.sales).toLocaleString()}</b></div>
          <div class="p3d-tip-row${sizeMode === 'qty' ? ' cur' : ''}"><span>5-6月销量${sizeMode === 'qty' ? ' ●' : ''}</span><b>${Math.round(d.qty).toLocaleString()}</b></div>
          ${d.url ? '<div class="p3d-tip-link">点击气泡跳转商品页 ↗</div>' : ''}
        </div>`;
        const wrapRect = box.getBoundingClientRect();
        tooltip.style.left = (clientX - wrapRect.left) + 'px';
        tooltip.style.top = (clientY - wrapRect.top) + 'px';
        tooltip.classList.add('show');
      }
      function hideTooltip() { tooltip.classList.remove('show'); }

      renderer.domElement.addEventListener('pointermove', (e) => {
        const mesh = pickAt(e.clientX, e.clientY);
        if (mesh !== hoverMesh) {
          if (hoverMesh) hoverMesh.scale.setScalar(hoverMesh.userData.baseScale);
          if (mesh) mesh.scale.setScalar(mesh.userData.baseScale * 1.18);
          hoverMesh = mesh;
          renderer.domElement.style.cursor = mesh ? 'pointer' : '';
        }
        if (mesh) showTooltip(mesh, e.clientX, e.clientY); else hideTooltip();
      });
      renderer.domElement.addEventListener('pointerleave', () => {
        if (hoverMesh) { hoverMesh.scale.setScalar(hoverMesh.userData.baseScale); hoverMesh = null; }
        hideTooltip();
      });
      renderer.domElement.addEventListener('click', (e) => {
        const mesh = pickAt(e.clientX, e.clientY);
        if (mesh?.userData.point.url) window.open(mesh.userData.point.url, '_blank', 'noopener');
      });

      frame();

      engine = {
        renderer, labelRenderer, scene, camera, controls, composer, bloomPass,
        dataGroup, axisGroup, box, tooltip, loading, CSS2DObject,
        stop() { if (raf) cancelAnimationFrame(raf); }
      };
      resizeEngine();
      requestAnimationFrame(() => requestAnimationFrame(() => { loading.style.opacity = '0'; setTimeout(() => loading.remove(), 320); }));
      return engine;
    } catch (err) {
      engineFailed = true;
      box.innerHTML = '<p class="rv-empty">这个浏览器不支持 WebGL，没法显示 3D 预览。换个新一点的浏览器试试。</p>';
      console.error('[preview3d] Three.js 引擎初始化失败', err);
      return null;
    }
  }

  function resizeEngine() {
    if (!engine) return;
    const box = engine.box;
    const w = box.clientWidth || 1, h = box.clientHeight || 1;
    engine.camera.aspect = w / h;
    engine.camera.updateProjectionMatrix();
    engine.renderer.setSize(w, h);
    engine.composer.setSize(w, h);
    engine.bloomPass.setSize?.(w, h);
    engine.labelRenderer.setSize(w, h);
  }

  /* ── 折叠/展开左侧工作台是 CSS transition（420ms）连续变宽度，容器
     尺寸每一帧都在变——等尺寸稳定了再 resize 一次就够了，跟原来
     ECharts 版本的防抖策略一致 ── */
  let ro = null;
  function ensureResizeObserver() {
    if (ro) return;
    const box = A.$('#p3d-chart');
    let t = null;
    ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(resizeEngine, 120); });
    ro.observe(box);
  }

  /* ── 把数据值映射进世界坐标：axisMap.x/y 是水平面，axisMap.z 固定
     画在世界坐标的竖直 Y 轴——跟历史上"z 默认是竖的"这个使用习惯
     保持一致，但这里才是唯一需要知道这个映射关系的地方 ── */
  function buildScales(shown) {
    const ext = {};
    ['pmCadr', 'hchoCadr', 'price'].forEach((dim) => {
      const vals = shown.map((p) => p[dim] || 0);
      ext[dim] = { min: 0, max: Math.max(...vals, 1) };
    });
    return ext;
  }
  function dataToWorld(p, ext) {
    const nx = p[axisMap.x] / ext[axisMap.x].max, ny = p[axisMap.y] / ext[axisMap.y].max, nz = p[axisMap.z] / ext[axisMap.z].max;
    return new THREE.Vector3(nx * WORLD.x, nz * WORLD.y, -ny * WORLD.z);
  }

  function dotTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 58, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill();
    return new THREE.CanvasTexture(c);
  }
  let sphereTex = null;

  const axisText = (dim) => (axisLabels[dim] !== DIMS[dim].label ? axisLabels[dim] : DIMS[dim].short);

  /** 画三根轴线 + 外框 + 轴名/刻度标签（CSS2D） */
  function buildAxisFrame(scale) {
    const { axisGroup, CSS2DObject } = engine;
    axisGroup.clear();

    const lineColor = 0x4a6690, gridColor = 0x263a5c;
    const O = new THREE.Vector3(0, 0, 0);
    const ends = { x: new THREE.Vector3(WORLD.x, 0, 0), y: new THREE.Vector3(0, WORLD.y, 0), z: new THREE.Vector3(0, 0, -WORLD.z) };

    // 三根主轴
    Object.values(ends).forEach((end) => {
      const geo = new THREE.BufferGeometry().setFromPoints([O, end]);
      axisGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.85 })));
    });

    // 外框（细淡线，给个空间边界感，呼应原来 grid3D 的 box）
    const boxGeo = new THREE.BoxGeometry(WORLD.x, WORLD.y, WORLD.z);
    boxGeo.translate(WORLD.x / 2, WORLD.y / 2, -WORLD.z / 2);
    const edges = new THREE.EdgesGeometry(boxGeo);
    axisGroup.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: gridColor, transparent: true, opacity: 0.4 })));

    // 地面网格，给个落地参照
    const grid = new THREE.GridHelper(Math.max(WORLD.x, WORLD.z), 10, gridColor, gridColor);
    grid.position.set(WORLD.x / 2, 0, -WORLD.z / 2);
    grid.material.transparent = true;
    grid.material.opacity = 0.3;
    axisGroup.add(grid);

    // 轴名标签（对应 axisMap 的三个技术槽位，各自画在自己该在的世界轴末端）
    const AXIS_ENDS = { [axisMap.x]: ends.x, [axisMap.y]: ends.y, [axisMap.z]: ends.z };
    Object.entries(AXIS_ENDS).forEach(([dim, end]) => {
      const el = document.createElement('div');
      el.className = 'p3d-axis-label';
      el.style.fontSize = (12.5 * scale) + 'px';
      el.textContent = axisText(dim);
      const obj = new engine.CSS2DObject(el);
      obj.position.copy(end).multiplyScalar(1.08);
      axisGroup.add(obj);
    });

    // 每根轴 3 个刻度（0 / 中 / 满），复用原来 axisLabel 的配色
    Object.entries({ x: ['x', ends.x], y: ['z', ends.y], z: ['y', ends.z] }).forEach(([, [dim, end]]) => {
      [0.5, 1].forEach((t) => {
        const val = t * (window.__p3dExt?.[dim]?.max || 0);
        const el = document.createElement('div');
        el.className = 'p3d-tick-label';
        el.style.fontSize = (10.5 * scale) + 'px';
        el.textContent = Math.round(val).toLocaleString();
        const obj = new engine.CSS2DObject(el);
        obj.position.copy(end).multiplyScalar(t);
        axisGroup.add(obj);
      });
    });
  }

  function buildOption() {
    const mode = SIZE_MODES[sizeMode];
    const all = data.products.filter((p) => p.price > 0).map(withCostEff);
    const shown = all.filter((p) => !hidden.has(p.brand));
    const ext = buildScales(shown.length ? shown : all);
    window.__p3dExt = ext; // buildAxisFrame 读取刻度用，避免再传一份参数
    const vals = shown.map((p) => mode.calc(p));
    const lo = Math.min(...vals, 0), hi = Math.max(...vals, 1);
    const scale = fullscreenOn ? 1.35 : 1;
    const radius = (v) => (1.15 + Math.sqrt(Math.max(0, (v - lo) / ((hi - lo) || 1))) * 2.35) * scale;

    if (!sphereTex) sphereTex = dotTexture();
    buildAxisFrame(scale);

    const { dataGroup, CSS2DObject } = engine;
    dataGroup.clear();

    shown.forEach((p) => {
      const pos = dataToWorld(p, ext);
      const r = radius(mode.calc(p));
      const color = new THREE.Color(p.color || '#4ee0c1');

      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(r, 24, 18),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.55, roughness: 0.35, metalness: 0.12 })
      );
      mesh.position.copy(pos);
      mesh.userData = {
        baseScale: 1,
        point: {
          brand: p.brand, model: p.model, price: p.price, pmCadr: p.pmCadr, hchoCadr: p.hchoCadr,
          costEff: p.costEff, sales: p.sales || 0, qty: p.qty || 0, url: p.url, itemColor: p.color
        }
      };
      dataGroup.add(mesh);

      const el = document.createElement('div');
      el.className = 'p3d-pt-label';
      el.style.color = labelColor(p.color);
      el.style.fontSize = (11.5 * scale) + 'px';
      el.textContent = `${p.brand}\n${p.model}`;
      const label = new CSS2DObject(el);
      label.position.set(pos.x, pos.y + r + 2.2, pos.z);
      dataGroup.add(label);
    });
  }

  /* ── 渲染入口：数据/设置变了就整体重建 dataGroup + axisGroup，
     数据规模小（几十到一百多个产品），重建成本可以忽略 ── */
  async function render() {
    const myToken = ++renderToken;
    renderAxisDesc();
    const empty = A.$('#p3d-empty'), box = A.$('#p3d-chart');
    if (!data || !data.products.length) {
      empty.hidden = false;
      box.hidden = true;
      return;
    }
    empty.hidden = true;
    box.hidden = false;

    const eng = await ensureEngine();
    if (myToken !== renderToken) return; // 这期间又有更新的 render() 调用了，这次作废
    if (!eng) return; // WebGL 不可用，已经在 ensureEngine 里显示了降级提示
    ensureResizeObserver();
    eng.controls.autoRotate = autoRotate;
    buildOption();
    resizeEngine();
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

  /** OrbitControls 的 autoRotate 是个直接属性，不用像 ECharts 那样整体重建 option */
  function setAutoRotate(v) {
    autoRotate = v;
    renderAutoRotateBtn();
    renderSizeMode();
    if (engine) engine.controls.autoRotate = v;
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
    requestAnimationFrame(() => resizeEngine());
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

  /** 切到这个 tab 时才第一次真正渲染——之前是 hidden，容器宽高是 0，会算错尺寸 */
  function onShow() {
    if (!data) return refresh();
    if (engine) requestAnimationFrame(resizeEngine);
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
