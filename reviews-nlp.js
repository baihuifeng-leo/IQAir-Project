/**
 * reviews-nlp.js — 评论清洗与「维度 × 极性」抽取
 *
 * 设计取舍（重要）：
 *
 * 1. 不做整条评论的好评/差评二分类。
 *    这批导出没有星级列，且淘宝晒单评论天然一边倒。整条打标签的结果是
 *    「96% 好评」，对竞品分析零信息量。
 *
 * 2. 改做维度级抽取："静音很好，就是滤芯太贵"
 *    → 噪音:正向 + 滤芯成本:负向。一条评论同时贡献优点和缺点，
 *    这才是竞品对比真正需要的东西。
 *
 * 3. 词典用正则而非子串。中文子串匹配会踩这些坑：
 *    · "特别满意" 里的「别」被当成否定词 → 好评判成差评
 *    · "噪音大小整体还可以" 命中「噪音大」
 *    · "如宣传一般扎实" 命中「一般」
 *    · "空气质量差" 被归到「质量做工」，其实说的是室外空气
 *    下面每条规则都带前后界约束，就是为了堵这些。
 */
'use strict';

/* ── 模板评论：淘宝默认好评，零信息量 ─────────────────── */
const TEMPLATES = [
  // normalize() 已把全角逗号转成半角，两种都容错
  /^该用户觉得商品非常好[,，]?给出\d星好评$/,
  /^该用户未填写评价内容$/,
  /^该用户觉得商品还不错$/,
  /^此用户没有填写评价$/,
  /^(系统默认|默认)好评$/
];
const isTemplate = (t) => {
  const s = normalize(t);
  return TEMPLATES.some((re) => re.test(s)) || s.length < 4;
};

