'use strict';

function normalize(s) {
  return String(s || '').replace(/\s+/g, '');
}

function findKeywordHits(text, keywords) {
  const norm = normalize(text);
  return keywords.filter((k) => norm.includes(normalize(k)));
}

/** 校验关键词库唯一性：同一个词不能出现在两处（不管是两个产品之间，还是产品词和通用词之间）。 */
function validateLibrary(products, universalKeywords) {
  const seen = new Map();
  const conflicts = [];
  const record = (kw, where) => {
    if (seen.has(kw)) conflicts.push({ keyword: kw, first: seen.get(kw), second: where });
    else seen.set(kw, where);
  };
  products.forEach((p) => (p.keywords || []).forEach((kw) => record(kw, p.name)));
  (universalKeywords || []).forEach((kw) => record(kw, '通用词'));
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

/** 缺词 = 本产品专属关键词里没在文本中出现的；串词 = 其它产品专属关键词出现在了本文本里。通用词两边都不参与。 */
function matchAgainstProduct(text, product, allProducts) {
  const missingKeywords = (product.keywords || []).filter((kw) => findKeywordHits(text, [kw]).length === 0);
  const crossedKeywords = [];
  allProducts.forEach((other) => {
    if (other.id === product.id) return;
    findKeywordHits(text, other.keywords || []).forEach((keyword) => {
      crossedKeywords.push({ keyword, fromProductId: other.id, fromProductName: other.name });
    });
  });
  const status = missingKeywords.length === 0 && crossedKeywords.length === 0 ? 'pass' : 'fail';
  return { missingKeywords, crossedKeywords, status };
}

module.exports = {
  normalize, findKeywordHits, validateLibrary, resolveByFilename,
  resolveProduct, resolveProductForUpload, crossCheckWarning, matchAgainstProduct
};
