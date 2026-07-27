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
 * 判断一整行 OCR 文字是否"纯粹就是价格数字"（比如独立成行的 "¥951"、"951"）——
 * 这种行不当候选关键词，因为已经有独立的 price 字段+专门的价格校验机制，重新收进
 * 关键词库只会变成上个月刚清理掉的那种冗余。要求整行掐头去尾之后只剩符号+数字（可选
 * 跟一个"元"字），只要行里还夹杂别的文字（比如"晒单送10元现金红包"）就不算price。
 */
function isPriceLikeLine(line) {
  const s = String(line || '').trim();
  if (!s || !/[¥￥\d]/.test(s)) return false;
  // 把价格相关的字符（符号/数字/逗号/小数点/"元"/空白）都去掉，剩下的是空的，
  // 就说明整行原本只是价格的呈现——包括单独一行的"￥"（数字被拆到另一行的情况）。
  return s.replace(/[¥￥\d,.\s元]/g, '') === '';
}

/**
 * 批量自动识别词库用：把 OCR 整段文字按行拆开，每一行都是一个候选关键词（不做任何
 * 语义过滤，宁可混进垃圾/误读行也不能漏掉真词——审核时人工删掉垃圾行的成本，远低于
 * 漏收一个真关键词又没被发现的成本），只排除两类：整行是价格的（见 isPriceLikeLine）、
 * 和这个产品自己已经有的词完全一样的（去空格后比较，不做模糊/相似度匹配）。
 * 同一行在这张图里出现多次只算一个候选。
 */
function buildKeywordCandidates(ocrText, product) {
  const existing = new Set((product.keywords || []).map((k) => normalize(keywordText(k))));
  const seen = new Set();
  const candidates = [];
  String(ocrText || '').split('\n').forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    const norm = normalize(line);
    if (seen.has(norm) || existing.has(norm) || isPriceLikeLine(line)) return;
    seen.add(norm);
    candidates.push(line);
  });
  return candidates;
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
 * 产品与关键词强绑定：每个产品自己维护一份完整清单，同一个词可以在多个产品里各自
 * 重复出现，互不冲突（不再要求全局唯一）。
 *
 * 缺词 = 本产品自己清单里的词，没能在素材文字里找到。
 * 多出的词 = 素材文字里出现了某个别的产品的词，但这个词不在本产品自己清单里——
 * 如果这个词本产品也有（说明是有意重复录入的共享词），就不算多出的，是正常的自己的词。
 *
 * 价格 = product.price 配置了预期价格时的强校验，跟"多出的词"同级——图里的价格跟
 * 预期对不上（不管是写错了还是压根没出现），都直接算报错，不走缺词那套"提醒"档位。
 *
 * 三态严重程度是固定规则，不做成可配置项：多出的词/价格不对 > 缺词 > 通过。
 */
function matchAgainstProduct(text, product, allProducts) {
  const missingKeywords = (product.keywords || [])
    .filter((kw) => findKeywordHits(text, [kw]).length === 0)
    .map((kw) => keywordText(kw));

  const myKeywordTexts = new Set((product.keywords || []).map((kw) => keywordText(kw)));
  const extraKeywords = [];
  const seen = new Set();
  allProducts.forEach((other) => {
    if (other.id === product.id) return;
    findKeywordHits(text, other.keywords || []).forEach((kw) => {
      const t = keywordText(kw);
      if (myKeywordTexts.has(t) || seen.has(t)) return;
      seen.add(t);
      extraKeywords.push(t);
    });
  });

  const priceIssue = checkPrice(text, product);

  const status = (extraKeywords.length > 0 || priceIssue) ? 'error' : missingKeywords.length > 0 ? 'warn' : 'pass';
  return { missingKeywords, extraKeywords, priceIssue, status };
}

module.exports = {
  CATEGORIES, PRODUCT_TYPES,
  normalize, keywordText, keywordCategory, findKeywordHits, resolveByFilename,
  resolveProduct, resolveProductForUpload, crossCheckWarning, matchAgainstProduct,
  extractPriceCandidates, checkPrice, isPriceLikeLine, buildKeywordCandidates
};