/* ── 归一化 ───────────────────────────────────────────── */
function normalize(text) {
  return String(text || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── 维度：正则，带排除 ───────────────────────────────── */
const ASPECTS = {
  净化效果: /除甲醛|甲醛|除醛|PM2\.?5|空气质量|净化|除菌|消毒|过滤|TVOC|粉尘|雾霾/i,
  异味处理: /异味|烟味|油烟|宠物味|装修味|气味|味道/,
  噪音: /噪音|噪声|静音|安静|吵|分贝|dB|睡眠模式|声音/i,
  外观设计: /颜值|外观|好看|漂亮|设计感|造型|简约|高级感|不突兀/,
  体积重量: /体积|尺寸|占地|笨重|轻巧|滚轮|挪动|搬/,
  操作智能: /APP|联网|智能|远程|屏幕|显示|面板|遥控|语音|操作/i,
  滤芯成本: /滤芯|滤网|耗材|性价比|划算|智商税|价格/,
  服务物流: /客服|物流|快递|发货|售后|安装|包装|送货/,
  // 「空气质量」说的是空气不是产品，必须排除
  质量做工: /(?<!空气)质量|做工|用料|堆料|结实|扎实|异响|故障|(?<![不很])坏了/
};

/* ── 极性规则：每条都带边界约束 ───────────────────────── */
const POS_RULES = [
  /很好|不错|挺好|超好|极好/, /满意|超出预期|物有所值|值得|惊喜/, /推荐|回购|再买|第二台/,
  /好评/, /喜欢|爱了|种草/, /给力|强大|杠杠|够猛/, /明显|显著|立竿见影/,
  /清新|清爽|舒服|顺畅|安心|省心/, /静音|安静|几乎(听不到|无声)|悄无声息/,
  /漂亮|好看|高级|颜值(高|在线)/, /方便|简单|省事|好用/, /(?<![不没])划算|性价比(高|不错)/,
  /及时|热情|专业|迅速|(?<![不])快/, /轻巧|轻便/, /干净|灵敏|精准/,
  /(降|降到|归)(0|零)|优秀|出色|完美/
];

const NEG_RULES = [
  /(太|很|有点|有些|比较|略|挺)吵/, /噪音(大|明显|扰)(?!小)/, /声音(大|吵)(?!小)/,
  /(太|好|很|有点|略)贵|贵得(离谱|吓人)|不划算|智商税/,
  /(?<![如像跟和与])一般(?![扎般])(?!$)|凑合|鸡肋/,
  /失望|后悔|不推荐|差评|退货|退款|投诉|骗|假货/,
  /(?<![不])坏了|故障|异响|松动|掉漆|漏风|卡顿|断连/,
  /没(有)?(什么)?(效果|变化|用)|效果(不明显|一般|差)|不管用/,
  /笨重|太重|占地方|太大了/,
  /(客服|售后|物流|快递)(态度)?(差|慢|不理|敷衍)/,
  /刺鼻|塑料味|异味大/,
  /(?<![空气])质量(差|不行|堪忧)/,
  /难用|复杂|麻烦|不好用/
];

/* ── 否定词：必须紧邻，且排除「特别/识别/无线/未来」等 ── */
const NEGATOR = /(?<![特识分差个类性])别|不(?!错|少|突兀)|没(?![什么]*(问题|噪音))|无(?!线|声|噪)|未(?!来)|毫无|并非|算不上|谈不上/;

/* ── 转折词：其后的负面更可信 ─────────────────────────── */
const ADVERSATIVE = /但是?|不过|就是|可惜|唯一|缺点|美中不足|要说|如果.{0,6}就(更)?好/;

/* ── 三道语境守卫 ─────────────────────────────────────── */

// 1. 传闻引用："据说是智商税""一直害怕是智商税" —— 说的是别人的看法，不是自己的差评
const HEARSAY = /据说|听说|都说|很多.{0,3}说|说是|传说|(害)?怕是?智商税|担心是|以为是|觉得是|刻板印象|网上说|之前(觉得|买过)|原先|买之前|以前觉得|犹豫/;

// 2. 问题已解决："刺鼻味道基本没了""异味变小了" —— 负面词出现在被消除的对象上
const RESOLVED = /(没|无|少|淡|轻)了|变(小|淡|轻|少)|消失|散(了|去)|解决|改善|好多了|降下来|不再|再也没|确实少/;

// 3. 主语不是产品："家里电梯坏了""北方冬天不方便开窗""打破笨重大件的刻板印象"
const NOT_PRODUCT = /电梯|楼道|室外|外面|北方|南方|冬天|夏天|雾霾天|马路|窗外|邻居|工地/;

// 「不仅/不但」是递进不是否定
const FAKE_NEGATOR = /不仅|不但|不光|无论|不管|没准|不知|不愧|不亏|不简单|别人|别的|别提/;

const splitClauses = (text) =>
  normalize(text).split(/[，,。.！!？?；;、\n]+/).map((s) => s.trim()).filter((s) => s.length >= 2);

/**
 * 在整句上定位所有否定词的位置。
 * 必须在整句上跑正则 —— 先 slice 再匹配会切掉 lookbehind 的左侧上下文，
 * 于是「特别」里的「别」又被当成否定词（踩过一次）。
 */
function negatorPositions(clause) {
  const re = new RegExp(NEGATOR.source, 'g');
  const out = [];
  let m;
  while ((m = re.exec(clause))) {
    // 「不仅/不但/不光」是递进，不是否定
    if (FAKE_NEGATOR.test(clause.slice(m.index, m.index + 2))) continue;
    out.push(m.index + m[0].length); // 否定词的结束位置
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

/** 词命中处之前 4 字内若有否定词结束 → 极性翻转 */
const negatedAt = (negPos, index) => negPos.some((e) => e <= index && index - e <= 4);

function clausePolarity(clause) {
  let score = 0;
  const terms = [];
  const negPos = negatorPositions(clause);

  const scan = (rules, sign) => {
    for (const re of rules) {
      const m = re.exec(clause);
      if (!m) continue;
      const flipped = negatedAt(negPos, m.index);
      const s = flipped ? -sign : sign;
      score += s;
      // 「不推荐」要显示成「不推荐」，不能只记「推荐」，否则词云里会出现好词当差评。
      // 「很好」取反读作「不好」而不是「不很好」，先剥掉程度副词。
      terms.push({ term: flipped ? '不' + m[0].replace(/^(很|挺|超|极|非常|特别)/, '') : m[0], polarity: s, negated: flipped });
    }
  };
  scan(POS_RULES, 1);
  scan(NEG_RULES, -1);
  return { score, terms };
}

const matchAspects = (clause) =>
  Object.entries(ASPECTS).filter(([, re]) => re.test(clause)).map(([a]) => a);

/**
 * 抽取一条评论里所有的 (维度, 极性, 触发词, 上下文原文)。
 * 一条评论可以同时产出正向和负向 —— 这正是我们要的。
 */
function extract(text) {
  if (isTemplate(text)) return [];
  const clauses = splitClauses(text);
  const out = [];
  let afterTurn = false;

  for (const clause of clauses) {
    if (ADVERSATIVE.test(clause)) afterTurn = true;

    const aspects = matchAspects(clause);
    if (!aspects.length) continue;

    let { score, terms } = clausePolarity(clause);
    if (score === 0) continue;

    // 守卫：负面词若出现在传闻、已解决、或非产品主语的语境里，不算这个品牌的差评
    if (score < 0) {
      if (HEARSAY.test(clause)) continue;
      if (RESOLVED.test(clause)) continue;
      if (NOT_PRODUCT.test(clause)) continue;
    }

    const polarity = score > 0 ? 'pos' : 'neg';
    const wanted = terms.filter((t) => (score > 0 ? t.polarity > 0 : t.polarity < 0));

    for (const aspect of aspects) {
      out.push({
        aspect,
        polarity,
        weight: afterTurn && polarity === 'neg' ? 1.5 : 1,
        terms: wanted.map((t) => t.term),
        context: clause
      });
    }
  }
  return out;
}

module.exports = { normalize, isTemplate, splitClauses, extract, matchAspects, ASPECTS };
