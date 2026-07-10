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
  let A, data = null, activeBrand = '';

  const ASPECT_ORDER = ['净化效果', '异味处理', '噪音', '滤芯成本', '质量做工', '外观设计', '体积重量', '操作智能', '服务物流'];

  async function call(url, opts) {
    const r = A.guard(await fetch(url, opts));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '请求失败');
    return j;
  }

  const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

  /* ── 关键词溯源浮层 ─────────────────────────────────── */
  let tipTimer = null, tipBox = null;

  function hideTip() {
    clearTimeout(tipTimer);
    tipBox?.classList.remove('in');
    setTimeout(() => { if (tipBox && !tipBox.classList.contains('in')) { tipBox.remove(); tipBox = null; } }, 200);
  }

  function showTip(anchor, term, polarity) {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(async () => {
      hideTip();
      tipBox = document.createElement('div');
      tipBox.className = 'kw-tip ' + polarity;
      tipBox.innerHTML = `<div class="kw-tip-head"><b></b><span>加载原文…</span></div><div class="kw-tip-body"></div>`;
      tipBox.querySelector('b').textContent = term;
      document.body.appendChild(tipBox);

      // 鼠标移进浮层里也要留着，否则滚不动
      tipBox.addEventListener('mouseenter', () => clearTimeout(tipTimer));
      tipBox.addEventListener('mouseleave', hideTip);

      place(tipBox, anchor);
      requestAnimationFrame(() => tipBox.classList.add('in'));

      try {
        const q = new URLSearchParams({ term, polarity, brand: activeBrand });
        const rows = await call('/api/reviews/keyword?' + q);
        if (!tipBox) return;
        tipBox.querySelector('.kw-tip-head span').textContent = `${rows.length} 条原文 · 按「有用」排序`;
        const body = tipBox.querySelector('.kw-tip-body');
        body.innerHTML = '';
        rows.forEach((r) => {
          const el = document.createElement('div');
          el.className = 'kw-ctx';
          el.innerHTML = `<div class="kw-ctx-meta"><em></em><span></span><i></i></div><p></p>`;
          el.querySelector('em').textContent = r.brand;
          el.querySelector('span').textContent = r.date;
          el.querySelector('i').textContent = r.useful ? `有用 ${r.useful}` : '';
          // 高亮关键词，其余按纯文本插入，不用 innerHTML 拼原文
          const p = el.querySelector('p');
          const idx = r.context.indexOf(term.replace(/^不/, ''));
          if (idx >= 0) {
            p.append(r.context.slice(0, idx));
            const mark = document.createElement('mark');
            mark.textContent = r.context.slice(idx, idx + term.replace(/^不/, '').length);
            p.append(mark, r.context.slice(idx + term.replace(/^不/, '').length));
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
    if (!data) { root.innerHTML = '<p class="rv-empty">还没有评论数据。用左边的「导入 Excel」传第一份进来。</p>'; return; }
    if (!data.totals.reviews) { root.innerHTML = '<p class="rv-empty">评论库是空的。左边导入一份 xlsx 试试。</p>'; return; }

    root.innerHTML = '';
    root.append(statBar(), aspectOverview(), heatmap(), brandVolume(), clouds());
  }

  function statBar() {
    const t = data.totals;
    const valid = t.reviews - t.template;
    const box = document.createElement('div');
    box.className = 'rv-stats';
    [
      [t.reviews.toLocaleString(), '评论总数'],
      [valid.toLocaleString(), '有效评论'],
      [pct(t.template, t.reviews) + '%', '模板/空评'],
      [t.brands, '品牌']
    ].forEach(([v, k]) => {
      const c = document.createElement('div');
      c.className = 'rv-stat';
      c.innerHTML = `<b></b><span></span>`;
      c.querySelector('b').textContent = v;
      c.querySelector('span').textContent = k;
      box.appendChild(c);
    });

    const note = document.createElement('p');
    note.className = 'rv-note';
    note.textContent = '「模板/空评」是淘宝默认好评和未填写内容，已从所有统计中排除。';
    const wrap = document.createElement('div');
    wrap.append(box, note);
    return wrap;
  }

  /** 维度总览：按提及量排序的横向条形图，每条内部按 好评/差评 分段 */
  function aspectOverview() {
    const sec = document.createElement('section');
    sec.className = 'rv-sec';
    sec.innerHTML = `<h2>维度总览</h2><p class="rv-sub">条越长，这个维度被提到的次数越多；绿段是好评句、橙段是差评句。</p>`;

    const rows = ASPECT_ORDER
      .map((a) => ({ aspect: a, ...(data.aspects[a] || { pos: 0, neg: 0 }) }))
      .map((r) => ({ ...r, total: r.pos + r.neg }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);

    const max = Math.max(...rows.map((r) => r.total), 1);
    const box = document.createElement('div');
    box.className = 'rv-bars';
    rows.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'rv-bar-row';
      const posPct = (r.pos / r.total) * 100, negPct = (r.neg / r.total) * 100;
      row.innerHTML = `
        <span class="rv-bar-label"></span>
        <div class="rv-bar-track">
          <div class="rv-bar-fill" style="width:${((r.total / max) * 100).toFixed(2)}%">
            <div class="rv-bar-seg pos" style="width:${posPct}%"></div>
            <div class="rv-bar-seg neg" style="width:${negPct}%"></div>
          </div>
        </div>
        <span class="rv-bar-total"></span>`;
      row.querySelector('.rv-bar-label').textContent = r.aspect;
      row.querySelector('.rv-bar-total').textContent = r.total.toLocaleString();
      row.title = `${r.aspect}\n好评句 ${r.pos} · 差评句 ${r.neg}\n差评占比 ${Math.round(negPct)}%`;
      box.appendChild(row);
    });

    sec.appendChild(box);
    return sec;
  }

  /** 品牌声量：按评论总数排序，条形颜色沿用品牌自己的识别色 */
  function brandVolume() {
    const sec = document.createElement('section');
    sec.className = 'rv-sec';
    sec.innerHTML = `<h2>品牌声量</h2><p class="rv-sub">条越长，这个品牌的评论样本越多——负向占比要结合样本量一起看。</p>`;

    const max = Math.max(...data.brands.map((b) => b.total), 1);
    const box = document.createElement('div');
    box.className = 'rv-bars';
    data.brands.forEach((b) => {
      const valid = b.total - b.template;
      const row = document.createElement('div');
      row.className = 'rv-bar-row';
      row.innerHTML = `
        <span class="rv-bar-label"></span>
        <div class="rv-bar-track">
          <div class="rv-bar-fill" style="width:${((b.total / max) * 100).toFixed(2)}%">
            <div class="rv-bar-seg brand" style="width:100%;background:${b.color}"></div>
          </div>
        </div>
        <span class="rv-bar-total"></span>`;
      row.querySelector('.rv-bar-label').textContent = b.name;
      row.querySelector('.rv-bar-total').textContent = b.total.toLocaleString();
      row.title = `${b.name}\n评论总数 ${b.total} · 有效 ${valid} · 模板/空评 ${pct(b.template, b.total)}%`;
      box.appendChild(row);
    });

    sec.appendChild(box);
    return sec;
  }

  /** 品牌 × 维度 热力图。格子颜色 = 负向占比，格子里是 负/总 */
  function heatmap() {
    const sec = document.createElement('section');
    sec.className = 'rv-sec';
    sec.innerHTML = `<h2>品牌 × 维度</h2><p class="rv-sub">颜色越红，这个维度被吐槽得越多。样本量太小的格子会变淡 —— 3 条提及里 1 条负面，说明不了什么。</p>`;

    const aspects = ASPECT_ORDER.filter((a) => data.aspects[a]);
    const grid = document.createElement('div');
    grid.className = 'rv-heat';
    grid.style.gridTemplateColumns = `140px repeat(${aspects.length}, minmax(72px, 1fr))`;

    grid.appendChild(cell('', 'rv-h-corner'));
    aspects.forEach((a) => grid.appendChild(cell(a, 'rv-h-head')));

    data.brands.forEach((b) => {
      const name = cell(b.name, 'rv-h-brand');
      name.onclick = () => { activeBrand = activeBrand === b.id ? '' : b.id; render(); };
      if (activeBrand === b.id) name.classList.add('on');
      grid.appendChild(name);

      aspects.forEach((a) => {
        const v = b.aspects[a] || { pos: 0, neg: 0 };
        const total = v.pos + v.neg;
        const c = document.createElement('div');
        c.className = 'rv-h-cell';
        if (!total) { c.classList.add('void'); c.textContent = '—'; grid.appendChild(c); return; }
        const rate = v.neg / total;
        // 样本量小 → 整体透明度降低，避免 1/2 看起来比 5/81 更吓人
        const conf = Math.min(1, total / 20);
        c.style.setProperty('--heat', rate.toFixed(3));
        c.style.setProperty('--conf', (0.25 + conf * 0.75).toFixed(2));
        c.innerHTML = `<b>${Math.round(rate * 100)}%</b><span>${v.neg}/${total}</span>`;
        c.title = `${b.name} · ${a}\n正向 ${v.pos} 句，负向 ${v.neg} 句${total < 10 ? '\n样本量偏小，仅供参考' : ''}`;
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

  /** 关键词云：字号按出现次数，悬浮看原文 */
  function clouds() {
    const sec = document.createElement('section');
    sec.className = 'rv-sec';
    const bname = activeBrand ? data.brands.find((b) => b.id === activeBrand)?.name : null;
    sec.innerHTML = `<h2>关键词</h2><p class="rv-sub">字号代表出现次数。鼠标停上去看它在原文里怎么说的${bname ? `　·　当前只看【${bname}】，点品牌名可取消` : ''}。</p>`;

    const wrap = document.createElement('div');
    wrap.className = 'rv-clouds';

    [['pos', '好评关键词'], ['neg', '差评关键词']].forEach(([pol, title]) => {
      const col = document.createElement('div');
      col.className = 'rv-cloud ' + pol;
      const h = document.createElement('h3');
      h.textContent = title;
      col.appendChild(h);

      let list = data.keywords[pol];
      if (activeBrand) list = list.filter((k) => k.brands[activeBrand]).map((k) => ({ ...k, count: k.brands[activeBrand] }));
      list = list.sort((a, b) => b.count - a.count).slice(0, 28);

      if (!list.length) {
        const p = document.createElement('p');
        p.className = 'kw-empty';
        p.textContent = pol === 'neg' ? '这个品牌没有识别出负向关键词。' : '暂无。';
        col.appendChild(p);
      }

      const max = Math.max(...list.map((k) => k.count), 1);
      const box = document.createElement('div');
      box.className = 'kw-box';
      list.forEach((k) => {
        const t = document.createElement('button');
        t.className = 'kw';
        const scale = 0.82 + (Math.log(1 + k.count) / Math.log(1 + max)) * 0.9;
        t.style.fontSize = scale.toFixed(2) + 'rem';
        t.innerHTML = `<span></span><i>${k.count}</i>`;
        t.querySelector('span').textContent = k.term;
        t.addEventListener('mouseenter', () => showTip(t, k.term, pol));
        t.addEventListener('mouseleave', hideTip);
        t.addEventListener('click', () => showTip(t, k.term, pol));
        box.appendChild(t);
      });
      col.appendChild(box);
      wrap.appendChild(col);
    });

    sec.appendChild(wrap);
    return sec;
  }

  /* ── 侧栏：导入与品牌 ───────────────────────────────── */
  function renderRail() {
    const list = A.$('#rv-brands');
    list.innerHTML = '';
    if (!data?.brands.length) { list.innerHTML = '<p class="rail-hint">还没有品牌。</p>'; return; }

    data.brands.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'rv-brow' + (activeBrand === b.id ? ' on' : '');
      row.innerHTML = `<i></i><div><b></b><span></span></div>`;
      row.querySelector('i').style.background = b.color;
      row.querySelector('b').textContent = b.name;
      row.querySelector('span').textContent = `${b.total} 条 · ${b.firstDate.slice(0, 7)} 起`;
      row.onclick = () => { activeBrand = activeBrand === b.id ? '' : b.id; render(); renderRail(); };

      if (A.me.admin) {
        row.appendChild(A.mkKill('删除这个品牌的全部评论', async (e) => {
          if (!confirm(`删除「${b.name}」的 ${b.total} 条评论？这个操作不可撤销。`)) return;
          try {
            await call('/api/reviews/brand/' + b.id, { method: 'DELETE' });
            A.toast('已删除');
            if (activeBrand === b.id) activeBrand = '';
            refresh();
          } catch (err) { A.toast(err.message, 'bad'); }
        }));
      }
      list.appendChild(row);
    });
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
    renderRail();
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

    // 拖拽导入
    const drop = A.$('#rv-drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hot'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('hot')));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) doImport(f, nameInput.value);
    });

    window.addEventListener('scroll', hideTip, true);
    refresh();
  }

  return { init, refresh, render };
})();
