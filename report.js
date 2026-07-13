/* ═══════════════════════════════════════════════════════════
   report.js — 报告管理 · 个人报告（第一期：访客/浏览趋势 + 生意参谋指标）

   一份 Excel、一个上传入口，里面同时有两种口径的字段：
   · 访客/浏览趋势——"浏览量（店铺）/访客数（店铺）"，趋势图。目前只
     统计 IQAir天猫旗舰店，是店铺整体口径。右上角是时间范围，不是
     手动选粒度——默认「本年」按周聚合，「上周/本周」这种窄范围自动
     切回按日，自定义范围按跨度自适应（≤31天=日，≤370天=周，更长=
     月），范围决定粒度，少一层要自己想清楚该选哪个粒度的心智负担。
   · 生意参谋指标——"浏览量（首页）/访客数（首页）"+ 点击率、停留时长、
     引导支付…… 原周报 PPT 第一页那 7 组「上周 vs 本周」对比数据，
     是店铺「首页」口径，范围比店铺整体窄。
   两种口径共用同一份按日期增量合并的历史记录（report-store.js 的
   data.daily），每周重新导出、时间窗口有重叠也没关系，已有日期直接
   覆盖，不会重复。
   公共报告目前只是占位，入口先留着。
   ═══════════════════════════════════════════════════════════ */
