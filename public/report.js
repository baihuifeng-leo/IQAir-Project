/* ═══════════════════════════════════════════════════════════
   report.js — 报告管理 · 个人报告
   第一期：访客/浏览趋势 + 生意参谋指标；第二期：微盟数据

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
   · 微盟数据——公众号/小程序/APP 三端，微盟后台没有导出功能，运营
     按周手动填（浏览量/访客数/访问次数/平均访问深度/点击人数/点击
     次数/人均停留时长/跳出率 8 个指标 + 浏览量、访客数各自的三端拆
     分）。可以补填任意一周，按周一主键 upsert（report-store.js 的
     data.weimeng）；环比不是"跟上一条记录"，是按自然周查找"这一周
     的前一周"，所以乱序补数据也不会错位。同时挑波动最大的渠道自动
     拼一句话式点评，呼应原周报 PPT 第二页的叙述风格。

   访客/生意参谋和微盟数据分成两页（#rpt-page-1 / #rpt-page-2），跟
   原周报 PPT 的两页对应，避免挤在同一屏。右上角「放映模式」进全屏、
   隐藏顶栏和侧栏、把图表和数字放大，方便会议里直接投屏；左右方向键
   在两页间切换，Esc 或点右上角退出。

   公共报告目前只是占位，入口先留着。
   ═══════════════════════════════════════════════════════════ */
