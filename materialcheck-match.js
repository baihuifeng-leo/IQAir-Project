'use strict';

const CATEGORIES = ['产品型号', '产品利益点', '日常销售利益点', '大促销售权益', '附加权益', '国补', '价格', '其它'];
const PRODUCT_TYPES = ['machine', 'filter', 'accessory'];
// 同一个产品的 1:1 和 3:4 素材文案有重叠也有差异（比如 3:4 素材下方多一段满赠权益，
// 1:1 裁掉了）——RATIOS 是关键词"专属于"某个比例时的合法取值；不在这两个值里
// （包括没配置过）一律按 keywordRatio() 归到 'both'，也就是两种比例的素材都要求它。
const RATIOS = ['1:1', '3:4'];

const SUPERSCRIPT_DIGITS = { '¹': '1', '²': '2', '³': '3' };

/** normalize() 用的规则表，每条规则带一个人话标签——这份表既用来拼出真正的
 *  normalize() 本身，也用来给「检测台」关键词明细面板反推"这个词是靠哪条规则
 *  才命中的"（见 explainFuzzyMatch），两边共用同一份定义，不会出现明细面板讲的
 *  理由跟真实匹配逻辑对不上的情况。 */
const NORMALIZE_STEPS = [
  {
    label: '上标数字折算', // "3m³"图里就是真实的上标，OCR 只能识成平常数字
    apply: (s) => s.replace(/[¹²³]/g, (ch) => SUPERSCRIPT_DIGITS[ch])
  },
  {
    label: '比较符号（<>＜＞）忽略', // 词库里"CCM颗粒物>1,000,000mg"这种写法，OCR 经常漏识别这个小符号
    apply: (s) => s.replace(/[<>＜＞]/g, '')
  },
  {
    label: '数字与单位间的乱入字母忽略', // ">" 在小尺寸图里被稳定误识成孤立字母，比如"1,000,000 r\nmg"
    apply: (s) => s.replace(/([\d,]{2,})\s+[A-Za-z]\s+(mg|kg|g|ml|L)\b/gi, '$1$2')
  },
  {
    label: '￥/¥ 全角半角统一', // 不同 PaddleOCR 模型档位对这个符号的识别宽度习惯不一样，词库也是人工维护
    apply: (s) => s.replace(/￥/g, '¥')
  },
  {
    label: '空白/换行忽略', // OCR 按视觉位置逐行识别，同一个词可能被拆到两行
    apply: (s) => s.replace(/\s+/g, '')
  }
];

function normalize(s) {
  return NORMALIZE_STEPS.reduce((acc, step) => step.apply(acc), String(s || ''));
}

/** 判断某个关键词在这段文字里是"逐字原样命中"还是"要靠 normalize() 的某几条
 *  规则才能命中"，用于检测台的关键词明细面板：逐字命中=绿色放心通过；
 *  靠规则命中=黄色，附上具体是哪几条规则起了作用（不是瞎猜的标签，是从
 *  NORMALIZE_STEPS 反推出来的，跟真实匹配逻辑必然一致）；两种都没命中=红色缺词。
 *  做法：依次去掉每一条规则重新跑一遍归一化，如果去掉后就不命中了，说明这条
 *  规则是必需的，记进 reasons。 */
function classifyKeywordMatch(text, keywordRaw) {
  const rawText = String(text || '');
  const rawKeyword = String(keywordRaw || '');
  if (rawText.includes(rawKeyword)) return { found: true, exact: true, reasons: [] };

  const fullyNormalized = normalize(rawText).includes(normalize(rawKeyword));
  if (!fullyNormalized) return { found: false, exact: false, reasons: [] };

  const reasons = NORMALIZE_STEPS
    .filter((step) => {
      const withoutThisStep = (s) => NORMALIZE_STEPS.reduce((acc, st) => (st === step ? acc : st.apply(acc)), String(s || ''));
      return !withoutThisStep(rawText).includes(withoutThisStep(rawKeyword));
    })
    .map((step) => step.label);
  return { found: true, exact: false, reasons };
}

