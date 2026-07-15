/**
 * reviews-ingest.js — Excel 解析 → 规范化 → 增量去重入库
 *
 * 表头（来自真实导出，7 个文件完全一致）：
 *   序号 · 旺旺号 · 初评时间 · SKU · 初评 · 晒图/视频 · 有用 · 追评 · 追评时间 · 追评晒图/视频
 *
 * 「序号」是导出时的行号，不同批次会变，没有任何业务含义 → 直接丢弃。
 * 「追评」是一条独立评论（有自己的时间和图），拆成单独一行入库。
 */
'use strict';
const crypto = require('crypto');
const { readRecords } = require('./xlsx-lite.js');
const { normalize, isTemplate } = require('./reviews-nlp.js');

const COLUMNS = ['旺旺号', '初评时间', 'SKU', '初评', '晒图/视频', '有用', '追评', '追评时间', '追评晒图/视频'];

/**
 * 去重键。
 *
 * 不能只对正文取哈希 —— 实测 5,623 条初评里，
 * 「该用户觉得商品非常好，给出5星好评」一句就出现 904 次，来自 600 个不同买家。
 * 只按正文去重会把它们压成 1 条，同时误杀 44 条不同买家写出的相同真实短评。
 *
 * 所以键 = 品牌 + SKU + 旺旺号 + 日期 + 类型 + 正文摘要。
 * 旺旺号已脱敏（"用**2"）、时间只到天，单独任何一个都不唯一，组合起来才够。
 */
function fingerprint({ brandId, sku, nick, date, type, text }) {
  const payload = [brandId, sku || '', nick || '', date || '', type, normalize(text)].join('\u0001');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/** 晒图/视频 是 JSON 数组字符串，空值是 "[]" */
function parseMedia(cell) {
  const s = String(cell || '').trim();
  if (!s || s === '[]') return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.map((u) => (u.startsWith('//') ? 'https:' + u : u)) : [];
  } catch {
    return [];
  }
}

/** SKU 字段很脏："深灰色"、"Z90空气净化器【店铺热销】"、"深灰色[Z90空气净化器]" */
function cleanSku(raw) {
  return String(raw || '')
    .replace(/【[^】]*】/g, '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || '未标注';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 解析一个 xlsx buffer → 规范化记录数组
 * @param {Buffer} buf
 * @param {{brandId:string, brandName:string}} brand
 * @param {{productId:string, productName:string}} [product] 「本品分析」才会传——
 *   产品记录同时也打上 brandId，所以「品牌 × 维度」那套统计天然把它汇总进去，
 *   不需要额外写一份汇总逻辑
 */
function parseWorkbook(buf, brand, product) {
  const rows = readRecords(buf);
  if (!rows.length) throw new Error('这个 Excel 是空的');

  const headers = Object.keys(rows[0]);
  const missing = ['初评时间', '初评'].filter((c) => !headers.includes(c));
  if (missing.length) throw new Error(`缺少必需的列：${missing.join('、')}。当前表头：${headers.join('、')}`);

  const out = [];
  const stats = { rows: rows.length, 初评: 0, 追评: 0, 模板: 0, 无效日期: 0 };

  for (const r of rows) {
    const nick = String(r['旺旺号'] || '').trim();
    const sku = cleanSku(r['SKU']);

    const push = (type, text, date, media, useful) => {
      const t = String(text || '').trim();
      if (!t) return;
      if (date && !DATE_RE.test(date)) stats.无效日期++;
      const tmpl = isTemplate(t);
      if (tmpl) stats.模板++;
      stats[type]++;
      out.push({
        id: fingerprint({ brandId: brand.brandId, sku, nick, date, type, text: t }),
        brandId: brand.brandId,
        brandName: brand.brandName,
        ...(product ? { productId: product.productId, productName: product.productName } : {}),
        sku,
        nick,
        type,                       // 初评 | 追评
        date: date || '',
        text: t,
        textNorm: normalize(t),
        media,
        useful: Number(useful) || 0,
        isTemplate: tmpl
        // 注意：不存 aspects。维度抽取在载入时现算，
        // 这样改了 reviews-nlp.js 的词典，重启即生效，不必重新导入 Excel。
      });
    };

    push('初评', r['初评'], String(r['初评时间'] || '').trim(), parseMedia(r['晒图/视频']), r['有用']);
    push('追评', r['追评'], String(r['追评时间'] || '').trim(), parseMedia(r['追评晒图/视频']), 0);
  }

  return { records: out, stats };
}

/**
 * 增量合并：只追加库里没有的
 * @param {Map<string,object>} store  现有库，key 是 fingerprint
 * @param {object[]} incoming
 */
function mergeIncremental(store, incoming) {
  const report = { incoming: incoming.length, added: 0, skipped: 0, dupInFile: 0 };
  const seenThisFile = new Set();

  for (const rec of incoming) {
    if (seenThisFile.has(rec.id)) { report.dupInFile++; continue; }
    seenThisFile.add(rec.id);

    if (store.has(rec.id)) { report.skipped++; continue; }
    store.set(rec.id, rec);
    report.added++;
  }
  return report;
}

module.exports = { parseWorkbook, mergeIncremental, fingerprint, cleanSku, parseMedia, COLUMNS };
