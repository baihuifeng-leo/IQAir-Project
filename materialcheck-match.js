'use strict';

const CATEGORIES = ['产品型号', '产品利益点', '日常销售利益点', '大促销售权益', '附加权益', '国补', '价格', '其它'];
const PRODUCT_TYPES = ['machine', 'filter', 'accessory'];

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
 * 从 OCR 文字里提取"看起来像价格"的数字。PaddleOCR 按视觉位置逐行识别，¥/￥ 符号
 * 跟数字的前后顺序、是否隔着换行都不固定（同一张图有时候是"775\n¥"，有时候是
 * "￥\n399"），所以不要求符号紧贴数字，只要求隔着不超过几个字符/一次换行。
 * "元"作为后缀就不用符号也能判定（比如"选购价5880元"）。
 */
function extractPriceCandidates(text) {
  const s = String(text || '');
  const nums = new Set();
  const patterns = [
    /[¥￥][\s\S]{0,4}?([\d,]{2,7})/g,
    /([\d,]{2,7})[\s\S]{0,4}?[¥￥]/g,
    /([\d,]{2,7})\s*元/g
  ];
  patterns.forEach((re) => {
    let m;
    while ((m = re.exec(s))) {
      const n = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) nums.add(n);
    }
  });
  return nums;
}

/**
 * 价格强校验：product.price 配置了预期价格，就必须在素材文字里找到一模一样的数字，
 * 找不到（不管是压根没出现价格，还是出现了别的数字）都算价格不对——这条比缺词/
 * 串词都更需要"零容忍"，因为写错价、写低价直接导致过投诉。没配置 price 的产品
 * 不做这项校验（历史数据/还没配置的产品不应该被误判）。
 */
function checkPrice(text, product) {
  if (product.price == null) return null;
  const candidates = extractPriceCandidates(text);
  if (candidates.has(product.price)) return null;
  return { expected: product.price, found: [...candidates] };
}

/**
 * 校验关键词库唯一性：同一个词不能出现在两处——产品之间、产品词与通用词之间、
 * 或者跟自定义分组的共享词之间都不行。一个词只能属于唯一一个"归属"。
 * groups 是可选的第三参数（[{id,name,type,keywords}, ...]），不传时行为跟老版本
 * 一致，只查产品词和全局通用词。
 */
function validateLibrary(products, universalKeywords, groups = []) {
  const seen = new Map();
  const conflicts = [];
  const record = (kw, where) => {
    const text = keywordText(kw);
    if (seen.has(text)) conflicts.push({ keyword: text, first: seen.get(text), second: where });
    else seen.set(text, where);
  };
  (products || []).forEach((p) => (p.keywords || []).forEach((kw) => record(kw, p.name)));
  (universalKeywords || []).forEach((kw) => record(kw, '通用词'));
  (groups || []).forEach((g) => (g.keywords || []).forEach((kw) => record(kw, `分组「${g.name}」`)));
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
 * 缺词 = 本产品专属关键词、全局通用词、本产品所在分组的共享词——这三类都是强关联，
 * 每一条都必须在素材文字里各自独立出现，少哪条就是哪条缺词（不是"沾边就算过"）。
 * 串词 = 其它产品专属关键词，或者不是本产品所在分组的其它分组共享词，出现在了本文本里。
 * 自定义分组：同一个分组内的成员互相共享词，不算串词也不算缺词豁免——恰恰相反，组内
 * 成员本来就该有这些共享词，缺了要报；不同分组之间、或者分组跟未分组产品之间，正常按
 * "是不是自己的词"来判定串词，product.groupIds 包含 group.id 才算"自己的"——一个产品
 * 可以同时属于多个分组（比如同时要求"机器通用"和"瑞士制造机型"两组的共享词）。
 *
 * 价格 = product.price 配置了预期价格时的强校验，跟串词同级——图里的价格跟预期
 * 对不上（不管是写错了还是压根没出现），都直接算报错，不走缺词那套"提醒"档位。
 *
 * 三态严重程度是固定规则，不做成可配置项：串词/价格不对 > 缺词 > 通过。
 */
function matchAgainstProduct(text, product, allProducts, groups = [], universalKeywords = []) {
  const myGroupIds = product.groupIds || [];
  const missingKeywords = [];
  (product.keywords || [])
    .filter((kw) => findKeywordHits(text, [kw]).length === 0)
    .forEach((kw) => missingKeywords.push({ keyword: keywordText(kw), source: 'own' }));
  (universalKeywords || [])
    .filter((kw) => findKeywordHits(text, [kw]).length === 0)
    .forEach((kw) => missingKeywords.push({ keyword: keywordText(kw), source: 'universal' }));
  (groups || []).forEach((g) => {
    if (!myGroupIds.includes(g.id)) return;
    (g.keywords || [])
      .filter((kw) => findKeywordHits(text, [kw]).length === 0)
      .forEach((kw) => missingKeywords.push({ keyword: keywordText(kw), source: 'group', groupName: g.name }));
  });

  const crossedKeywords = [];
  allProducts.forEach((other) => {
    if (other.id === product.id) return;
    findKeywordHits(text, other.keywords || []).forEach((kw) => {
      crossedKeywords.push({ keyword: keywordText(kw), fromProductId: other.id, fromProductName: other.name });
    });
  });
  (groups || []).forEach((g) => {
    if (myGroupIds.includes(g.id)) return;
    findKeywordHits(text, g.keywords || []).forEach((kw) => {
      crossedKeywords.push({ keyword: keywordText(kw), fromProductId: null, fromProductName: `分组「${g.name}」` });
    });
  });

  const priceIssue = checkPrice(text, product);

  const status = (crossedKeywords.length > 0 || priceIssue) ? 'error' : missingKeywords.length > 0 ? 'warn' : 'pass';
  return { missingKeywords, crossedKeywords, priceIssue, status };
}

module.exports = {
  CATEGORIES, PRODUCT_TYPES,
  normalize, keywordText, keywordCategory, findKeywordHits, validateLibrary, resolveByFilename,
  resolveProduct, resolveProductForUpload, crossCheckWarning, matchAgainstProduct,
  extractPriceCandidates, checkPrice
};
