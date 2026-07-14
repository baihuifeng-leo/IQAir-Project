/* ═══════════════════════════════════════════════════════════
   preview3d.js — 竞品 3D 预览
   价格摆在竖直方向（视觉纵轴），水平面两个方向分别是颗粒物CADR、
   甲醛CADR。注意 ECharts-GL 的 3D 坐标系里，视觉上"竖起来"的
   那根轴技术上其实是 zAxis3D，xAxis3D/yAxis3D 才是水平面的两个
   方向——这里特意把「价格」配置给 zAxis3D，不要被技术轴名误导。
   气泡大小可以在「性价比 / 5-6月销售额 / 5-6月销量」三种口径
   之间切换：三个轴的空间已经占满了，销售表现这两项新数据改用
   气泡大小来承载，而不是硬塞成第四根轴。
   ═══════════════════════════════════════════════════════════ */
const Preview3D = (() => {
  let A, data = null, chart = null, ro = null, sizeMode = 'costEff', autoRotate = true;
  const hidden = new Set();   // 被隐藏（取消勾选）的品牌

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

  /* ── 图表配置 ───────────────────────────────────────── */
  const AXIS = {
    axisLine: { lineStyle: { color: '#33456a' } },
    splitLine: { lineStyle: { color: '#17203292' } },
    axisLabel: { color: '#79879f', fontSize: 11 },
    nameTextStyle: { color: '#e9eef8', fontSize: 12.5, fontWeight: 600, padding: [0, 0, 0, 0] },
    axisPointer: { lineStyle: { color: '#4ee0c1' } }
  };

  function buildOption() {
    const mode = SIZE_MODES[sizeMode];
    const all = data.products.filter((p) => p.price > 0).map(withCostEff);
    const shown = all.filter((p) => !hidden.has(p.brand));
    const vals = shown.map((p) => mode.calc(p));
    const lo = Math.min(...vals, 0), hi = Math.max(...vals, 1);
    const size = (v) => 15 + Math.sqrt(Math.max(0, (v - lo) / ((hi - lo) || 1))) * 34;

    const points = shown.map((p) => ({
      name: `${p.brand} ${p.model}`,
      value: [p.pmCadr, p.hchoCadr, p.price],
      brand: p.brand, model: p.model, price: p.price, pmCadr: p.pmCadr, hchoCadr: p.hchoCadr,
      costEff: p.costEff, sales: p.sales || 0, qty: p.qty || 0, url: p.url,
      itemStyle: { color: p.color, opacity: 0.9 },
      symbolSize: size(mode.calc(p)),
      label: {
        show: true, formatter: `${p.brand}\n${p.model}`, position: 'top', distance: 6, lineHeight: 14,
        color: '#e9eef8', fontSize: 11, fontWeight: 600,
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
      xAxis3D: { type: 'value', name: '颗粒物 CADR', min: 0, ...AXIS },
      yAxis3D: { type: 'value', name: '甲醛 CADR', min: 0, ...AXIS },
      zAxis3D: { type: 'value', name: '价格 (¥)', min: 0, ...AXIS },
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
      ro = new ResizeObserver(() => chart && chart.resize());
      ro.observe(box);
    }
    return chart;
  }

  function render() {
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

  function renderSizeMode() {
    const box = A.$('#p3d-sizemode');
    if (!box) return;
    [...box.children].forEach((btn) => btn.classList.toggle('on', btn.dataset.mode === sizeMode));
    const hint = A.$('#p3d-sizehint');
    if (hint) hint.textContent = `纵轴（竖直方向）是价格，水平面两个方向分别是颗粒物CADR、甲醛CADR；${SIZE_MODES[sizeMode].hint}滚轮缩放，点气泡跳转商品页${autoRotate ? '，拖动可临时接管视角' : '，拖动旋转视角'}。`;
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
  }

  return { init, refresh, render, onShow };
})();
