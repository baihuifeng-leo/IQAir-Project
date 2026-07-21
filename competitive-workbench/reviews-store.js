/**
 * reviews-store.js — 评论库
 *
 * 评论和沙盘/对位是两种完全不同的数据：
 *   沙盘   几十 KB · 多人实时协同 · 需要三方合并
 *   评论   数千条 · 批量导入 · 只追加 · 内容寻址天然无冲突
 * 所以它不进 db.json，单独放 reviews.jsonl（一行一条，append-only）。
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { parseWorkbook, mergeIncremental } = require('./reviews-ingest.js');
const { extract } = require('./reviews-nlp.js');

const PALETTE = ['#4ee0c1', '#5b8cff', '#f4a63b', '#e2679a', '#9b7ff0', '#3fbf6f', '#ef6b5e', '#3fc0d8', '#c9922f'];

class ReviewStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'reviews.jsonl');
    this.brandsFile = path.join(dir, 'brands.json');
    this.productsFile = path.join(dir, 'products.json');
    this.records = new Map();   // id → record
    this.brands = [];
    this.products = [];         // 「本品分析」用——每个产品挂在某个品牌（通常是自己）之下
    this.summary = null;
  }

  async load() {
    await fsp.mkdir(this.dir, { recursive: true });

    try {
      this.brands = JSON.parse(await fsp.readFile(this.brandsFile, 'utf8'));
    } catch { this.brands = []; }

    try {
      this.products = JSON.parse(await fsp.readFile(this.productsFile, 'utf8'));
    } catch { this.products = []; }

    try {
      const text = await fsp.readFile(this.file, 'utf8');
      let broken = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); this.records.set(r.id, r); }
        catch { broken++; }
      }
      if (broken) console.warn(`[reviews] 跳过 ${broken} 行损坏的记录`);
    } catch { /* 首次运行，没有文件 */ }

    this.rebuild();
    console.log(`[reviews] 载入 ${this.records.size} 条评论，${this.brands.length} 个品牌，${this.products.length} 个产品`);
  }

  saveBrands() { return fsp.writeFile(this.brandsFile, JSON.stringify(this.brands, null, 1)); }
  saveProducts() { return fsp.writeFile(this.productsFile, JSON.stringify(this.products, null, 1)); }

  /** 追加写：只落新记录，不重写整个文件 */
  async append(records) {
    if (!records.length) return;
    await fsp.appendFile(this.file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  ensureBrand(name) {
    const id = 'rb_' + Buffer.from(name).toString('hex').slice(0, 12);
    let b = this.brands.find((x) => x.id === id);
    if (!b) {
      b = { id, name, color: PALETTE[this.brands.length % PALETTE.length] };
      this.brands.push(b);
    }
    return b;
  }

  /** 「本品分析」的产品——挂在品牌之下，同名产品直接复用，不会建出一堆重复的 */
  async ensureProduct(brandId, name) {
    const n = String(name || '').trim();
    if (!n) throw new Error('产品名称不能为空');
    let p = this.products.find((x) => x.brandId === brandId && x.name === n);
    if (!p) {
      p = { id: 'rp_' + Buffer.from(brandId + '' + n).toString('hex').slice(0, 16), brandId, name: n };
      this.products.push(p);
      await this.saveProducts();
      this.rebuild();
    }
    return p;
  }

  async removeProduct(productId) {
    const keep = [...this.records.values()].filter((r) => r.productId !== productId);
    this.records = new Map(keep.map((r) => [r.id, r]));
    this.products = this.products.filter((p) => p.id !== productId);
    await fsp.writeFile(this.file, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
    await this.saveProducts();
    this.rebuild();
  }

  /**
   * 导入一个 xlsx。返回报告，不抛异常给不了信息的错。
   * productId 给了就是「本品分析」的导入——记录同时打上 brandId 和 productId，
   * 品牌视图（热力图/关键词云）会照常把它汇总进所属品牌，不用额外同步两份数据。
   * 这种情况下品牌完全由产品自己的 brandId 决定，忽略传入的 brandName，
   * 不然两个参数万一对不上号，会出现"记录的品牌"和"产品所属品牌"不一致的怪状态。
   */
  async import(buf, brandName, productId) {
    let brand, product = null;
    if (productId) {
      product = this.products.find((p) => p.id === productId);
      if (!product) throw new Error('这个产品不存在，可能已被删除，刷新页面重新选一个');
      brand = this.brands.find((b) => b.id === product.brandId);
      if (!brand) throw new Error('产品所属的品牌不存在了，数据可能损坏');
    } else {
      brand = this.ensureBrand(brandName);
    }
    const { records, stats } = parseWorkbook(
      buf,
      { brandId: brand.id, brandName: brand.name },
      product ? { productId: product.id, productName: product.name } : undefined
    );
    const report = mergeIncremental(this.records, records);

    const added = records.filter((r) => this.records.get(r.id) === r);
    await this.append(added);
    await this.saveBrands();
    this.rebuild();

    return { brand: brand.name, product: product?.name || '', ...stats, ...report };
  }

  async removeBrand(brandId) {
    const keep = [...this.records.values()].filter((r) => r.brandId !== brandId);
    this.records = new Map(keep.map((r) => [r.id, r]));
    this.brands = this.brands.filter((b) => b.id !== brandId);
    this.products = this.products.filter((p) => p.brandId !== brandId);
    // 整体重写：删除是低频操作，值得一次全量落盘换来文件干净
    await fsp.writeFile(this.file, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
    await this.saveBrands();
    await this.saveProducts();
    this.rebuild();
  }

  /**
   * 聚合的核心逻辑，品牌视图、产品视图（本品分析）共用——两者本质上都是
   * "给一批评论记录，按某个 key 分组，算出维度统计 + 关键词 top"，唯一区别
   * 是分组用的 key（brandId 还是 productId）。之前只有品牌一种分组，这段
   * 逻辑是直接写在 rebuild() 里的；现在抽出来避免整段复制一遍。
   */
  static aggregateBy(records, keyOf, metaOf) {
    const groups = {};
    const kw = { pos: new Map(), neg: new Map() };
    const aspectTotals = {};

    for (const r of records) {
      const key = keyOf(r);
      if (!key) continue;
      const g = groups[key] || (groups[key] = {
        id: key, ...metaOf(key, r), total: 0, template: 0,
        posClauses: 0, negClauses: 0, useful: 0, aspects: {}, skus: {}, firstDate: '9999', lastDate: '0'
      });
      g.total++;
      g.useful += r.useful || 0;
      g.skus[r.sku] = (g.skus[r.sku] || 0) + 1;
      if (r.date) { if (r.date < g.firstDate) g.firstDate = r.date; if (r.date > g.lastDate) g.lastDate = r.date; }
      if (r.isTemplate) { g.template++; continue; }

      for (const a of r.aspects || []) {
        g[a.polarity === 'pos' ? 'posClauses' : 'negClauses']++;
        const x = g.aspects[a.aspect] || (g.aspects[a.aspect] = { pos: 0, neg: 0 });
        x[a.polarity]++;

        const t = aspectTotals[a.aspect] || (aspectTotals[a.aspect] = { pos: 0, neg: 0 });
        t[a.polarity]++;

        for (const term of a.terms) {
          const m = kw[a.polarity];
          const e = m.get(term) || { term, count: 0, groups: {}, aspects: {} };
          e.count++;
          e.groups[key] = (e.groups[key] || 0) + 1;
          e.aspects[a.aspect] = (e.aspects[a.aspect] || 0) + 1;
          m.set(term, e);
        }
      }
    }
    return { groups, kw, aspectTotals };
  }

  static top(m, n) { return [...m.values()].sort((a, b) => b.count - a.count).slice(0, n); }

  // 全局 top(40) 只留下了全站最高频的词——小分组自己的高频差评词很可能挤不进这 40 个，
  // 选中之后关键词云看起来对不上总数、甚至没怎么变化。这里按分组单独排一次 top，
  // 数据在聚合时已经按 key 存在每个词的 e.groups 里，不用重新扫一遍评论。
  static topForGroup(m, key, n) {
    return [...m.values()]
      .filter((e) => e.groups[key])
      .map((e) => ({ term: e.term, count: e.groups[key], aspects: e.aspects }))
      .sort((a, b) => b.count - a.count)
      .slice(0, n);
  }

  /* ── 聚合：导入后重算一次，之后都读缓存 ───────────────── */
  rebuild() {
    const t0 = Date.now();
    // 维度抽取现算，不从 jsonl 读 —— 词典升级后重启即生效
    for (const r of this.records.values()) {
      r.aspects = r.isTemplate ? [] : extract(r.text);
    }
    const allRecords = [...this.records.values()];
    const { aggregateBy, top, topForGroup } = ReviewStore;

    const brandColorOf = (id) => this.brands.find((x) => x.id === id)?.color || PALETTE[0];
    const brandAgg = aggregateBy(allRecords, (r) => r.brandId, (id, r) => ({ name: r.brandName, color: brandColorOf(id) }));

    // 本品分析：只在打了 productId 的记录里聚合，产品名/所属品牌从记录本身取
    // （挂了的产品即使还没导入任何评论也要出现在列表里，所以最后拿 this.products 兜底一遍）
    const productAgg = aggregateBy(
      allRecords.filter((r) => r.productId),
      (r) => r.productId,
      (id, r) => ({ name: r.productName, brandId: r.brandId })
    );

    const keywordsByBrand = {};
    Object.keys(brandAgg.groups).forEach((id) => {
      keywordsByBrand[id] = { pos: topForGroup(brandAgg.kw.pos, id, 40), neg: topForGroup(brandAgg.kw.neg, id, 40) };
    });
    const keywordsByProduct = {};
    Object.keys(productAgg.groups).forEach((id) => {
      keywordsByProduct[id] = { pos: topForGroup(productAgg.kw.pos, id, 40), neg: topForGroup(productAgg.kw.neg, id, 40) };
    });

    this.summary = {
      totals: {
        reviews: this.records.size,
        template: Object.values(brandAgg.groups).reduce((s, b) => s + b.template, 0),
        brands: Object.keys(brandAgg.groups).length,
        products: this.products.length
      },
      brands: Object.values(brandAgg.groups).sort((a, b) => b.total - a.total),
      aspects: brandAgg.aspectTotals,
      keywords: { pos: top(brandAgg.kw.pos, 40), neg: top(brandAgg.kw.neg, 40) },
      keywordsByBrand,
      // 产品即使还没导入评论也要能被前端选到，所以从 this.products 出发、缺数据的补 total:0
      products: this.products.map((p) => ({
        ...p,
        total: 0, template: 0, posClauses: 0, negClauses: 0, useful: 0, aspects: {}, skus: {}, firstDate: '9999', lastDate: '0',
        ...(productAgg.groups[p.id] || {})
      })).sort((a, b) => b.total - a.total),
      productAspects: productAgg.aspectTotals,
      keywordsByProduct,
      updatedAt: new Date().toISOString(),
      buildMs: Date.now() - t0
    };
  }

  /**
   * 原文溯源：term 给了就按关键词找（关键词云用），不给就按 维度/极性/品牌/产品 找
   * （统计卡片、维度总览的差评段悬浮用——想看"这批记录里所有差评句"，不是某一个词）。
   */
  contexts({ polarity, brandId = '', productId = '', term = '', aspect = '', limit = 30 }) {
    const out = [];
    for (const r of this.records.values()) {
      if (brandId && r.brandId !== brandId) continue;
      if (productId && r.productId !== productId) continue;
      for (const a of r.aspects || []) {
        if (a.polarity !== polarity) continue;
        if (term && !a.terms.includes(term)) continue;
        if (aspect && a.aspect !== aspect) continue;
        out.push({
          id: r.id, brand: r.brandName, sku: r.sku, date: r.date,
          useful: r.useful, aspect: a.aspect,
          context: a.context,
          text: r.text.length > 240 ? r.text.slice(0, 240) + '…' : r.text
        });
        break;
      }
      if (out.length >= limit) break;
    }
    // 「有用」数高的排前面 —— 被更多人认可的评论更值得看
    return out.sort((a, b) => b.useful - a.useful);
  }
}

module.exports = { ReviewStore };