/** 检测台关键词明细面板：把产品自己词库里适用于这个素材比例的每个词都判一遍
 *  三态（命中/规则命中/缺失），红色缺词排最前面，方便优先看问题。 */
function matchedKeywordDetail(text, product, materialRatio) {
  return (product.keywords || [])
    .filter((kw) => keywordApplies(kw, materialRatio))
    .map((kw) => {
      const { found, exact, reasons } = classifyKeywordMatch(text, keywordText(kw));
      return {
        text: keywordText(kw),
        category: keywordCategory(kw),
        status: !found ? 'missing' : exact ? 'exact' : 'fuzzy',
        reasons
      };
    })
    .sort((a, b) => {
      const order = { missing: 0, fuzzy: 1, exact: 2 };
      return order[a.status] - order[b.status];
    });
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

/** 同上，取适用比例；不是合法值（或没给，包括这次改造之前建的老词）一律归到 'both'——
 *  宁可两边都校验，也不要因为迁移期间的空值让某个比例悄悄漏检。 */
function keywordRatio(k) {
  const r = k && typeof k === 'object' ? k.ratio : null;
  return RATIOS.includes(r) ? r : 'both';
}

/** 这个词是否要求出现在 materialRatio 这个比例的素材里。materialRatio 没传
 *  （比如老代码路径/单测没有比例上下文）就当作不做比例过滤，一律要求——
 *  保持这个函数加入之前的全部行为不变。 */
function keywordApplies(k, materialRatio) {
  if (!materialRatio) return true;
  const r = keywordRatio(k);
  return r === 'both' || r === materialRatio;
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
 *
 * 实测天猫这批素材的"到手价"版式，￥ 符号经常被排版/OCR 识别顺序甩到离价格数字
 * 好几行开外（比如"预估补贴到手价\n支付补贴省15%\n行业63+年深耕\n16328\n★★★★★\n￥"），
 * 早就超出上面几条"隔几个字符"的容忍范围，导致真实价格反而提取不到。这种版式下
 * 更可靠的锚点是"到手价"这个标签本身：它后面（不超过几行内）紧跟着的第一个纯数字
 * 独立行基本就是价格，不用等 ￥ 符号靠近。
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

  const lines = s.split('\n');
  lines.forEach((line, i) => {
    if (!/到手价/.test(line)) return;
    for (let j = i + 1; j <= i + 5 && j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (/^[\d,]{2,7}$/.test(t)) {
        const n = Number(t.replace(/,/g, ''));
        if (Number.isFinite(n) && n > 0) nums.add(n);
        break;
      }
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

// "多出的词"（跨产品串词）判定要求这个词得有"认得出是哪个产品"的辨识力——像品牌
// logo、"瑞士制造"这种到处都有的通用文案，本身就不该被当成串词信号。阈值按实测
// 词库分布定：真正跨产品共享的通用文案（IQAir/Swiss Made/满赠文案等）多是 7~23 个
// 产品共有，个别产品自己专属的词最多也就在 1~2 个产品间意外重复，3 是能把两者分开
// 的最小阈值。
const CROSS_CHECK_COMMON_THRESHOLD = 3;

/** 在 allProducts 范围内，统计每个关键词（归一化后）分别在多少个不同产品自己的
 *  词库里出现过；达到阈值就说明这个词没有辨识力，不该拿来做"多出的词"跨产品判定
 *  ——不影响它本身"缺不缺词"的校验，只影响是否被当成串词信号。 */
function commonKeywordTexts(allProducts, threshold) {
  const counts = new Map();
  (allProducts || []).forEach((p) => {
    const seenInThisProduct = new Set();
    (p.keywords || []).forEach((kw) => {
      const n = normalize(keywordText(kw));
      if (!n || seenInThisProduct.has(n)) return;
      seenInThisProduct.add(n);
      counts.set(n, (counts.get(n) || 0) + 1);
    });
  });
  const common = new Set();
  counts.forEach((c, n) => { if (c >= threshold) common.add(n); });
  return common;
}

/**
 * 产品与关键词强绑定：每个产品自己维护一份完整清单，同一个词可以在多个产品里各自
 * 重复出现，互不冲突（不再要求全局唯一）。
 *
 * 缺词 = 本产品自己清单里的词，没能在素材文字里找到。
 * 多出的词 = 素材文字里出现了某个别的产品的词，但这个词不在本产品自己清单里，
 * 且这个词没有被判定为通用词（见 commonKeywordTexts）——如果这个词本产品也有
 * （说明是有意重复录入的共享词），就不算多出的，是正常的自己的词。
 *
 * 价格 = product.price 配置了预期价格时的强校验，跟"多出的词"同级——图里的价格跟
 * 预期对不上（不管是写错了还是压根没出现），都直接算报错，不走缺词那套"提醒"档位。
 *
 * 三态严重程度是固定规则，不做成可配置项：多出的词/价格不对 > 缺词 > 通过。
 */
function matchAgainstProduct(text, product, allProducts, materialRatio) {
  const missingKeywords = (product.keywords || [])
    .filter((kw) => keywordApplies(kw, materialRatio))
    .filter((kw) => findKeywordHits(text, [kw]).length === 0)
    .map((kw) => keywordText(kw));

  // 用归一化后的文字判断"这个词本产品是不是已经有了"，不能只比较原始字符串——
  // 同一句话在不同产品词库里可能就差一个全角/半角符号、一个空格（实测 HP250 XE
  // 写的是半角">"，HP100 XE 曾经写成全角"＞"，字面不相等但语义就是同一句话），
  // 原始字符串比较会让这类"其实是我自己的词"被误判成串出去的词。
  const myKeywordTexts = new Set((product.keywords || []).map((kw) => normalize(keywordText(kw))));
  // OCR 已经命中本产品的完整型号时，其中的品牌/系列短词也会自然出现在文字里。
  // 如果别的产品恰好把该短词单独维护为关键词，不能把同一段完整型号反过来判为串词。
  // 只用“本产品实际命中的词”做覆盖判断，避免未出现在素材里的长词掩盖真正的串词。
  const matchedMyKeywordTexts = (product.keywords || [])
    .filter((kw) => keywordApplies(kw, materialRatio))
    .filter((kw) => findKeywordHits(text, [kw]).length > 0)
    .map((kw) => normalize(keywordText(kw)));
  const commonTexts = commonKeywordTexts(allProducts, CROSS_CHECK_COMMON_THRESHOLD);
  const extraKeywords = [];
  const seen = new Set();
  allProducts.forEach((other) => {
    if (other.id === product.id) return;
    findKeywordHits(text, other.keywords || []).forEach((kw) => {
      const t = keywordText(kw);
      const n = normalize(t);
      const coveredByMatchedOwnKeyword = matchedMyKeywordTexts.some((own) => own.length > n.length && own.includes(n));
      if (myKeywordTexts.has(n) || coveredByMatchedOwnKeyword || seen.has(n) || commonTexts.has(n)) return;
      seen.add(n);
      extraKeywords.push(t);
    });
  });

  const priceIssue = checkPrice(text, product);

  const status = (extraKeywords.length > 0 || priceIssue) ? 'error' : missingKeywords.length > 0 ? 'warn' : 'pass';
  const matchedKeywords = matchedKeywordDetail(text, product, materialRatio);
  return { missingKeywords, extraKeywords, priceIssue, status, matchedKeywords };
}

module.exports = {
  CATEGORIES, PRODUCT_TYPES, RATIOS, CROSS_CHECK_COMMON_THRESHOLD,
  normalize, keywordText, keywordCategory, keywordRatio, keywordApplies, findKeywordHits, resolveByFilename,
  resolveProduct, resolveProductForUpload, crossCheckWarning, matchAgainstProduct, commonKeywordTexts,
  extractPriceCandidates, checkPrice, isPriceLikeLine, buildKeywordCandidates,
  classifyKeywordMatch, matchedKeywordDetail
};