const Report = (() => {
  let A, sub = 'personal', data = null, chart = null, ro = null;
  let rangeMode = 'thisYear', rangeStart = new Date().getFullYear() + '-01-01', rangeEnd = null, granularity = 'week';

  const METRIC_FIELDS = [
    ['pageviews', '浏览量', 'sum', 'count'],
    ['visitors', '访客数', 'sum', 'count'],
    ['clickRate', '点击率', 'avg', 'pct'],
    ['bounceRate', '跳失率', 'avg', 'pct'],
    ['avgStay', '平均停留时长', 'avg', 'sec'],
    ['detailViews', '引导详情次数', 'sum', 'count'],
    ['detailVisitors', '引导详情人数', 'sum', 'count'],
    ['cartItems', '引导加购件数', 'sum', 'count'],
    ['cartVisitors', '引导加购人数', 'sum', 'count'],
    ['clicks', '点击次数', 'sum', 'count'],
    ['clickVisitors', '点击人数', 'sum', 'count'],
    ['payAmount', '引导支付金额', 'sum', 'money']
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

  /* ── 访客/浏览趋势（店铺整体）：范围 + 自动聚合口径 ────── */
  const todayStr = () => new Date().toISOString().slice(0, 10);

  /** 周一为一周的起点，offset=0 是本周，-1 是上周 */
  function isoWeekRange(offset) {
    const now = new Date();
    const dow = (now.getDay() + 6) % 7;
    const mon = new Date(now);
    mon.setDate(now.getDate() - dow + offset * 7);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return [mon.toISOString().slice(0, 10), sun.toISOString().slice(0, 10)];
  }

  /** 跨度越大，天级别的点越挤——按天数自适应选日/周/月粒度 */
  function autoGranularity(start, end) {
    if (!start) return 'week';
    const days = (new Date(end || todayStr()) - new Date(start)) / 86400000;
    if (days <= 31) return 'day';
    if (days <= 370) return 'week';
    return 'month';
  }

  function applyRangePreset(mode) {
    rangeMode = mode;
    if (mode === 'thisWeek') { [rangeStart, rangeEnd] = isoWeekRange(0); granularity = 'day'; }
    else if (mode === 'lastWeek') { [rangeStart, rangeEnd] = isoWeekRange(-1); granularity = 'day'; }
    else if (mode === 'thisYear') { rangeStart = new Date().getFullYear() + '-01-01'; rangeEnd = null; granularity = 'week'; }
    updateRangeNote();
    renderTrend();
  }

  function applyCustomRange() {
    rangeMode = 'custom';
    rangeStart = A.$('#rpt-range-start').value || null;
    rangeEnd = A.$('#rpt-range-end').value || null;
    granularity = autoGranularity(rangeStart, rangeEnd);
    updateRangeNote();
    renderTrend();
  }

  const GRANULARITY_LABEL = { day: '日', week: '周', month: '月' };
  function updateRangeNote() {
    const note = A.$('#rpt-range-note');
    const range = rangeStart ? `${rangeStart} 至 ${rangeEnd || todayStr()}` : '全部数据';
    note.textContent = `当前按${GRANULARITY_LABEL[granularity]}聚合展示 ${range}`;
  }

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
    const rows = data.daily.filter((r) => (!rangeStart || r.date >= rangeStart) && (!rangeEnd || r.date <= rangeEnd));
    const byBucket = {};
    const bucketSet = new Set();
    rows.forEach((r) => {
      const k = bucketKey(r.date, granularity);
      bucketSet.add(k);
      const e = byBucket[k] || (byBucket[k] = { visitors: 0, pageviews: 0 });
      e.visitors += r.shopVisitors;
      e.pageviews += r.shopPageviews;
    });
    const buckets = [...bucketSet].sort();
    const pvColor = '#4ee0c1', vvColor = '#5b8cff';

    const series = [
      {
        name: '浏览量', type: 'line', smooth: 0.25, symbol: 'circle', symbolSize: 6,
        lineStyle: { width: 2.5, color: pvColor }, itemStyle: { color: pvColor },
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: pvColor + '33' }, { offset: 1, color: pvColor + '00' }] } },
        data: buckets.map((k) => byBucket[k].pageviews)
      },
      {
        name: '访客数', type: 'line', smooth: 0.25, symbol: 'circle', symbolSize: 5,
        lineStyle: { width: 2, color: vvColor, type: 'dashed' }, itemStyle: { color: vvColor },
        data: buckets.map((k) => byBucket[k].visitors)
      }
    ];

    return {
      backgroundColor: 'transparent',
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
    if (!data || !data.daily.length) {
      empty.textContent = '还没有数据。用左边的「导入 / 更新 Excel」传一份进来。';
      empty.hidden = false; box.hidden = true; return;
    }
    const inRange = data.daily.some((r) => (!rangeStart || r.date >= rangeStart) && (!rangeEnd || r.date <= rangeEnd));
    if (!inRange) {
      empty.textContent = '这段时间范围里没有数据，换个范围看看。';
      empty.hidden = false; box.hidden = true; return;
    }
    empty.hidden = true;
    box.hidden = false;
    ensureChart().setOption(buildTrendOption(), true);
  }

  /** 一张对比卡：label 指标名，cur/last 两个周期的值，curLabel/lastLabel 是两个周期各自的叫法 */
  function buildCompareCard(label, cur, last, unit, curLabel, lastLabel) {
    const max = Math.max(cur, last, 1);
    const delta = last > 0 ? ((cur - last) / last) * 100 : (cur > 0 ? Infinity : null);

    const card = document.createElement('div');
    card.className = 'rpt-cmp-card';
    const deltaCls = delta === null ? '' : delta === Infinity ? 'up' : delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : 'flat';
    const deltaTxt = delta === null ? '—' : delta === Infinity ? '新增' : (delta > 0 ? '+' : '') + delta.toFixed(1) + '%';

    card.innerHTML = `
      <div class="rpt-cmp-top">
        <span class="rpt-cmp-label"></span>
        <span class="rpt-cmp-delta ${deltaCls}"></span>
      </div>
      <div class="rpt-cmp-track">
        <div class="rpt-cmp-fill" style="width:${max ? (cur / max) * 100 : 0}%"></div>
        <div class="rpt-cmp-mark" style="left:${max ? (last / max) * 100 : 0}%"></div>
      </div>
      <div class="rpt-cmp-foot">
        <span><b></b> ${curLabel}</span>
        <span class="dim">${lastLabel} <b></b></span>
      </div>`;
    card.querySelector('.rpt-cmp-label').textContent = label;
    card.querySelector('.rpt-cmp-delta').textContent = deltaTxt;
    card.querySelectorAll('.rpt-cmp-foot b')[0].textContent = fmt(cur, unit);
    card.querySelectorAll('.rpt-cmp-foot b')[1].textContent = fmt(last, unit);
    card.title = `${label}\n${curLabel} ${fmt(cur, unit)} · ${lastLabel} ${fmt(last, unit)}`;
    return card;
  }

  /** 店铺整体：上周 vs 上上周——两个都是过完的整周，不会被"本周还没过完"拉低 */
  function renderShopWeekCompare() {
    const box = A.$('#rpt-shop-compare');
    box.innerHTML = '';
    const daily = data?.daily || [];
    if (!daily.length) return;

    const [lastStart, lastEnd] = isoWeekRange(-1);
    const [prevStart, prevEnd] = isoWeekRange(-2);
    const inWeek = (r, s, e) => r.date >= s && r.date <= e;
    const lastRows = daily.filter((r) => inWeek(r, lastStart, lastEnd));
    const prevRows = daily.filter((r) => inWeek(r, prevStart, prevEnd));

    if (!lastRows.length && !prevRows.length) {
      box.innerHTML = '<p class="kw-empty">上周和上上周都还没有数据。</p>';
      return;
    }

    const sum = (rows, field) => rows.reduce((s, r) => s + (r[field] || 0), 0);
    const grid = document.createElement('div');
    grid.className = 'rpt-cmp-grid';
    grid.appendChild(buildCompareCard('浏览量', sum(lastRows, 'shopPageviews'), sum(prevRows, 'shopPageviews'), 'count', '上周', '上上周'));
    grid.appendChild(buildCompareCard('访客数', sum(lastRows, 'shopVisitors'), sum(prevRows, 'shopVisitors'), 'count', '上周', '上上周'));
    box.appendChild(grid);
  }

  /* ── 生意参谋指标（首页）：上周 vs 本周 ───────────────── */
  function renderCompare() {
    const box = A.$('#rpt-compare');
    box.innerHTML = '';
    const daily = data?.daily || [];
    if (!daily.length) { box.innerHTML = '<p class="rv-empty">还没有数据。用左边的「导入 / 更新 Excel」传一份进来。</p>'; return; }

    const desc = [...daily].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const thisWeek = desc.slice(0, 7), lastWeek = desc.slice(7, 14);
    if (lastWeek.length < 7) {
      const p = document.createElement('p');
      p.className = 'rv-note';
      p.textContent = `目前只有 ${daily.length} 天的数据，不足两周（14 天）——下面的「上周」暂时只用 ${lastWeek.length} 天估算，数据攒够了会自动准确。`;
      box.appendChild(p);
    }

    const rollup = (rows, field, mode) => {
      if (!rows.length) return 0;
      const sum = rows.reduce((s, r) => s + (r[field] || 0), 0);
      return mode === 'sum' ? sum : sum / rows.length;
    };

    const grid = document.createElement('div');
    grid.className = 'rpt-cmp-grid';

    METRIC_FIELDS.forEach(([field, label, mode, unit]) => {
      const cur = rollup(thisWeek, field, mode), last = rollup(lastWeek, field, mode);
      grid.appendChild(buildCompareCard(label, cur, last, unit, '本周', '上周'));
    });

    box.appendChild(grid);
  }

  function render() { renderTrend(); renderShopWeekCompare(); renderCompare(); }

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
  async function doImport(file) {
    if (!/\.xlsx$/i.test(file.name)) return A.toast('只支持 .xlsx', 'bad');
    const btn = A.$('#rpt-import-btn');
    btn.disabled = true; btn.textContent = '解析中…';
    try {
      const r = await call('/api/reports/personal/import', {
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

  function wireDrop(dropId, fileInputId) {
    const drop = A.$(dropId), pick = A.$(fileInputId);
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hot'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('hot')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) doImport(f); });
    pick.onchange = () => { if (pick.files[0]) doImport(pick.files[0]); };
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

    A.$('#rpt-import-btn').onclick = () => { A.$('#rpt-import-file').value = ''; A.$('#rpt-import-file').click(); };
    wireDrop('#rpt-import-drop', '#rpt-import-file');

    A.$$('#rpt-range-tabs button').forEach((b) => (b.onclick = () => {
      A.$$('#rpt-range-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      const mode = b.dataset.range;
      A.$('#rpt-range-custom').hidden = mode !== 'custom';
      if (mode === 'custom') {
        if (!A.$('#rpt-range-start').value) A.$('#rpt-range-start').value = rangeStart || todayStr();
        if (!A.$('#rpt-range-end').value) A.$('#rpt-range-end').value = rangeEnd || todayStr();
        applyCustomRange();
      } else {
        applyRangePreset(mode);
      }
    }));
    A.$('#rpt-range-start').onchange = applyCustomRange;
    A.$('#rpt-range-end').onchange = applyCustomRange;

    updateRangeNote();
  }

  return { init, refresh, render, onShow };
})();
