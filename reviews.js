/* ═══════════════════════════════════════════════════════════
   reviews.js — 竞品评论风向标

   为什么这里统计的是「维度 × 极性」而不是「好评数 / 差评数」：
   源数据没有评分列，且淘宝晒单评论天然一边倒（实测 6,332 条里
   算法能识别的负向分句只有 2%，且约四成是误判）。
   做成好评差评柱状图，结果会是七个品牌清一色 97% 好评 —— 好看，但没用。

   改成维度：一条"静音很好，就是滤芯太贵"同时贡献
   噪音:正向 + 滤芯成本:负向。这才是竞品对比要看的东西。
   ═══════════════════════════════════════════════════════════ */
const Reviews = (() => {
  let A, data = null, activeBrand = '', subView = 'compare', activeProduct = '';

  const ASPECT_ORDER = ['净化效果', '异味处理', '噪音', '滤芯成本', '质量做工', '外观设计', '体积重量', '操作智能', '服务物流'];

  async function call(url, opts) {
    const r = A.guard(await fetch(url, opts));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '请求失败');
    return j;
  }

  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

  /**
   * 统计数字滚动动效：从 0 弹到目标值，参照 React Bits 的 CountUp（spring 手感）
   * 用 easeOutCubic 近似——纯 CSS transition 数不了整数文本，只能逐帧改 textContent。
   */
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function countUp(el, to, { suffix = '', duration = 900, delay = 0 } = {}) {
    to = Number(to) || 0;
    if (reduceMotion()) { el.textContent = to.toLocaleString() + suffix; return; }
    el.textContent = '0' + suffix;
    const start = performance.now() + delay;
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    function frame(now) {
      const elapsed = now - start;
      if (elapsed < 0) { requestAnimationFrame(frame); return; }
      const t = Math.min(1, elapsed / duration);
      el.textContent = Math.round(to * ease(t)).toLocaleString() + suffix;
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* ── 关键词溯源浮层 ─────────────────────────────────── */
  let tipTimer = null, tipBox = null;

  function hideTip() {
    clearTimeout(tipTimer);
    tipBox?.classList.remove('in');
    setTimeout(() => { if (tipBox && !tipBox.classList.contains('in')) { tipBox.remove(); tipBox = null; } }, 200);
  }

  /**
   * 原文溯源浮层。term 给了就是关键词云那种"这个词在哪些原文里"；
   * 不给 term、只给 aspect（或都不给）就是"这个维度/这个品牌的所有差评句"——
   * 统计卡片和维度总览的差评段悬浮用这种。
   * brandId 不传时跟着当前选中的品牌筛选（activeBrand）；热力图每个格子
   * 本来就对应固定的一行品牌，跟 activeBrand 无关，所以要显式传进来覆盖。
   */
  function showTip(anchor, { term = '', aspect = '', polarity, label, brandId, productId }) {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(async () => {
      hideTip();
      tipBox = document.createElement('div');
      tipBox.className = 'kw-tip ' + polarity;
      tipBox.innerHTML = `<div class="kw-tip-head"><b></b><span>加载原文…</span></div><div class="kw-tip-body"></div>`;
      tipBox.querySelector('b').textContent = label || term;
      document.body.appendChild(tipBox);

      // 鼠标移进浮层里也要留着，否则滚不动
      tipBox.addEventListener('mouseenter', () => clearTimeout(tipTimer));
      tipBox.addEventListener('mouseleave', hideTip);

      place(tipBox, anchor);
      requestAnimationFrame(() => tipBox.classList.add('in'));

      try {
        const q = new URLSearchParams({ term, aspect, polarity, brand: brandId !== undefined ? brandId : activeBrand });
        if (productId) q.set('product', productId);
        const rows = await call('/api/reviews/keyword?' + q);
        if (!tipBox) return;
        tipBox.querySelector('.kw-tip-head span').textContent = `${rows.length} 条原文 · 按「有用」排序`;
        const body = tipBox.querySelector('.kw-tip-body');
        body.innerHTML = '';
        const needle = term.replace(/^不/, '');
        rows.forEach((r) => {
          const el = document.createElement('div');
          el.className = 'kw-ctx';
          el.innerHTML = `<div class="kw-ctx-meta"><em></em><span></span><i></i></div><p></p>`;
          el.querySelector('em').textContent = r.brand;
          el.querySelector('span').textContent = r.date;
          el.querySelector('i').textContent = r.useful ? `有用 ${r.useful}` : '';
          // 高亮关键词，其余按纯文本插入，不用 innerHTML 拼原文；没有具体词就不高亮
          const p = el.querySelector('p');
          const idx = needle ? r.context.indexOf(needle) : -1;
          if (idx >= 0) {
            p.append(r.context.slice(0, idx));
            const mark = document.createElement('mark');
            mark.textContent = r.context.slice(idx, idx + needle.length);
            p.append(mark, r.context.slice(idx + needle.length));
          } else p.textContent = r.context;
          body.appendChild(el);
        });
        if (!rows.length) body.innerHTML = '<p class="kw-empty">没找到原文</p>';
        place(tipBox, anchor);
      } catch (e) {
        if (tipBox) tipBox.querySelector('.kw-tip-head span').textContent = e.message;
      }
    }, 160);
  }

  function place(box, anchor) {
    const a = anchor.getBoundingClientRect();
    const w = box.offsetWidth || 380, h = box.offsetHeight || 300;
    let left = a.left + a.width / 2 - w / 2;
    left = Math.min(Math.max(10, left), innerWidth - w - 10);
    let top = a.bottom + 10;
    if (top + h > innerHeight - 10) top = Math.max(10, a.top - h - 10);
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }

  /* ── 渲染 ───────────────────────────────────────────── */
  function render() {
    const root = A.$('#rv-board');
    if (subView === 'product') { renderProductView(root); return; }

    if (!data) { root.innerHTML = '<p class="rv-empty">还没有评论数据。用标题栏的「导入 Excel」传第一份进来。</p>'; return; }
    if (!data.totals.reviews) { root.innerHTML = '<p class="rv-empty">评论库是空的。在标题栏导入一份 xlsx 试试。</p>'; return; }

    root.innerHTML = '';
    root.append(statBar(), aspectOverview(), heatmap(), brandVolume(), clouds());
    // 条形图得先挂进文档才有「起点」可过渡——挂之前就把宽度定死，浏览器不会补一段动画，直接秒到终值
    growBars(root);
  }

  function statBar() {
    const brand = activeBrand && data.brands.find((b) => b.id === activeBrand);
    const box = document.createElement('div');
    box.className = 'rv-stats';

    const tiles = brand
      ? [
          [brand.total, '该品牌评论数'],
          [brand.total - brand.template, '有效评论'],
          [brand.negClauses, '差评分句', 'neg'],
          [brand.posClauses, '好评分句']
        ]
      : [
          [data.totals.reviews, '评论总数'],
          [data.totals.reviews - data.totals.template, '有效评论'],
          [pct(data.totals.template, data.totals.reviews), '模板/空评', null, '%'],
          [data.totals.brands, '品牌']
        ];
    tiles.forEach(([v, k, mark, suffix], i) => {
      const c = document.createElement('div');
      c.className = 'rv-stat' + (mark === 'neg' ? ' neg hoverable' : '');
      c.innerHTML = `<b></b><span></span>`;
      c.querySelector('span').textContent = k;
      countUp(c.querySelector('b'), v, { suffix: suffix || '', delay: i * 70 });
      if (mark === 'neg') {
        const tip = () => showTip(c, { polarity: 'neg', label: brand ? `${brand.name} · 差评句` : '差评句' });
        c.addEventListener('mouseenter', tip);
        c.addEventListener('mouseleave', hideTip);
        c.addEventListener('click', tip);
      }
      box.appendChild(c);
    });

    const note = document.createElement('p');
    note.className = 'rv-note';
    note.textContent = brand
      ? `正在只看【${brand.name}】——在下面「品牌 × 维度」或「品牌声量」里再点一次这个品牌可以退回全部品牌的总览。`
      : '「模板/空评」是淘宝默认好评和未填写内容，已从所有统计中排除。';
    const wrap = document.createElement('div');
    wrap.append(box, note);
    return wrap;
  }

  /**
   * 维度总览：横向条形图，每条内部按 好评/差评 分段——品牌对比、本品分析
   * 两个视图共用同一套渲染逻辑，区别只是数据源和点差评段之后怎么查原文。
   */
  function renderAspectBars(source, { title, subtitle, sortByNeg, emptyText, tipParams }) {
    const sec = document.createElement('section');
    sec.className = 'rv-sec';
    sec.innerHTML = `<h2>${title}</h2><p class="rv-sub">${subtitle}</p>`;

    const rows = ASPECT_ORDER
      .map((a) => ({ aspect: a, ...(source[a] || { pos: 0, neg: 0 }) }))
      .map((r) => ({ ...r, total: r.pos + r.neg }))
      .filter((r) => r.total > 0)
      .sort(sortByNeg ? (a, b) => b.neg - a.neg || b.total - a.total : (a, b) => b.total - a.total);

    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'kw-empty';
      p.textContent = emptyText;
      sec.appendChild(p);
      return sec;
    }

    const max = Math.max(...rows.map((r) => r.total), 1);
    const box = document.createElement('div');
    box.className = 'rv-bars';
    rows.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'rv-bar-row';
      row.style.animationDelay = (i * 35) + 'ms';
      const posPct = (r.pos / r.total) * 100, negPct = (r.neg / r.total) * 100;
      row.innerHTML = `
        <span class="rv-bar-label"></span>
        <div class="rv-bar-track">
          <div class="rv-bar-fill" data-w="${((r.total / max) * 100).toFixed(2)}">
            <div class="rv-bar-seg pos" style="width:${posPct}%"></div>
            <div class="rv-bar-seg neg" style="width:${negPct}%"></div>
          </div>
        </div>
        <span class="rv-bar-total"></span>`;
      row.querySelector('.rv-bar-label').textContent = r.aspect;
      row.querySelector('.rv-bar-total').textContent = r.total.toLocaleString();
      row.title = `${r.aspect}\n好评句 ${r.pos} · 差评句 ${r.neg}\n差评占比 ${Math.round(negPct)}%`;
      if (r.neg > 0) {
        const negSeg = row.querySelector('.rv-bar-seg.neg');
        negSeg.classList.add('hoverable');
        const tip = () => showTip(negSeg, { polarity: 'neg', aspect: r.aspect, ...tipParams(r.aspect) });
        negSeg.addEventListener('mouseenter', tip);
        negSeg.addEventListener('mouseleave', hideTip);
        negSeg.addEventListener('click', tip);
      }
      box.appendChild(row);
    });

    sec.appendChild(box);
    return sec;
  }

  /** 维度总览：品牌对比视图的封装——选中品牌后改按差评量排序，先看它哪里被吐槽最多 */
  function aspectOverview() {
    const brand = activeBrand && data.brands.find((b) => b.id === activeBrand);
    return renderAspectBars(brand ? brand.aspects : data.aspects, {
      title: brand ? `维度总览 · ${brand.name}` : '维度总览',
      subtitle: brand
        ? '按差评句数从多到少排——橙段是差评句、绿段是好评句。'
        : '条越长，这个维度被提到的次数越多；绿段是好评句、橙段是差评句。',
      sortByNeg: !!brand,
      emptyText: '这个品牌还没有能识别出维度的评论。',
      tipParams: (aspect) => ({ label: `${aspect} · 差评句` }) // 不传 brandId：走 showTip 默认的 activeBrand 逻辑
    });
  }

  /** 条形图从 0 长到目标宽度——先画 0，下一帧再给真实宽度，让已有的 CSS transition 接手 */
  function growBars(box) {
    const fills = [...box.querySelectorAll('.rv-bar-fill[data-w]')];
    fills.forEach((f) => (f.style.width = '0%'));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fills.forEach((f) => (f.style.width = f.dataset.w + '%'));
    }));
  }

  /** 品牌声量：按评论总数排序，条形颜色沿用品牌自己的识别色 */
  function brandVolume() {
    const sec = document.createElement('section');
    sec.className = 'rv-sec';
    sec.innerHTML = `<h2>品牌声量</h2><p class="rv-sub">条越长，这个品牌的评论样本越多——负向占比要结合样本量一起看。</p>`;

    const max = Math.max(...data.brands.map((b) => b.total), 1);
    const box = document.createElement('div');
    box.className = 'rv-bars';
    data.brands.forEach((b, i) => {
      const valid = b.total - b.template;
      const row = document.createElement('div');
      row.className = 'rv-bar-row rv-bar-clickable' + (activeBrand === b.id ? ' on' : '');
      row.style.animationDelay = (i * 35) + 'ms';
      row.innerHTML = `
        <span class="rv-bar-label"></span>
        <div class="rv-bar-track">
          <div class="rv-bar-fill" data-w="${((b.total / max) * 100).toFixed(2)}">
            <div class="rv-bar-seg brand" style="width:100%;background:${b.color}"></div>
          </div>
        </div>
        <span class="rv-bar-total"></span>`;
      row.querySelector('.rv-bar-label').textContent = b.name;
      row.querySelector('.rv-bar-total').textContent = b.total.toLocaleString();
      row.title = `${b.name}\n评论总数 ${b.total} · 有效 ${valid} · 模板/空评 ${pct(b.template, b.total)}%\n点击只看这个品牌`;
      row.onclick = () => { activeBrand = activeBrand === b.id ? '' : b.id; render(); syncHeadControls(); };
      if (A.me.admin) {
        row.appendChild(A.mkKill('删除这个品牌的全部评论', async () => {
          if (!confirm(`删除「${b.name}」的 ${b.total} 条评论？这个操作不可撤销。`)) return;
          try {
            await call('/api/reviews/brand/' + b.id, { method: 'DELETE' });
            A.toast('已删除');
            if (activeBrand === b.id) activeBrand = '';
            refresh();
          } catch (err) { A.toast(err.message, 'bad'); }
        }));
      }
      box.appendChild(row);
    });

    sec.appendChild(box);
    return sec;
  }

  /** 品牌 × 维度 热力图。格子颜色 = 负向占比，格子里是 负/总 */
  function heatmap() {
    const sec = document.createElement('section');
    sec.className = 'rv-sec';
    sec.innerHTML = `<h2>品牌 × 维度</h2><p class="rv-sub">颜色越红，这个维度被吐槽的差评句数越多（按绝对数量，不是占比）；格子里大字是差评句数，小字左边 <i class="n-pos">绿字</i> 是好评句数、右边 <i class="n-neg">红字</i> 是差评占比。鼠标停在有差评的格子上可以直接看差评原句。</p>`;

    const aspects = ASPECT_ORDER.filter((a) => data.aspects[a]);
    const grid = document.createElement('div');
    grid.className = 'rv-heat';
    grid.style.gridTemplateColumns = `140px repeat(${aspects.length}, minmax(72px, 1fr))`;

    grid.appendChild(cell('', 'rv-h-corner'));
    aspects.forEach((a) => grid.appendChild(cell(a, 'rv-h-head')));

    // 颜色深浅按「差评句数」在整张表里排名，不是差评占比——1条评论100%差评不该比
    // 200条里50条差评(25%)颜色还深。好评数、差评率只在格子文字里展示，供参考。
    let maxNeg = 0;
    data.brands.forEach((b) => aspects.forEach((a) => { maxNeg = Math.max(maxNeg, (b.aspects[a] || {}).neg || 0); }));

    data.brands.forEach((b, rowIdx) => {
      const name = cell(b.name, 'rv-h-brand');
      name.title = '点击只看这个品牌';
      name.onclick = () => { activeBrand = activeBrand === b.id ? '' : b.id; render(); syncHeadControls(); };
      if (activeBrand === b.id) name.classList.add('on');
      grid.appendChild(name);

      aspects.forEach((a) => {
        const v = b.aspects[a] || { pos: 0, neg: 0 };
        const total = v.pos + v.neg;
        const c = document.createElement('div');
        c.className = 'rv-h-cell';
        c.style.animationDelay = (rowIdx * 30) + 'ms';
        if (!total) { c.classList.add('void'); c.textContent = '—'; grid.appendChild(c); return; }
        const rate = v.neg / total;
        // 大部分格子的差评数其实都不高，线性映射颜色区分不出来；
        // 开个 0.55 次方把低段拉开，1.0（全场差评最多）和 0（没有差评）两端不受影响
        c.style.setProperty('--heat', (maxNeg ? Math.pow(v.neg / maxNeg, 0.55) : 0).toFixed(3));
        c.innerHTML = `<b>${v.neg}</b><span><i class="n-pos">${v.pos}</i>·<i class="n-neg">${Math.round(rate * 100)}%</i></span>`;
        if (v.neg > 0) {
          // 有差评句才值得悬浮看原文——鼠标停在格子上直接看这个品牌在这个维度上具体被怎么吐槽的
          c.classList.add('hoverable');
          const tip = () => showTip(c, { aspect: a, polarity: 'neg', brandId: b.id, label: `${b.name} · ${a} · 差评句` });
          c.addEventListener('mouseenter', tip);
          c.addEventListener('mouseleave', hideTip);
        } else {
          c.title = `${b.name} · ${a}\n差评 0 句 · 好评 ${v.pos} 句`;
        }
        grid.appendChild(c);
      });
    });

    sec.appendChild(grid);
    return sec;
  }

  const cell = (text, cls) => {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    return d;
  };

  /**
   * 关键词云：字号按出现次数，悬浮看原文。差评在前、更大，好评在后、次要——
   * 这是这个功能存在的目的。品牌对比、本品分析共用，区别只是数据源和溯源参数。
   */
  function renderClouds(source, { subtitle, negEmptyText, tipExtra }) {
    const sec = document.createElement('section');
    sec.className = 'rv-sec';
    sec.innerHTML = `<h2>关键词</h2><p class="rv-sub">${subtitle}</p>`;

    const wrap = document.createElement('div');
    wrap.className = 'rv-clouds';

    [['neg', '差评关键词'], ['pos', '好评关键词']].forEach(([pol, title]) => {
      const col = document.createElement('div');
      col.className = 'rv-cloud ' + pol;
      const h = document.createElement('h3');
      h.textContent = title;
      col.appendChild(h);

      // 后端已经按 top(40) 截过了，这里不再二次砍——之前砍到 24/36 是数字对不上的一个原因
      const list = source[pol] || [];

      if (!list.length) {
        const p = document.createElement('p');
        p.className = 'kw-empty';
        p.textContent = pol === 'neg' ? negEmptyText : '暂无。';
        col.appendChild(p);
      }

      const max = Math.max(...list.map((k) => k.count), 1);
      const box = document.createElement('div');
      box.className = 'kw-box';
      list.forEach((k, i) => {
        const t = document.createElement('button');
        t.className = 'kw';
        t.style.animationDelay = (i * 18) + 'ms';
        const scale = 0.82 + (Math.log(1 + k.count) / Math.log(1 + max)) * 0.9;
        t.style.fontSize = scale.toFixed(2) + 'rem';
        t.innerHTML = `<span></span><i>${k.count}</i>`;
        t.querySelector('span').textContent = k.term;
        const tip = () => showTip(t, { term: k.term, polarity: pol, ...tipExtra });
        t.addEventListener('mouseenter', tip);
        t.addEventListener('mouseleave', hideTip);
        t.addEventListener('click', tip);
        box.appendChild(t);
      });
      col.appendChild(box);
      wrap.appendChild(col);
    });

    sec.appendChild(wrap);
    return sec;
  }

  /** 关键词云：品牌对比视图的封装——品牌自己的高频词，不是从全站 top40 里筛出来的（不然小品牌的词基本挤不进全站排行） */
  function clouds() {
    const brand = activeBrand && data.brands.find((b) => b.id === activeBrand);
    const source = brand ? data.keywordsByBrand[activeBrand] : data.keywords;
    return renderClouds(source, {
      subtitle: `字号代表出现次数；鼠标停上去看它在原文里怎么说的。数的是「差评句/好评句里提到这个词多少次」，不是评论篇数——一条评论可能一个词都没提到，也可能同时提到好几个词，加起来对不上评论总数是正常的${brand ? `　·　当前只看【${brand.name}】，点品牌名可取消` : ''}。`,
      negEmptyText: '这个品牌没有识别出差评关键词。',
      tipExtra: {} // 不传 brandId/productId：走 showTip 默认的 activeBrand 逻辑
    });
  }

  /* ── 本品分析：针对 IQAir 自己某一款产品的深度清洗分析 ─── */
  function productStatBar(product) {
    const box = document.createElement('div');
    box.className = 'rv-stats';
    const tiles = [
      [product.total, '评论数'],
      [product.total - product.template, '有效评论'],
      [product.negClauses, '差评分句', 'neg'],
      [product.posClauses, '好评分句']
    ];
    tiles.forEach(([v, k, mark], i) => {
      const c = document.createElement('div');
      c.className = 'rv-stat' + (mark === 'neg' ? ' neg hoverable' : '');
      c.innerHTML = `<b></b><span></span>`;
      c.querySelector('span').textContent = k;
      countUp(c.querySelector('b'), v, { delay: i * 70 });
      if (mark === 'neg') {
        const tip = () => showTip(c, { polarity: 'neg', label: `${product.name} · 差评句`, brandId: '', productId: product.id });
        c.addEventListener('mouseenter', tip);
        c.addEventListener('mouseleave', hideTip);
        c.addEventListener('click', tip);
      }
      box.appendChild(c);
    });
    return box;
  }

  function renderProductView(root) {
    root.innerHTML = '';
    const product = (data?.products || []).find((p) => p.id === activeProduct);

    if (!product) {
      root.innerHTML = '<p class="rv-empty">在标题栏「选择产品」新建或选一个 IQAir 产品，开始针对这一款做深度评价分析。</p>';
      return;
    }
    if (!product.total) {
      root.innerHTML = `<p class="rv-empty">「${esc(product.name)}」还没有导入评论，在标题栏「导入 Excel」传一份 xlsx 进来。</p>`;
      return;
    }

    root.append(
      productStatBar(product),
      renderAspectBars(product.aspects, {
        title: `维度总览 · ${product.name}`,
        subtitle: '按差评句数从多到少排——橙段是差评句、绿段是好评句。',
        sortByNeg: true,
        emptyText: '这个产品还没有能识别出维度的评论。',
        tipParams: (aspect) => ({ label: `${product.name} · ${aspect} · 差评句`, brandId: '', productId: product.id })
      }),
      renderClouds(data.keywordsByProduct[product.id] || { pos: [], neg: [] }, {
        subtitle: `字号代表出现次数；鼠标停上去看它在原文里怎么说的——只看【${product.name}】这一款产品的评论。`,
        negEmptyText: '这个产品没有识别出差评关键词。',
        tipExtra: { brandId: '', productId: product.id }
      })
    );
    growBars(root);
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** 标题栏那个产品下拉：选项列表、导入按钮的可用状态、管理员的删除按钮，都跟着 activeProduct 走 */
  function syncProductPicker() {
    const sel = A.$('#rv-product-select');
    const products = data?.products || [];
    sel.innerHTML = '<option value="">选择产品…</option>';
    products.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name + (p.total ? ` · ${p.total} 条` : ' · 还没有评论');
      sel.appendChild(o);
    });
    sel.value = activeProduct || '';

    const cur = products.find((p) => p.id === activeProduct);
    const importBtn = A.$('#rv-product-import-btn');
    importBtn.disabled = !cur;
    importBtn.title = cur ? `给「${cur.name}」导入评论` : '先选一个产品';

    // .kill 这个类自带只读模式全局隐藏（见 styles.css body.readonly .kill），
    // 用它而不是自己拿 A.isEditing() 判断一次——不然编辑态切换时这颗按钮的
    // 显隐会跟不上（reviews 视图切编辑态不会整体重渲染）。
    const slot = A.$('#rv-product-del-slot');
    slot.innerHTML = '';
    if (cur && A.me.admin) {
      slot.appendChild(A.mkKill('删除这个产品的全部评论', async () => {
        if (!confirm(`删除「${cur.name}」以及它的 ${cur.total} 条评论？这个操作不可撤销。`)) return;
        try {
          await call('/api/reviews/product/' + cur.id, { method: 'DELETE' });
          A.toast('已删除');
          activeProduct = '';
          refresh();
        } catch (err) { A.toast(err.message, 'bad'); }
      }));
    }
  }

  async function createProduct() {
    const input = A.$('#rv-product-new-name');
    const name = input.value.trim();
    if (!name) return A.toast('先填产品名称，比如「GC-Multi」', 'bad');
    try {
      const r = await call('/api/reviews/products', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
      });
      A.toast(`已新建产品「${r.product.name}」`);
      input.value = '';
      activeProduct = r.product.id;
      await refresh();
    } catch (e) { A.toast('新建失败：' + e.message, 'bad'); }
  }

  async function doImportProduct(file) {
    if (!activeProduct) return A.toast('先选一个产品', 'bad');
    if (!/\.xlsx$/i.test(file.name)) return A.toast('只支持 .xlsx', 'bad');
    const btn = A.$('#rv-product-import-btn');
    btn.disabled = true; btn.textContent = '解析中…';
    try {
      const r = await call('/api/reviews/import?product=' + encodeURIComponent(activeProduct), {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file
      });
      A.toast(`${r.product}：新增 ${r.added} 条，跳过 ${r.skipped} 条已存在`);
      if (r.dupInFile) A.toast(`这份文件自己有 ${r.dupInFile} 行重复，已合并`, 'live');
      await refresh();
    } catch (e) {
      A.toast('导入失败：' + e.message, 'bad');
    } finally {
      btn.disabled = false; btn.textContent = '导入 Excel';
    }
  }

  /** 标题行里两套导入控件（竞品对比 / 本品分析）哪套可见，跟着 subView 走 */
  function syncHeadControls() {
    A.$('#rv-import-compare').hidden = subView !== 'compare';
    A.$('#rv-import-product').hidden = subView !== 'product';
    if (subView === 'product') syncProductPicker();
  }

  async function doImport(file, brandName) {
    if (!brandName.trim()) return A.toast('先填品牌名', 'bad');
    if (!/\.xlsx$/i.test(file.name)) return A.toast('只支持 .xlsx', 'bad');

    const btn = A.$('#rv-import-btn');
    btn.disabled = true; btn.textContent = '解析中…';
    try {
      const r = await call('/api/reviews/import?brand=' + encodeURIComponent(brandName.trim()), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file
      });
      A.toast(`${r.brand}：新增 ${r.added} 条，跳过 ${r.skipped} 条已存在`);
      if (r.dupInFile) A.toast(`这份文件自己有 ${r.dupInFile} 行重复，已合并`, 'live');
      await refresh();
    } catch (e) {
      A.toast('导入失败：' + e.message, 'bad');
    } finally {
      btn.disabled = false; btn.textContent = '导入 Excel';
    }
  }

  async function refresh() {
    try {
      data = await call('/api/reviews/summary');
    } catch { data = null; }
    render();
    syncHeadControls();
  }

  function init(api) {
    A = api;

    const pick = A.$('#rv-file');
    const nameInput = A.$('#rv-brand-name');

    A.$('#rv-import-btn').onclick = () => {
      if (!nameInput.value.trim()) return A.toast('先填品牌名，比如「352 Z90」', 'bad');
      pick.value = '';
      pick.click();
    };
    pick.onchange = () => { if (pick.files[0]) doImport(pick.files[0], nameInput.value); };

    A.$('#rv-product-select').onchange = (e) => { activeProduct = e.target.value; render(); syncHeadControls(); };
    A.$('#rv-product-new-btn').onclick = createProduct;
    A.$('#rv-product-new-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createProduct(); });

    const productPick = A.$('#rv-product-file');
    A.$('#rv-product-import-btn').onclick = () => { productPick.value = ''; productPick.click(); };
    productPick.onchange = () => { if (productPick.files[0]) doImportProduct(productPick.files[0]); };

    // 拖拽导入：不再有专门的拖拽框，整个看板区域都能接文件——
    // 落在哪套逻辑（品牌 / 产品）由当前 subView 决定。
    const scroll = A.$('.view-rv .rv-scroll');
    ['dragenter', 'dragover'].forEach((ev) => scroll.addEventListener(ev, (e) => { e.preventDefault(); scroll.classList.add('drop-hot'); }));
    ['dragleave', 'drop'].forEach((ev) => scroll.addEventListener(ev, () => scroll.classList.remove('drop-hot')));
    scroll.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (!f) return;
      if (subView === 'product') doImportProduct(f);
      else doImport(f, nameInput.value);
    });

    /* ── 本品分析 ───────────────────────────────────────── */
    A.$('#rv-subview-switch').onclick = (e) => {
      const btn = e.target.closest('button[data-sub]');
      if (!btn || btn.dataset.sub === subView) return;
      subView = btn.dataset.sub;
      [...A.$('#rv-subview-switch').children].forEach((b) => b.classList.toggle('on', b === btn));
      render(); syncHeadControls();
    };

    A.wireInfoPanel('#rv-info-wrap', '#rv-info-btn', '#rv-info-panel');
    window.addEventListener('scroll', hideTip, true);
    refresh();
  }

  return { init, refresh, render };
})();