const Report = (() => {
  let A, sub = 'personal', data = null, chart = null, ro = null;
  let rangeMode = 'thisYear', rangeStart = new Date().getFullYear() + '-01-01', rangeEnd = null, granularity = 'week';
  let page = 1, presenting = false, wmSelectedWeek = null;

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
  // 12 项里最看重的 3 个口径——放映模式里单独加强调样式，避免 12 张卡
  // 长得一样，会场里得逐张读完才知道该看哪个
  const FEATURED_METRICS = new Set(['pageviews', 'visitors', 'payAmount']);

  /* ── 微盟数据（公众号/小程序/APP）：手动填表，按周环比 ── */
  const WM_METRICS = [
    ['pageviews', '浏览量', 'count'],
    ['visitors', '访客数', 'count'],
    ['visits', '访问次数', 'count'],
    ['avgDepth', '平均访问深度', 'depth'],
    ['clickUsers', '点击人数', 'count'],
    ['clicks', '点击次数', 'count'],
    ['avgStay', '人均停留时长', 'sec'],
    ['bounceRate', '跳出率', 'pct']
  ];
  const WM_CHANNELS = [['wechat', '公众号'], ['miniprogram', '小程序'], ['app', 'APP']];

  async function call(url, opts) {
    const r = A.guard(await fetch(url, opts));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '请求失败');
    return j;
  }

  const fmt = (v, unit) => {
    if (unit === 'pct') return v.toFixed(2) + '%';
    if (unit === 'sec') return v.toFixed(1) + ' 秒';
    if (unit === 'depth') return v.toFixed(2);
    if (unit === 'money') return '¥' + Math.round(v).toLocaleString();
    return Math.round(v).toLocaleString();
  };

  const deltaOf = (cur, prev) => (prev > 0 ? ((cur - prev) / prev) * 100 : (cur > 0 ? Infinity : null));
  const deltaCls = (d) => (d === null ? '' : d === Infinity ? 'up' : d > 0.5 ? 'up' : d < -0.5 ? 'down' : 'flat');
  const deltaTxt = (d) => (d === null ? '—' : d === Infinity ? '新增' : (d > 0 ? '+' : '') + d.toFixed(1) + '%');

  /* ── 访客/浏览趋势（店铺整体）：范围 + 自动聚合口径 ────── */
  /** 本地日期转 YYYY-MM-DD。不能用 toISOString()——那个转的是 UTC，
   *  在东八区这种 UTC+ 时区，本地 0 点换算过去是前一天下午，午夜前后
   *  跑这段代码就会把日期往前拨一天。微盟周选择器的"选了这周却显示
   *  上一周"就是栽在这个坑上，这里统一用本地年月日拼字符串。 */
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const todayStr = () => ymd(new Date());

  /** 把一个周一日期换算成"第几季度第几周"（QxWx，如 Q3W2＝第三季度第二周）——
   *  周报口头汇报习惯按季度数周，不按 ISO-8601 的"年度第几周"（那套按周四
   *  落在哪年分年，日常沟通没人这么读）。季度按自然月分（Q1=1-3月...），
   *  季度内第 1 周＝季度首月 1 号所在自然周（周一起点），此后按周累加。 */
  function quarterWeekLabel(weekMonday) {
    const d = new Date(String(weekMonday || '').trim() + 'T00:00:00');
    if (isNaN(d)) return '';
    const q = Math.floor(d.getMonth() / 3);
    const qStart = new Date(d.getFullYear(), q * 3, 1);
    const qStartDow = (qStart.getDay() + 6) % 7;
    const qStartMonday = new Date(qStart);
    qStartMonday.setDate(qStart.getDate() - qStartDow);
    const week = Math.round((d - qStartMonday) / (7 * 86400000)) + 1;
    return `Q${q + 1}W${week}`;
  }

  /** 周一为一周的起点，offset=0 是本周，-1 是上周 */
  function isoWeekRange(offset) {
    const now = new Date();
    const dow = (now.getDay() + 6) % 7;
    const mon = new Date(now);
    mon.setDate(now.getDate() - dow + offset * 7);
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return [ymd(mon), ymd(sun)];
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
    renderShopWeekCompare();
    renderCompare();
  }

  function applyCustomRange() {
    rangeMode = 'custom';
    rangeStart = A.$('#rpt-range-start').value || null;
    rangeEnd = A.$('#rpt-range-end').value || null;
    granularity = autoGranularity(rangeStart, rangeEnd);
    updateRangeNote();
    renderTrend();
    renderShopWeekCompare();
    renderCompare();
  }

  /** 某个周一日期对应的 [周一, 周日]——跟 isoWeekRange 同形状，方便复用 */
  function weekRangeOf(monday) {
    const d = new Date(monday + 'T00:00:00');
    const sun = new Date(d);
    sun.setDate(d.getDate() + 6);
    return [monday, ymd(sun)];
  }

  /** 「更多指标」「浏览量/访客数」这两组对比卡当前应该看哪两周——
   *  跟着标题栏的时间范围筛选联动：选"上周"就看上周 vs 上上周，选"本周"
   *  就看本周 vs 上周，自定义范围就看范围终点所在周 vs 再往前一周；
   *  只有停在默认的「本年」档位时才保留原来的安全默认——两个已经过完
   *  的整周，不会被本周还没走完拉低。 */
  function activeWeekPair() {
    if (rangeMode === 'lastWeek') return [isoWeekRange(-1), isoWeekRange(-2)];
    if (rangeMode === 'thisWeek') return [isoWeekRange(0), isoWeekRange(-1)];
    if (rangeMode === 'custom' && rangeStart) {
      const curMonday = weekMonday(rangeEnd || todayStr());
      return [weekRangeOf(curMonday), weekRangeOf(weekBefore(curMonday))];
    }
    return [isoWeekRange(-1), isoWeekRange(-2)];
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
    return ymd(d);
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
    // 图表颜色现读设计令牌——canvas 不吃 CSS 级联，主题切换靠 wb-themechange 重绘
    const css = getComputedStyle(document.documentElement);
    const tk = (name, fb) => (css.getPropertyValue(name) || fb).trim();
    const pvColor = tk('--mint', '#4ee0c1'), vvColor = tk('--blue', '#5b8cff');
    const axisText = tk('--dim', '#79879f'), lineCol = tk('--line', '#1f2b42'), splitCol = tk('--line-soft', '#17203292');

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
        top: 0, textStyle: { color: axisText, fontSize: 11.5 }, icon: 'roundRect', itemWidth: 10, itemHeight: 10,
        data: series.map((s) => s.name)
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: tk('--surface', '#101725') + 'f2', borderColor: lineCol, borderWidth: 1,
        textStyle: { color: tk('--text', '#e9eef8'), fontSize: 12.5 },
        extraCssText: 'border-radius:10px;box-shadow:0 20px 44px -18px #0006;'
      },
      xAxis: {
        type: 'category', data: buckets.map((k) => bucketLabel(k, granularity)), boundaryGap: false,
        axisLine: { lineStyle: { color: lineCol } }, axisLabel: { color: axisText, fontSize: 11 },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false }, axisLabel: { color: axisText, fontSize: 11 },
        splitLine: { lineStyle: { color: splitCol } }
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
      empty.textContent = '还没有数据。用标题栏的「导入 / 更新 Excel」传一份进来。';
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
    const delta = deltaOf(cur, last);

    const card = document.createElement('div');
    card.className = 'rpt-cmp-card';

    card.innerHTML = `
      <div class="rpt-cmp-top">
        <span class="rpt-cmp-label"></span>
        <span class="rpt-cmp-delta ${deltaCls(delta)}"></span>
      </div>
      <div class="rpt-cmp-track">
        <div class="rpt-cmp-fill" style="width:${max ? (cur / max) * 100 : 0}%"></div>
        <div class="rpt-cmp-mark" style="left:${max ? (last / max) * 100 : 0}%"></div>
      </div>
      <div class="rpt-cmp-foot">
        <span><b></b></span>
        <span class="dim"><b></b></span>
      </div>`;
    card.querySelector('.rpt-cmp-label').textContent = label;
    card.querySelector('.rpt-cmp-delta').textContent = deltaTxt(delta);
    card.querySelectorAll('.rpt-cmp-foot b')[0].textContent = fmt(cur, unit);
    card.querySelectorAll('.rpt-cmp-foot b')[1].textContent = fmt(last, unit);
    card.title = `${label}\n${curLabel} ${fmt(cur, unit)} · ${lastLabel} ${fmt(last, unit)}`;
    return card;
  }

  /** 店铺整体：跟标题栏时间范围筛选联动的两周对比，见 activeWeekPair() */
  function renderShopWeekCompare() {
    const box = A.$('#rpt-shop-compare');
    const note = A.$('#rpt-shop-compare-note');
    box.innerHTML = '';
    const daily = data?.daily || [];

    const [[lastStart, lastEnd], [prevStart, prevEnd]] = activeWeekPair();
    const lastLabel = quarterWeekLabel(lastStart), prevLabel = quarterWeekLabel(prevStart);
    if (note) note.textContent = `${lastLabel} vs ${prevLabel} · 两周环比`;
    if (!daily.length) return;

    const inWeek = (r, s, e) => r.date >= s && r.date <= e;
    const lastRows = daily.filter((r) => inWeek(r, lastStart, lastEnd));
    const prevRows = daily.filter((r) => inWeek(r, prevStart, prevEnd));

    if (!lastRows.length && !prevRows.length) {
      box.innerHTML = `<p class="kw-empty">${lastLabel} 和 ${prevLabel} 都还没有数据。</p>`;
      return;
    }

    const sum = (rows, field) => rows.reduce((s, r) => s + (r[field] || 0), 0);
    const grid = document.createElement('div');
    grid.className = 'rpt-cmp-grid';
    grid.appendChild(buildCompareCard('浏览量', sum(lastRows, 'shopPageviews'), sum(prevRows, 'shopPageviews'), 'count', lastLabel, prevLabel));
    grid.appendChild(buildCompareCard('访客数', sum(lastRows, 'shopVisitors'), sum(prevRows, 'shopVisitors'), 'count', lastLabel, prevLabel));
    box.appendChild(grid);
  }

  /** 12 项对比里挑最值得说的一条，拼成一句放映用的收尾点评——呼应第 2 页
   *  微盟数据本来就有的 buildWeimengCommentary，两页收尾对称 */
  function buildPage1Highlight(curLabel, deltas) {
    const withDelta = deltas.filter((r) => r.delta !== null && r.delta !== Infinity);
    if (!withDelta.length) return '';
    const upCount = withDelta.filter((r) => r.delta > 0.5).length;
    const downCount = withDelta.filter((r) => r.delta < -0.5).length;
    const trend = downCount > upCount ? '普遍下滑' : upCount > downCount ? '普遍走高' : '涨跌互现';
    let best = withDelta[0];
    withDelta.forEach((r) => { if (Math.abs(r.delta) > Math.abs(best.delta)) best = r; });
    const dirWord = best.delta > 0 ? '涨幅' : '跌幅';
    return `${curLabel} 各项指标${trend}，其中${best.label}${dirWord}最大，达 ${Math.abs(best.delta).toFixed(1)}%，是本期最值得关注的变化。`;
  }

  /* ── 生意参谋指标（首页）：跟标题栏时间范围筛选联动的两周对比 ── */
  function renderCompare() {
    const box = A.$('#rpt-compare');
    const rangeNote = A.$('#rpt-compare-range-note');
    const highlightEl = A.$('#rpt-page1-highlight');
    box.innerHTML = '';

    const [[curStart, curEnd], [lastStart, lastEnd]] = activeWeekPair();
    const curLabel = quarterWeekLabel(curStart), lastLabel = quarterWeekLabel(lastStart);
    if (rangeNote) rangeNote.textContent = `${curLabel} vs ${lastLabel}`;

    const daily = data?.daily || [];
    if (!daily.length) {
      box.innerHTML = '<p class="rv-empty">还没有数据。用标题栏的「导入 / 更新 Excel」传一份进来。</p>';
      if (highlightEl) { highlightEl.hidden = true; highlightEl.textContent = ''; }
      return;
    }

    const inWeek = (r, s, e) => r.date >= s && r.date <= e;
    const thisWeek = daily.filter((r) => inWeek(r, curStart, curEnd));
    const lastWeek = daily.filter((r) => inWeek(r, lastStart, lastEnd));
    if (thisWeek.length < 7 || lastWeek.length < 7) {
      const p = document.createElement('p');
      p.className = 'rv-note';
      p.textContent = `${curLabel}（${thisWeek.length} 天）或 ${lastLabel}（${lastWeek.length} 天）数据不满 7 天，下面暂时按已有天数估算，数据攒够了会自动准确。`;
      box.appendChild(p);
    }

    const rollup = (rows, field, mode) => {
      if (!rows.length) return 0;
      const sum = rows.reduce((s, r) => s + (r[field] || 0), 0);
      return mode === 'sum' ? sum : sum / rows.length;
    };

    const grid = document.createElement('div');
    grid.className = 'rpt-cmp-grid';

    const deltas = [];
    METRIC_FIELDS.forEach(([field, label, mode, unit]) => {
      const cur = rollup(thisWeek, field, mode), last = rollup(lastWeek, field, mode);
      const card = buildCompareCard(label, cur, last, unit, curLabel, lastLabel);
      if (FEATURED_METRICS.has(field)) card.classList.add('featured');
      grid.appendChild(card);
      deltas.push({ field, label, delta: deltaOf(cur, last) });
    });

    box.appendChild(grid);

    if (highlightEl) {
      const text = buildPage1Highlight(curLabel, deltas);
      highlightEl.textContent = text;
      highlightEl.hidden = !text;
    }
  }

  /* ── 微盟数据：可以补填任意一周，环比按自然周查找上一周 ── */
  function weekMonday(dateStr) {
    const d = new Date((dateStr || todayStr()) + 'T00:00:00');
    const dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
    return ymd(d);
  }
  const weekBefore = (weekStart) => {
    const d = new Date(weekStart + 'T00:00:00');
    d.setDate(d.getDate() - 7);
    return ymd(d);
  };
  const weimengByWeek = () => new Map((data?.weimeng || []).map((w) => [w.weekStart, w]));

  /** <input type="week"> 只能选"第几周"，不能选具体某一天——彻底避开
   *  "周一 vs 周日" 这种日期选择器容易选错的问题。这两个函数负责在
   *  ISO 周字符串（"2026-W26"）和周一日期（"2026-06-22"）之间转换。 */
  function isoWeekToMonday(value) {
    const m = /^(\d{4})-W(\d{2})$/.exec(value || '');
    if (!m) return null;
    const year = Number(m[1]), week = Number(m[2]);
    const jan4 = new Date(year, 0, 4);
    const jan4Dow = (jan4.getDay() + 6) % 7;
    const week1Mon = new Date(jan4);
    week1Mon.setDate(jan4.getDate() - jan4Dow + (week - 1) * 7);
    return ymd(week1Mon);
  }
  function mondayToIsoWeek(monday) {
    const d = new Date(monday + 'T00:00:00');
    const thu = new Date(d);
    thu.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const firstThu = new Date(thu.getFullYear(), 0, 4);
    firstThu.setDate(firstThu.getDate() + 3 - ((firstThu.getDay() + 6) % 7));
    const week = 1 + Math.round((thu - firstThu) / (7 * 86400000));
    return `${thu.getFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  function buildWeimengCommentary(cur, prev, curLabel) {
    const deltas = WM_METRICS.map(([field]) => deltaOf(cur[field], prev[field]));
    const upCount = deltas.filter((d) => d === Infinity || d > 0.5).length;
    const downCount = deltas.filter((d) => d !== null && d < -0.5).length;
    const trend = downCount > upCount ? '普遍下滑' : upCount > downCount ? '普遍上涨' : '涨跌互现';

    let worst = null;
    [['pageviews', '浏览量', 'pv'], ['visitors', '访客数', 'uv']].forEach(([, mlabel, ckey]) => {
      WM_CHANNELS.forEach(([key, clabel]) => {
        const c = (cur.channels && cur.channels[key] && cur.channels[key][ckey]) || 0;
        const p = (prev.channels && prev.channels[key] && prev.channels[key][ckey]) || 0;
        const d = deltaOf(c, p);
        if (d === null || d === Infinity) return;
        if (!worst || Math.abs(d) > Math.abs(worst.d)) worst = { label: clabel + mlabel, d };
      });
    });

    let extra = '';
    if (worst && Math.abs(worst.d) > 5) {
      extra = `，其中${worst.label}${worst.d > 0 ? '涨幅' : '跌幅'}达 ${Math.abs(worst.d).toFixed(1)}%，是主要${worst.d > 0 ? '拉高' : '拉低'}项`;
    }
    return `${curLabel} 全渠道流量及互动${trend}${extra}。`;
  }

  function renderWeimeng() {
    const sub = A.$('#rpt-wm-sub'), metricsBox = A.$('#rpt-wm-metrics'), chBox = A.$('#rpt-wm-channels'), note = A.$('#rpt-wm-commentary');
    const select = A.$('#rpt-wm-week-select');
    metricsBox.innerHTML = '';
    chBox.innerHTML = '';

    const weeks = data?.weimeng || [];
    if (!weeks.length) {
      select.innerHTML = '';
      sub.textContent = '还没有记录，点标题栏「记录 / 编辑某周数据」填一份。';
      note.hidden = true;
      return;
    }

    const desc = [...weeks].sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
    if (!wmSelectedWeek || !weeks.some((w) => w.weekStart === wmSelectedWeek)) wmSelectedWeek = desc[0].weekStart;
    select.innerHTML = desc.map((w) => `<option value="${w.weekStart}">${quarterWeekLabel(w.weekStart)} · ${w.weekStart} 起</option>`).join('');
    select.value = wmSelectedWeek;

    const cur = weeks.find((w) => w.weekStart === wmSelectedWeek);
    const prev = weimengByWeek().get(weekBefore(cur.weekStart)) || null;
    const curLabel = quarterWeekLabel(cur.weekStart);
    sub.textContent = prev
      ? `${curLabel} · 环比 ${quarterWeekLabel(prev.weekStart)}`
      : `${curLabel} · ${quarterWeekLabel(weekBefore(cur.weekStart))} 还没有记录，暂时没法环比`;

    WM_METRICS.forEach(([field, label, unit]) => {
      const d = prev ? deltaOf(cur[field], prev[field]) : null;
      const card = document.createElement('div');
      card.className = 'rpt-wm-stat';
      card.innerHTML = `<span class="rpt-wm-stat-label"></span><b></b><span class="rpt-wm-stat-delta"></span>`;
      card.querySelector('.rpt-wm-stat-label').textContent = label;
      card.querySelector('b').textContent = fmt(cur[field] || 0, unit);
      const dl = card.querySelector('.rpt-wm-stat-delta');
      dl.textContent = deltaTxt(d);
      dl.className = 'rpt-wm-stat-delta ' + deltaCls(d);
      metricsBox.appendChild(card);
    });

    [['pageviews', '浏览量渠道构成', 'pv'], ['visitors', '访客数渠道构成', 'uv']].forEach(([, title, ckey]) => {
      const group = document.createElement('div');
      group.className = 'rpt-wm-chgroup';
      const h3 = document.createElement('h3');
      h3.textContent = title;
      group.appendChild(h3);
      const total = WM_CHANNELS.reduce((s, [key]) => s + ((cur.channels && cur.channels[key] && cur.channels[key][ckey]) || 0), 0) || 1;
      WM_CHANNELS.forEach(([key, label]) => {
        const v = (cur.channels && cur.channels[key] && cur.channels[key][ckey]) || 0;
        const p = prev ? (prev.channels && prev.channels[key] && prev.channels[key][ckey]) || 0 : null;
        const d = prev ? deltaOf(v, p) : null;
        const row = document.createElement('div');
        row.className = 'rpt-wm-chrow';
        row.innerHTML = `
          <span class="rpt-wm-chname"></span>
          <span class="rpt-wm-chbar"><span class="rpt-wm-chfill"></span></span>
          <span class="rpt-wm-chval"><b></b><span class="rpt-wm-chdelta"></span></span>`;
        row.querySelector('.rpt-wm-chname').textContent = label;
        row.querySelector('.rpt-wm-chfill').style.width = `${(v / total) * 100}%`;
        row.querySelector('.rpt-wm-chval b').textContent = fmt(v, 'count');
        const dl = row.querySelector('.rpt-wm-chdelta');
        dl.textContent = deltaTxt(d);
        dl.className = 'rpt-wm-chdelta ' + deltaCls(d);
        group.appendChild(row);
      });
      chBox.appendChild(group);
    });

    if (!prev) { note.hidden = true; return; }
    note.hidden = false;
    note.textContent = buildWeimengCommentary(cur, prev, curLabel);
  }

  /** 把某一周的表单填好：已经有记录就是编辑（带出旧值），没有就是空白新建 */
  function loadWeekIntoForm(weekStart) {
    const monday = weekMonday(weekStart);
    const existing = weimengByWeek().get(monday);
    A.$('#wm-weekStart').value = mondayToIsoWeek(monday);
    const sunday = new Date(monday + 'T00:00:00'); sunday.setDate(sunday.getDate() + 6);
    A.$('#wm-weekStart-hint').textContent = `即 ${monday} 至 ${ymd(sunday)}（${quarterWeekLabel(monday)}）`;
    WM_METRICS.forEach(([field]) => { A.$('#wm-' + field).value = existing ? existing[field] : ''; });
    WM_CHANNELS.forEach(([key]) => {
      A.$(`#wm-ch-${key}-pv`).value = existing ? existing.channels[key].pv : '';
      A.$(`#wm-ch-${key}-uv`).value = existing ? existing.channels[key].uv : '';
    });
    A.$('#rpt-wm-title').textContent = (existing ? '编辑 ' : '记录 ') + quarterWeekLabel(monday) + ` · ${monday} 起`;
  }

  function openWeimengForm(weekStart) {
    loadWeekIntoForm(weekStart || wmSelectedWeek || todayStr());
    A.$('#rpt-wm-mask').hidden = false;
  }
  function closeWeimengForm() { A.$('#rpt-wm-mask').hidden = true; }

  async function saveWeimeng() {
    const weekStart = isoWeekToMonday(A.$('#wm-weekStart').value);
    if (!weekStart) return A.toast('先选一周', 'bad');
    const payload = { weekStart, channels: {} };
    WM_METRICS.forEach(([field]) => { payload[field] = A.$('#wm-' + field).value; });
    WM_CHANNELS.forEach(([key]) => {
      payload.channels[key] = { pv: A.$(`#wm-ch-${key}-pv`).value, uv: A.$(`#wm-ch-${key}-uv`).value };
    });
    const btn = A.$('#rpt-wm-save');
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await call('/api/reports/personal/weimeng/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      A.toast('已保存');
      wmSelectedWeek = r.entry.weekStart;
      closeWeimengForm();
      await refresh();
    } catch (e) {
      A.toast('保存失败：' + e.message, 'bad');
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  }

  /* ── 页面切换：报告分两页，分别对应原周报 PPT 的第 1、2 页 ── */
  function switchPage(n) {
    page = n;
    A.$$('#rpt-page-switch button').forEach((b) => b.classList.toggle('on', Number(b.dataset.page) === n));
    A.$('#rpt-page-1').hidden = n !== 1;
    A.$('#rpt-page-2').hidden = n !== 2;
    if (n === 1 && chart) requestAnimationFrame(() => chart.resize());
  }

  /* ── 放映模式：全屏、隐藏顶栏/侧栏，内容放大，方便会议投屏 ── */
  function togglePresent() { presenting ? exitPresent() : enterPresent(); }

  function enterPresent() {
    presenting = true;
    document.body.classList.add('rpt-presenting');
    A.$('#rpt-present-btn').textContent = '■ 退出放映';
    A.$('#rpt-exit-present').hidden = false;
    const fs = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
    if (fs) {
      fs.call(document.documentElement)?.catch(() => {
        A.toast('浏览器拒绝了全屏请求，只切到放映排版——按 F11 可以手动全屏', 'bad');
      });
    } else {
      A.toast('这个浏览器不支持全屏 API，只切到放映排版——按 F11 可以手动全屏', 'bad');
    }
    if (chart) requestAnimationFrame(() => chart.resize());
  }

  function exitPresent() {
    presenting = false;
    document.body.classList.remove('rpt-presenting');
    A.$('#rpt-present-btn').textContent = '▶ 放映模式';
    A.$('#rpt-exit-present').hidden = true;
    if (document.fullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document).catch?.(() => {});
    if (chart) requestAnimationFrame(() => chart.resize());
  }

  function render() { renderTrend(); renderShopWeekCompare(); renderCompare(); renderWeimeng(); }

  /* ── 子页签：个人 / 公共 ──────────────────────────────── */
  function switchSub(s) {
    sub = s;
    A.$$('#rpt-switch button').forEach((b) => b.classList.toggle('on', b.dataset.sub === s));
    A.$('#rpt-personal-tools').hidden = s !== 'personal';
    A.$('#rpt-personal-view').hidden = s !== 'personal';
    A.$('#rpt-public-view').hidden = s !== 'public';
    A.$('#rpt-head-sub').textContent = s === 'personal' ? '周报数据看板 · 个人报告' : '周报数据看板 · 公共报告';
    A.$('#rpt-present-btn').hidden = s !== 'personal';
    if (s !== 'personal' && presenting) exitPresent();
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

  /** 没有专门的拖拽框了，整个个人报告看板区域都能接文件 */
  function wireDrop(dropSel, fileInputId) {
    const drop = A.$(dropSel), pick = A.$(fileInputId);
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drop-hot'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('drop-hot')));
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
    wireDrop('#rpt-personal-view', '#rpt-import-file');
    A.wireInfoPanel('#rpt-info-wrap', '#rpt-info-btn', '#rpt-info-panel');

    // 标题栏这颗按钮固定填「当周」，不跟随下面选择器正在看的历史周——不然浏览完
    // 某个旧周再点这里，数据会填错周，当周那格反而一直空着。
    A.$('#rpt-weimeng-btn').onclick = () => openWeimengForm(todayStr());
    A.$('#rpt-wm-edit-btn').onclick = () => openWeimengForm(A.$('#rpt-wm-week-select').value);
    A.$('#rpt-wm-week-select').onchange = (e) => { wmSelectedWeek = e.target.value; renderWeimeng(); };
    A.$('#rpt-wm-close').onclick = closeWeimengForm;
    A.$('#rpt-wm-mask').addEventListener('click', (e) => { if (e.target.id === 'rpt-wm-mask') closeWeimengForm(); });
    A.$('#rpt-wm-save').onclick = saveWeimeng;
    A.$('#wm-weekStart').onchange = (e) => { const m = isoWeekToMonday(e.target.value); if (m) loadWeekIntoForm(m); };

    // 主题切换时趋势图重读令牌重绘（图表画在 canvas 里，CSS 变量管不到它）
    document.addEventListener('wb-themechange', () => { if (chart && data) renderTrend(); });

    A.$$('#rpt-page-switch button').forEach((b) => (b.onclick = () => switchPage(Number(b.dataset.page))));
    A.$('#rpt-present-btn').onclick = togglePresent;
    A.$('#rpt-exit-present').onclick = exitPresent;
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && presenting) exitPresent(); });
    document.addEventListener('keydown', (e) => {
      if (!presenting) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') switchPage(2);
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') switchPage(1);
    });

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
