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
    this.records = new Map();   // id → record
    this.brands = [];
    this.summary = null;
  }

  async load() {
    await fsp.mkdir(this.dir, { recursive: true });

    try {
      this.brands = JSON.parse(await fsp.readFile(this.brandsFile, 'utf8'));
    } catch { this.brands = []; }

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
    console.log(`[reviews] 载入 ${this.records.size} 条评论，${this.brands.length} 个品牌`);
  }

  saveBrands() { return fsp.writeFile(this.brandsFile, JSON.stringify(this.brands, null, 1)); }

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

  /** 导入一个 xlsx。返回报告，不抛异常给不了信息的错。 */
  async import(buf, brandName) {
    const brand = this.ensureBrand(brandName);
    const { records, stats } = parseWorkbook(buf, { brandId: brand.id, brandName: brand.name });
    const report = mergeIncremental(this.records, records);

    const added = records.filter((r) => this.records.get(r.id) === r);
    await this.append(added);
    await this.saveBrands();
    this.rebuild();

    return { brand: brand.name, ...stats, ...report };
  }

  async removeBrand(brandId) {
    const keep = [...this.records.values()].filter((r) => r.brandId !== brandId);
    this.records = new Map(keep.map((r) => [r.id, r]));
    this.brands = this.brands.filter((b) => b.id !== brandId);
    // 整体重写：删除是低频操作，值得一次全量落盘换来文件干净
    await fsp.writeFile(this.file, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
    await this.saveBrands();
    this.rebuild();
  }

  /* ── 聚合：导入后重算一次，之后都读缓存 ───────────────── */
  rebuild() {
    const t0 = Date.now();
    // 维度抽取现算，不从 jsonl 读 —— 词典升级后重启即生效
    for (const r of this.records.values()) {
      r.aspects = r.isTemplate ? [] : extract(r.text);
    }
    const brands = {};
    const kw = { pos: new Map(), neg: new Map() };
    const aspectTotals = {};
    const colorOf = (id) => this.brands.find((x) => x.id === id)?.color || PALETTE[0];

    for (const r of this.records.values()) {
      const b = brands[r.brandId] || (brands[r.brandId] = {
        id: r.brandId, name: r.brandName, color: colorOf(r.brandId), total: 0, template: 0,
        posClauses: 0, negClauses: 0, useful: 0, aspects: {}, skus: {}, firstDate: '9999', lastDate: '0'
      });
      b.total++;
      b.useful += r.useful || 0;
      b.skus[r.sku] = (b.skus[r.sku] || 0) + 1;
      if (r.date) { if (r.date < b.firstDate) b.firstDate = r.date; if (r.date > b.lastDate) b.lastDate = r.date; }
      if (r.isTemplate) { b.template++; continue; }

      for (const a of r.aspects || []) {
        b[a.polarity === 'pos' ? 'posClauses' : 'negClauses']++;
        const x = b.aspects[a.aspect] || (b.aspects[a.aspect] = { pos: 0, neg: 0 });
        x[a.polarity]++;

        const t = aspectTotals[a.aspect] || (aspectTotals[a.aspect] = { pos: 0, neg: 0 });
        t[a.polarity]++;

        for (const term of a.terms) {
          const m = kw[a.polarity];
          const e = m.get(term) || { term, count: 0, brands: {}, aspects: {} };
          e.count++;
          e.brands[r.brandId] = (e.brands[r.brandId] || 0) + 1;
          e.aspects[a.aspect] = (e.aspects[a.aspect] || 0) + 1;
          m.set(term, e);
        }
      }
    }

    const top = (m, n) => [...m.values()].sort((a, b) => b.count - a.count).slice(0, n);

    // 全局 top(40) 只留下了全站最高频的词——小品牌自己的高频差评词很可能挤不进这 40 个，
    // 选中品牌后关键词云看起来对不上总数、甚至没怎么变化。这里按品牌单独排一次 top，
    // 数据在聚合时已经按 brandId 存在每个词的 e.brands 里，不用重新扫一遍评论。
    const topForBrand = (m, brandId, n) =>
      [...m.values()]
        .filter((e) => e.brands[brandId])
        .map((e) => ({ term: e.term, count: e.brands[brandId], aspects: e.aspects }))
        .sort((a, b) => b.count - a.count)
        .slice(0, n);

    const keywordsByBrand = {};
    Object.keys(brands).forEach((brandId) => {
      keywordsByBrand[brandId] = { pos: topForBrand(kw.pos, brandId, 40), neg: topForBrand(kw.neg, brandId, 40) };
    });

    this.summary = {
      totals: {
        reviews: this.records.size,
        template: Object.values(brands).reduce((s, b) => s + b.template, 0),
        brands: Object.keys(brands).length
      },
      brands: Object.values(brands).sort((a, b) => b.total - a.total),
      aspects: aspectTotals,
      keywords: { pos: top(kw.pos, 40), neg: top(kw.neg, 40) },
      keywordsByBrand,
      updatedAt: new Date().toISOString(),
      buildMs: Date.now() - t0
    };
  }

  /** 关键词溯源：返回包含这个词的原始评论上下文 */
  contexts(term, polarity, brandId, limit = 30) {
    const out = [];
    for (const r of this.records.values()) {
      if (brandId && r.brandId !== brandId) continue;
      for (const a of r.aspects || []) {
        if (a.polarity !== polarity || !a.terms.includes(term)) continue;
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
