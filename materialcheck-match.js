'use strict';

const CATEGORIES = ['产品型号', '产品利益点', '日常销售利益点', '大促销售权益', '附加权益', '国补', '价格', '其它'];
const PRODUCT_TYPES = ['machine', 'filter', 'accessory'];
const SHARED_POOL_LABELS = { machine: '机器组内通用词', filter: '滤芯组内通用词', accessory: '附件组内通用词' };

function normalize(s) {
  return String(s || '').replace(/\s+/g, '');
}

/** 关键词条目可以是纯字符串，也可以是 { text, category } 对象——这里统一取出文字部分。 */
function keywordText(k) {
  return typeof k === 'string' ? k : String((k && k.text) || '');
}

/** 同上，取分类；不是合法分类值（或没给）一律归到"其它"，不因为脏数据抛错。 */
function keywordCategory(k) {
  const c = k && typeof k === 'object' ? k.category : null;
  return CATEGORIES.includes(c) ? c : '其它';
}

function findKeywordHits(text, keywords) {
  const norm = normalize(text);
  return (keywords || []).filter((k) => norm.includes(normalize(keywordText(k))));
}

/**
 * 校验关键词库唯一性：同一个词不能出现在两处——产品之间、产品词与通用词之间、
 * 或者跟机器/滤芯/附件三套组内通用词之间都不行。一个词只能属于唯一一个"归属"。
 * sharedPools 是可选的第三参数（{ machine: [...], filter: [...], accessory: [...] }），
 * 不传时行为跟老版本一致，只查产品词和全局通用词。
 */
function validateLibrary(products, universalKeywords, sharedPools = {}) {
  const seen = new Map();
  const conflicts = [];
  const record = (kw, where) => {
    const text = keywordText(kw);
    if (seen.has(text)) conflicts.push({ keyword: text, first: seen.get(text), second: where });
    else seen.set(text, where);
  };
  (products || []).forEach((p) => (p.keywords || []).forEach((kw) => record(kw, p.name)));
  (universalKeywords || []).forEach((kw) => record(kw, '通用词'));
  PRODUCT_TYPES.forEach((type) => {
    (sharedPools[type] || []).forEach((kw) => record(kw, SHARED_POOL_LABELS[type]));
  });
  return conflicts;
}

function resolveByFilename(filename, products) {
  const norm = normalize(filename).toLowerCase();
  const matches = products.filter((p) => norm.includes(normalize(p.name).toLowerCase()));
  return matches.length === 1 ? matches[0] : null;
}

/** 按每个产品自己的专属关键词在文本里命中的数量打分，只有明显领先（不并列）才算确定。 */
function resolveProduct(text, products) {
  const scored = products
    .map((p) => ({ product: p, hits: findKeywordHits(text, p.keywords || []) }))
    .filter((s) => s.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length);

  if (scored.length === 0) return { resolved: null, ambiguous: false };
  if (scored.length === 1) return { resolved: scored[0].product, ambiguous: false };
  if (scored[0].hits.length > scored[1].hits.length) return { resolved: scored[0].product, ambiguous: false };
  return { resolved: null, ambiguous: true, candidates: scored.map((s) => s.product) };
}

/** 三级产品归属识别的编排：文件名 → OCR 反查 → 都不确定则交给人工。 */
function resolveProductForUpload(filename, ocrText, products) {
  const byFilename = resolveByFilename(filename, products);
  if (byFilename) return { method: 'filename', product: byFilename, ambiguous: false, candidates: [] };

  const byOcr = resolveProduct(ocrText, products);
  if (byOcr.resolved) return { method: 'ocr', product: byOcr.resolved, ambiguous: false, candidates: [] };

  return { method: null, product: null, ambiguous: true, candidates: byOcr.candidates || [] };
}

/** 即便文件名已经判定了产品，如果 OCR 文字更像属于另一个产品，给一条软提示。 */
function crossCheckWarning(resolvedProduct, ocrText, products) {
  const byOcr = resolveProduct(ocrText, products);
  if (byOcr.resolved && byOcr.resolved.id !== resolvedProduct.id) {
    return `型号可能填错了：素材文字更像属于「${byOcr.resolved.name}」`;
  }
  return null;
}

/**
 * 缺词 = 本产品专属关键词里没在文本中出现的；串词 = 其它产品专属关键词出现在了本文本里。
 * 通用词、机器/滤芯/附件组内通用词两边都不参与——因为 validateLibrary 保证了这些词
 * 永远不会同时也是某个产品的专属词，所以这里不需要额外感知 product.type 或任何通用词列表，
 * "组内可共享"这个效果是唯一性校验的副产品，不是匹配算法本身的特殊分支。
 *
 * 三态严重程度是固定规则，不做成可配置项：串词 > 缺词 > 通过。
 */
function matchAgainstProduct(text, product, allProducts) {
  const missingKeywords = (product.keywords || [])
    .filter((kw) => findKeywordHits(text, [kw]).length === 0)
    .map(keywordText);

  const crossedKeywords = [];
  allProducts.forEach((other) => {
    if (other.id === product.id) return;
    findKeywordHits(text, other.keywords || []).forEach((kw) => {
      crossedKeywords.push({ keyword: keywordText(kw), fromProductId: other.id, fromProductName: other.name });
    });
  });

  const status = crossedKeywords.length > 0 ? 'error' : missingKeywords.length > 0 ? 'warn' : 'pass';
  return { missingKeywords, crossedKeywords, status };
}

module.exports = {
  CATEGORIES, PRODUCT_TYPES,
  normalize, keywordText, keywordCategory, findKeywordHits, validateLibrary, resolveByFilename,
  resolveProduct, resolveProductForUpload, crossCheckWarning, matchAgainstProduct
};
