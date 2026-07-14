/**
 * preview3d-store.js — 竞品 3D 预览的数据源
 *
 * 和评论库不同：这份表格是"当前最新价目/参数"的一张快照，不是逐条追加的
 * 历史记录。所以每次导入用整份覆盖产品列表，而不是增量合并——旧数据要
 * 被新表格取代，不会有删不掉的僵尸行。
 *
 * 品牌颜色单独持久化、不随每次导入清空：同一个品牌换了几轮表格，颜色
 * 也不会跳来跳去（散点图里颜色是识别品牌的主要线索，跳色会认错点）。
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { readRecords } = require('./xlsx-lite.js');

const PALETTE = ['#4ee0c1', '#5b8cff', '#f4a63b', '#e2679a', '#9b7ff0', '#3fbf6f', '#ef6b5e', '#3fc0d8', '#c9922f', '#e34848', '#7c6fe0', '#b3653f'];

const COL = { brand: '品牌', model: '型号', sku: '商品ID', price: '价格', pmCadr: '颗粒物CADR', hchoCadr: '甲醛CADR', url: '商品链接' };
const REQUIRED = Object.values(COL);
// 销售额/销量是可选列——旧表格没有这两列也能正常导入，只是气泡在这两个维度下会显示为 0
const COL_OPT = { sales: '5-6月销售额', qty: '5-6月销量' };

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

class Preview3DStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'products3d.json');
    this.products = [];
    this.brandColor = {};
  }

  async load() {
    await fsp.mkdir(this.dir, { recursive: true });
    try {
      const s = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      this.products = Array.isArray(s.products) ? s.products : [];
      this.brandColor = s.brandColor || {};
    } catch { /* 首次运行，没有文件 */ }
    console.log(`[preview3d] 载入 ${this.products.length} 款产品`);
  }

  async persist() {
    await fsp.writeFile(this.file, JSON.stringify({ products: this.products, brandColor: this.brandColor, updatedAt: new Date().toISOString() }, null, 1));
  }

  /** 导入一份 xlsx：表头必须含 品牌/型号/商品ID/价格/颗粒物CADR/甲醛CADR/商品链接 */
  async import(buf) {
    const rows = readRecords(buf);
    if (!rows.length) throw new Error('这个表格是空的');
    const missing = REQUIRED.filter((c) => !(c in rows[0]));
    if (missing.length) throw new Error(`缺少列：${missing.join('、')}（表头必须是：${REQUIRED.join('、')}）`);

    const products = [];
    let skipped = 0;
    for (const r of rows) {
      const sku = String(r[COL.sku] || '').trim();
      const brand = String(r[COL.brand] || '').trim();
      if (!sku || !brand) { skipped++; continue; }
      products.push({
        sku, brand, model: String(r[COL.model] || '').trim(),
        price: num(r[COL.price]), pmCadr: num(r[COL.pmCadr]), hchoCadr: num(r[COL.hchoCadr]),
        sales: num(r[COL_OPT.sales]), qty: num(r[COL_OPT.qty]),
        url: String(r[COL.url] || '').trim()
      });
    }
    if (!products.length) throw new Error('没有一行数据能用——检查「品牌」和「商品ID」两列是不是都填了');

    // 新品牌接着已有的调色板往下分配，不打乱老品牌的颜色
    [...new Set(products.map((p) => p.brand))].forEach((b) => {
      if (!(b in this.brandColor)) this.brandColor[b] = PALETTE[Object.keys(this.brandColor).length % PALETTE.length];
    });

    this.products = products;
    await this.persist();
    return { total: products.length, brands: new Set(products.map((p) => p.brand)).size, skipped };
  }

  get summary() {
    const products = this.products.map((p) => ({ ...p, color: this.brandColor[p.brand] || PALETTE[0] }));
    const brandNames = [...new Set(products.map((p) => p.brand))];
    const brands = brandNames.map((name) => ({
      name, color: this.brandColor[name] || PALETTE[0], count: products.filter((p) => p.brand === name).length
    }));
    return { products, brands, updatedAt: new Date().toISOString() };
  }
}

module.exports = { Preview3DStore };
