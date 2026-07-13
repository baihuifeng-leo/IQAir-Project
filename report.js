/* ═══════════════════════════════════════════════════════════
   report.js — 报告管理 · 个人报告（第一期：访客/浏览趋势 + 生意参谋指标）

   两张表分属两条完全独立的上传通道：
   · 访客/浏览趋势——简单的「日期+店铺+访客数+浏览量」，做成可按日/周/月
     切换的趋势图，支持多店铺。
   · 生意参谋指标——原周报 PPT 第一页那 7 组「上周 vs 本周」对比数据，
     字段更多（点击率、停留时长、引导支付……），单独一张表、单独一个入口。
   公共报告目前只是占位，入口先留着。
   ═══════════════════════════════════════════════════════════ */
const Report = (() => {
  let A, sub = 'personal', data = null, granularity = 'day', chart = null, ro = null;
  const hiddenStores = new Set();

  const PALETTE = ['#4ee0c1', '#5b8cff', '#f4a63b', '#e2679a', '#9b7ff0', '#3fbf6f', '#ef6b5e', '#3fc0d8', '#c9922f', '#e34848', '#7c6fe0', '#b3653f'];
  const storeColorMap = new Map();
  const storeColor = (s) => {
    if (!storeColorMap.has(s)) storeColorMap.set(s, PALETTE[storeColorMap.size % PALETTE.length]);
    return storeColorMap.get(s);
  };

  const METRIC_GROUPS = [
    { title: '浏览量 / 访客数', fields: [['pageviews', '浏览量', 'sum', 'count'], ['visitors', '访客数', 'sum', 'count']] },
    { title: '点击率 / 跳失率', fields: [['clickRate', '点击率', 'avg', 'pct'], ['bounceRate', '跳失率', 'avg', 'pct']] },
    { title: '平均停留时长', fields: [['avgStay', '平均停留时长', 'avg', 'sec']] },
    { title: '引导详情次数 / 人数', fields: [['detailViews', '引导详情次数', 'sum', 'count'], ['detailVisitors', '引导详情人数', 'sum', 'count']] },
    { title: '引导加购件数 / 人数', fields: [['cartItems', '引导加购件数', 'sum', 'count'], ['cartVisitors', '引导加购人数', 'sum', 'count']] },
    { title: '点击次数 / 人数', fields: [['clicks', '点击次数', 'sum', 'count'], ['clickVisitors', '点击人数', 'sum', 'count']] },
    { title: '引导支付金额', fields: [['payAmount', '引导支付金额', 'sum', 'money']] }
  ];

  async function call(url, opts) {
    const r = A.guard(await fetch(url, opts));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '请求失败');
    return j;
  }

  const fmt = (v, unit) => {
    if (unit === 'pct') return v.toFixed(2) + '%';
    if (unit === 'sec') return v.toFixed(1) + ' 秒';
    if (unit === 'money') return '¥' + Math.round(v).toLocaleString();
    return Math.round(v).toLocaleString();
  };

  /* ── 访客/浏览趋势 ────────────────────────────────────── */
  function bucketKey(date, g) {
    if (g === 'month') return date.slice(0, 7);
    if (g === 'day') return date;
    const d = new Date(date + 'T00:00:00');
    const dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
    return d.toISOString().slice(0, 10);
  }
  const bucketLabel = (k, g) => (g === 'month' ? k : g === 'week' ? k + ' 起' : k.slice(5));

  function buildTrendOption() {
    const rows = data.traffic;
    const stores = [...new Set(rows.map((r) => r.store))].filter((s) => !hiddenStores.has(s));
    const byStore = {};
    const bucketSet = new Set();
    rows.forEach((r) => {
      if (hiddenStores.has(r.store)) return;
      const k = bucketKey(r.date, granularity);
      bucketSet.add(k);
      const s = byStore[r.store] || (byStore[r.store] = {});
      const e = s[k] || (s[k] = { visitors: 0, pageviews: 0 });
      e.visitors += r.visitors;
      e.pageviews += r.pageviews;
    });
    const buckets = [...bucketSet].sort();

    const series = [];
    stores.forEach((store) => {
      const color = storeColor(store);
      series.push({
        name: `${store} · 浏览量`, type: 'line', smooth: 0.25, symbol: 'circle', symbolSize: 6,
        lineStyle: { width: 2.5, color }, itemStyle: { color },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: color + '33' }, { offset: 1, color: color + '00' }] } },
        data: buckets.map((k) => byStore[store]?.[k]?.pageviews ?? null)
      });
      series.push({
        name: `${store} · 访客数`, type: 'line', smooth: 0.25, symbol: 'circle', symbolSize: 5,
        lineStyle: { width: 2, color, type: 'dashed' }, itemStyle: { color },
        data: buckets.map((k) => byStore[store]?.[k]?.visitors ?? null)
      });
    });

    return {
      backgroundColor: 'transparent',
      color: stores.map(storeColor),
      grid: { left: 52, right: 20, top: 30, bottom: 34 },
      legend: {
        top: 0, textStyle: { color: '#79879f', fontSize: 11.5 }, icon: 'roundRect', itemWidth: 10, itemHeight: 10,
        data: series.map((s) => s.name)
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#101725f2', borderColor: '#1f2b42', borderWidth: 1,
        textStyle: { color: '#e9eef8', fontSize: 12.5 },
        extraCssText: 'border-radius:10px;box-shadow:0 20px 44px -18px #000;'
      },
      xAxis: {
        type: 'category', data: buckets.map((k) => bucketLabel(k, granularity)), boundaryGap: false,
        axisLine: { lineStyle: { color: '#33456a' } }, axisLabel: { color: '#79879f', fontSize: 11 },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false }, axisLabel: { color: '#79879f', fontSize: 11 },
        splitLine: { lineStyle: { color: '#17203292' } }
      },
      series
    };
  }

  function ensureChart() {
    if (chart) return chart;
    const box = A.$('#rpt-trend-chart');
    chart = echarts.init(box, null, { renderer: 'canvas' });
    if (!ro) { ro = new ResizeObserver(() => chart && chart.resize()); ro.observe(box); }
    return chart;
  }

  function renderTrend() {
    const empty = A.$('#rpt-trend-empty'), box = A.$('#rpt-trend-chart');
    if (!data || !data.traffic.length) { empty.hidden = false; box.hidden = true; return; }
    empty.hidden = true;
    box.hidden = false;
    ensureChart().setOption(buildTrendOption(), true);
  }

  function renderStores() {
    const list = A.$('#rpt-stores');
    list.innerHTML = '';
    const stores = [...new Set((data?.traffic || []).map((r) => r.store))];
    if (!stores.length) { list.innerHTML = '<p class="rail-hint">还没有数据。</p>'; return; }
    stores.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'rv-brow p3d-brow' + (hiddenStores.has(s) ? ' off' : '');
      row.innerHTML = `<i></i><div><b></b></div>`;
      row.querySelector('i').style.background = storeColor(s);
      row.querySelector('b').textContent = s;
      row.title = hiddenStores.has(s) ? '点击显示这个店铺' : '点击隐藏这个店铺';
      row.onclick = () => { if (hiddenStores.has(s)) hiddenStores.delete(s); else hiddenStores.add(s); renderTrend(); renderStores(); };
      list.appendChild(row);
    });
  }

  /* ── 生意参谋指标：上周 vs 本周 ───────────────────────── */
  function renderCompare() {
    const box = A.$('#rpt-compare');
    box.innerHTML = '';
    const metrics = data?.metrics || [];
    if (!metrics.length) { box.innerHTML = '<p class="rv-empty">还没有数据。用左边的「导入 / 更新 Excel」传一份生意参谋指标表进来。</p>'; return; }

    const desc = [...metrics].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const thisWeek = desc.slice(0, 7), lastWeek = desc.slice(7, 14);
    if (lastWeek.length < 7) {
      const p = document.createElement('p');
      p.className = 'rv-note';
      p.textContent = `目前只有 ${metrics.length} 天的数据，不足两周（14 天）——下面的「上周」暂时只用 ${lastWeek.length} 天估算，数据攒够了会自动准确。`;
      box.appendChild(p);
    }

    const rollup = (rows, field, mode) => {
      if (!rows.length) return 0;
      const sum = rows.reduce((s, r) => s + (r[field] || 0), 0);
      return mode === 'sum' ? sum : sum / rows.length;
    };

    METRIC_GROUPS.forEach((g) => {
      const group = document.createElement('div');
      group.className = 'rpt-cmp-group';
      const h = document.createElement('h3');
      h.textContent = g.title;
      group.appendChild(h);

      g.fields.forEach(([field, label, mode, unit]) => {
        const cur = rollup(thisWeek, field, mode), last = rollup(lastWeek, field, mode);
        const max = Math.max(cur, last, 1);
        let delta = null;
        if (lastWeek.length) delta = last > 0 ? ((cur - last) / last) * 100 : (cur > 0 ? Infinity : 0);

        const row = document.createElement('div');
        row.className = 'rpt-cmp-row';
        const deltaCls = delta === null ? '' : delta === Infinity ? 'up' : delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : 'flat';
        const deltaTxt = delta === null ? '—' : delta === Infinity ? '新增' : (delta > 0 ? '+' : '') + delta.toFixed(1) + '%';

        row.innerHTML = `
          <div class="rpt-cmp-top">
            <span class="rpt-cmp-label"></span>
            <span class="rpt-cmp-delta ${deltaCls}"></span>
          </div>
          <div class="rpt-cmp-bar-line">
            <span class="rpt-cmp-tag">上周</span>
            <div class="rpt-cmp-track"><div class="rpt-cmp-fill last" style="width:${max ? (last / max) * 100 : 0}%"></div></div>
            <span class="rpt-cmp-num"></span>
          </div>
          <div class="rpt-cmp-bar-line">
            <span class="rpt-cmp-tag">本周</span>
            <div class="rpt-cmp-track"><div class="rpt-cmp-fill cur" style="width:${max ? (cur / max) * 100 : 0}%"></div></div>
            <span class="rpt-cmp-num"></span>
          </div>`;
        row.querySelector('.rpt-cmp-label').textContent = label;
        row.querySelector('.rpt-cmp-delta').textContent = deltaTxt;
        row.querySelectorAll('.rpt-cmp-num')[0].textContent = fmt(last, unit);
        row.querySelectorAll('.rpt-cmp-num')[1].textContent = fmt(cur, unit);
        group.appendChild(row);
      });

      box.appendChild(group);
    });
  }

  function render() { renderTrend(); renderStores(); renderCompare(); }

  /* ── 子页签：个人 / 公共 ──────────────────────────────── */
  function switchSub(s) {
    sub = s;
    A.$$('#rpt-switch button').forEach((b) => b.classList.toggle('on', b.dataset.sub === s));
    A.$('#rpt-personal-rail').hidden = s !== 'personal';
    A.$('#rpt-public-rail').hidden = s !== 'public';
    A.$('#rpt-personal-view').hidden = s !== 'personal';
    A.$('#rpt-public-view').hidden = s !== 'public';
    A.$('#rpt-head-sub').textContent = s === 'personal' ? '周报数据看板 · 个人报告' : '周报数据看板 · 公共报告';
    if (s === 'personal' && chart) requestAnimationFrame(() => chart.resize());
  }

  /* ── 导入 ─────────────────────────────────────────────── */
  async function doImport(kind, file) {
    if (!/\.xlsx$/i.test(file.name)) return A.toast('只支持 .xlsx', 'bad');
    const btnId = kind === 'traffic' ? '#rpt-traffic-btn' : '#rpt-metrics-btn';
    const btn = A.$(btnId);
    btn.disabled = true; btn.textContent = '解析中…';
    try {
      const r = await call(`/api/reports/personal/${kind}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file
      });
      A.toast(`新增 ${r.added} 天，更新 ${r.updated} 天${r.skipped ? `，跳过 ${r.skipped} 行` : ''}`);
      await refresh();
    } catch (e) {
      A.toast('导入失败：' + e.message, 'bad');
    } finally {
      btn.disabled = false; btn.textContent = '导入 / 更新 Excel';
    }
  }

  function wireDrop(dropId, fileInputId, kind) {
    const drop = A.$(dropId), pick = A.$(fileInputId);
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hot'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('hot')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) doImport(kind, f); });
    pick.onchange = () => { if (pick.files[0]) doImport(kind, pick.files[0]); };
  }

  async function refresh() {
    try { data = await call('/api/reports/personal/summary'); }
    catch { data = null; }
    render();
  }

  function onShow() {
    if (!data) return refresh();
    render();
    if (chart) requestAnimationFrame(() => chart.resize());
  }

  function init(api) {
    A = api;

    A.$$('#rpt-switch button').forEach((b) => (b.onclick = () => switchSub(b.dataset.sub)));

    A.$('#rpt-traffic-btn').onclick = () => { A.$('#rpt-traffic-file').value = ''; A.$('#rpt-traffic-file').click(); };
    A.$('#rpt-metrics-btn').onclick = () => { A.$('#rpt-metrics-file').value = ''; A.$('#rpt-metrics-file').click(); };
    wireDrop('#rpt-traffic-drop', '#rpt-traffic-file', 'traffic');
    wireDrop('#rpt-metrics-drop', '#rpt-metrics-file', 'metrics');

    A.$$('#rpt-granularity button').forEach((b) => (b.onclick = () => {
      granularity = b.dataset.g;
      A.$$('#rpt-granularity button').forEach((x) => x.classList.toggle('on', x === b));
      renderTrend();
    }));
  }

  return { init, refresh, render, onShow };
})();
