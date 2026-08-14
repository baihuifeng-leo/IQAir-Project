const assert = require('assert');
const { runOcr, checkAvailable, PaddleOcrWorker } = require('./materialcheck-ocr.js');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const vm = require('vm');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '-', e.message); }
};
const tAsync = async (name, fn) => {
  try { await fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '-', e.message); }
};

/** 前端批量审核的分组函数没有独立模块；这个最小 VM 只取出真实源码里的
 * autobuildGroups，不启动页面或请求接口，用来锁定“逐素材改产品后必须重新分组”的行为。 */
function frontendAutobuildGroups(entries, reviewState) {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'materialcheck.js'), 'utf8')
    .replace('return { init };', 'return { autobuildGroups };');
  const context = { console, window: {}, document: {}, setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn() };
  vm.runInNewContext(source + '\nthis.__materialcheck = MaterialCheck;', context, { filename: 'public/materialcheck.js' });
  return context.__materialcheck.autobuildGroups(entries, reviewState);
}

function frontendDetectProgressState(rows) {
  const source = fs.readFileSync(path.join(__dirname, 'public', 'materialcheck.js'), 'utf8')
    .replace('return { init };', 'return { detectProgressState, createQueuedProgressWarmup };');
  const context = { console, window: {}, document: {}, setTimeout, clearTimeout, requestAnimationFrame: (fn) => fn() };
  vm.runInNewContext(source + '\nthis.__materialcheck = MaterialCheck;', context, { filename: 'public/materialcheck.js' });
  const frontend = context.__materialcheck;
  return rows ? frontend.detectProgressState(rows) : frontend;
}

// 伪造一个 child_process 长得像的对象：stdout/stdin/exit 都能模拟，
// 用来测试 PaddleOcrWorker 的 stdin/stdout 按行 JSON 协议，不需要真的起进程。
function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdout.setEncoding = () => {};
  proc.written = [];
  proc.stdin = { write: (chunk) => proc.written.push(chunk) };
  return proc;
}

async function run() {
  // ── materialcheck-ocr.js：PaddleOcrWorker 的 stdin/stdout 协议 ──────────
  await tAsync('PaddleOcrWorker 收到 ready 信号后 start() 才 resolve', async () => {
    const proc = makeFakeProc();
    const worker = new PaddleOcrWorker({ spawnFn: () => proc });
    const startPromise = worker.start();
    proc.stdout.emit('data', '{"ready": true}\n');
    await startPromise;
  });

  await tAsync('PaddleOcrWorker.recognize 发送带 id 的请求，按 id 匹配响应', async () => {
    const proc = makeFakeProc();
    const worker = new PaddleOcrWorker({ spawnFn: () => proc });
    const startPromise = worker.start();
    proc.stdout.emit('data', '{"ready": true}\n');
    await startPromise;

    const recognizePromise = worker.recognize('/tmp/x.jpg');
    await Promise.resolve();
    const sent = JSON.parse(proc.written[0]);
    assert.strictEqual(sent.path, '/tmp/x.jpg');
    proc.stdout.emit('data', JSON.stringify({ id: sent.id, ok: true, lines: [{ text: 'A', score: 0.9 }] }) + '\n');
    const lines = await recognizePromise;
    assert.deepStrictEqual(lines, [{ text: 'A', score: 0.9 }]);
  });

  await tAsync('PaddleOcrWorker 能处理跨多个 data 事件拆开的一行 JSON', async () => {
    const proc = makeFakeProc();
    const worker = new PaddleOcrWorker({ spawnFn: () => proc });
    const startPromise = worker.start();
    proc.stdout.emit('data', '{"read');
    proc.stdout.emit('data', 'y": true}\n');
    await startPromise;

    const recognizePromise = worker.recognize('/tmp/x.jpg');
    await Promise.resolve();
    const sent = JSON.parse(proc.written[0]);
    const full = JSON.stringify({ id: sent.id, ok: true, lines: [] });
    proc.stdout.emit('data', full.slice(0, 5));
    proc.stdout.emit('data', full.slice(5) + '\n');
    await recognizePromise;
  });

  await tAsync('PaddleOcrWorker 识别失败时 reject 出有意义的错误', async () => {
    const proc = makeFakeProc();
    const worker = new PaddleOcrWorker({ spawnFn: () => proc });
    const startPromise = worker.start();
    proc.stdout.emit('data', '{"ready": true}\n');
    await startPromise;

    const recognizePromise = worker.recognize('/tmp/bad.jpg');
    await Promise.resolve();
    const sent = JSON.parse(proc.written[0]);
    proc.stdout.emit('data', JSON.stringify({ id: sent.id, ok: false, error: '图片打不开' }) + '\n');
    await assert.rejects(recognizePromise, /OCR 识别失败.*图片打不开/);
  });

  await tAsync('PaddleOcrWorker 子进程意外退出时，所有排队中的请求都 reject', async () => {
    const proc = makeFakeProc();
    const worker = new PaddleOcrWorker({ spawnFn: () => proc });
    const startPromise = worker.start();
    proc.stdout.emit('data', '{"ready": true}\n');
    await startPromise;

    const recognizePromise = worker.recognize('/tmp/x.jpg');
    await Promise.resolve();
    proc.emit('exit', 1);
    await assert.rejects(recognizePromise, /PaddleOCR 子进程退出了/);
  });

  // ── materialcheck-ocr.js：runOcr 的置信度过滤逻辑 ──────────
  await tAsync('runOcr 丢弃低置信度的行，返回剩余行的平均置信度', async () => {
    const stubWorker = { recognize: async () => [
      { text: '真实文案A', score: 0.95 },
      { text: '图标噪声', score: 0.2 },
      { text: '真实文案B', score: 0.85 }
    ] };
    const { text, confidence } = await runOcr('/tmp/x.jpg', { worker: stubWorker });
    assert.strictEqual(text, '真实文案A\n真实文案B');
    assert.ok(Math.abs(confidence - 0.9) < 1e-9);
  });

  await tAsync('runOcr 保留高置信度文字框，供版面级关键词匹配使用', async () => {
    const stubWorker = { recognize: async () => [
      { text: '预估补贴', score: 0.95, box: [10, 20, 110, 60] },
      { text: '噪声', score: 0.2, box: [1, 1, 2, 2] }
    ] };
    const { lines } = await runOcr('/tmp/x.jpg', { worker: stubWorker });
    assert.deepStrictEqual(lines, [{ text: '预估补贴', score: 0.95, box: [10, 20, 110, 60] }]);
  });

  await tAsync('runOcr 全部行都低置信度时返回空文字和 0 置信度', async () => {
    const stubWorker = { recognize: async () => [{ text: '噪声', score: 0.1 }] };
    const { text, confidence } = await runOcr('/tmp/x.jpg', { worker: stubWorker });
    assert.strictEqual(text, '');
    assert.strictEqual(confidence, 0);
  });

  await tAsync('runOcr 识别失败时把错误原样抛出', async () => {
    const stubWorker = { recognize: async () => { throw new Error('OCR 识别失败：模型没加载好'); } };
    await assert.rejects(runOcr('/tmp/bad.jpg', { worker: stubWorker }), /模型没加载好/);
  });

  await tAsync('checkAvailable worker 启动成功时返回 true', async () => {
    const stubWorker = { start: async () => {} };
    assert.strictEqual(await checkAvailable({ worker: stubWorker }), true);
  });

  await tAsync('checkAvailable worker 启动失败时返回 false（不抛出）', async () => {
    const stubWorker = { start: async () => { throw new Error('spawn ENOENT'); } };
    assert.strictEqual(await checkAvailable({ worker: stubWorker }), false);
  });

  // ── materialcheck-match.js ────────────────────────────
  const M = require('./materialcheck-match.js');

  const productA = { id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi', '抗菌滤网认证号XXX'] };
  const productB = { id: 'pb', name: 'GCX XE', keywords: ['GCX XE', '静音悬浮马达'] };
  const products = [productA, productB];

  t('findKeywordHits 找出命中的关键词，忽略空白', () => {
    const hits = M.findKeywordHits('这款 GC-Multi 带 抗菌滤网认证号XXX 效果好', ['GC-Multi', '抗菌滤网认证号XXX', 'GCX XE']);
    assert.deepStrictEqual(hits, ['GC-Multi', '抗菌滤网认证号XXX']);
  });

  t('findKeywordHits 忽略文本中的换行空格', () => {
    const hits = M.findKeywordHits('这款 GC\n-Multi 不错', ['GC-Multi']);
    assert.deepStrictEqual(hits, ['GC-Multi']);
  });

  t('resolveByFilename 文件名唯一命中一个产品', () => {
    const p = M.resolveByFilename('GC-Multi_主图_v2.jpg', products);
    assert.strictEqual(p.id, 'pa');
  });

  t('resolveByFilename 文件名没有命中返回 null', () => {
    assert.strictEqual(M.resolveByFilename('random_image_01.jpg', products), null);
  });

  t('resolveProduct 按关键词命中数最多的产品判定', () => {
    const r = M.resolveProduct('这款 GC-Multi 带 抗菌滤网认证号XXX', products);
    assert.strictEqual(r.resolved.id, 'pa');
    assert.strictEqual(r.ambiguous, false);
  });

  t('resolveProduct OCR 出现完整产品型号时优先型号，避免被其它产品的通用词淹没', () => {
    const target = { id: 'target', name: 'HyperHEPA CF 滤芯', keywords: ['HyperHEPA CF 滤芯', 'ColdFire甲醛分解技术'] };
    const polluted = { id: 'polluted', name: 'Atem Car', keywords: ['IQAir', '瑞士设计', '德国制造', '咨询享管家服务', '官方正品品质保证'] };
    const r = M.resolveProduct('IQAir 瑞士设计 德国制造 咨询享管家服务 官方正品品质保证 HyperHEPA CF 滤芯 ColdFire甲醛分解技术', [target, polluted]);
    assert.strictEqual(r.resolved.id, 'target');
  });

  t('resolveProduct 零命中时不确定', () => {
    const r = M.resolveProduct('完全不相关的文字', products);
    assert.strictEqual(r.resolved, null);
    assert.strictEqual(r.ambiguous, false);
  });

  t('resolveProduct 命中数并列时判定为歧义', () => {
    const r = M.resolveProduct('GC-Multi 和 GCX XE 都出现了', products);
    assert.strictEqual(r.resolved, null);
    assert.strictEqual(r.ambiguous, true);
    assert.strictEqual(r.candidates.length, 2);
  });

  t('resolveProductForUpload 文件名只是候选，OCR 明确指向另一产品时覆盖文件名', () => {
    const r = M.resolveProductForUpload('GC-Multi_主图.jpg', 'GCX XE 静音悬浮马达', products);
    assert.strictEqual(r.method, 'ocr_override_filename');
    assert.strictEqual(r.product.id, 'pb');
    assert.match(r.warning, /已按 OCR 判定/);
  });

  t('resolveProductForUpload OCR 不明确时仍以文件名候选兜底', () => {
    const r = M.resolveProductForUpload('GC-Multi_主图.jpg', '无关文字', products);
    assert.strictEqual(r.method, 'filename');
    assert.strictEqual(r.product.id, 'pa');
  });

  t('resolveProductForUpload Atem Car 机器名文件名不能覆盖滤芯 OCR 的明确归属', () => {
    const machine = { id: 'machine', name: 'Atem Car', keywords: ['Atem Car', '车载机器'] };
    const filter = { id: 'filter', name: 'Atem Car 滤芯', keywords: ['Atem Car 滤芯', '除甲醛、苯、颗粒物等', '适用机型：Atem Car'] };
    const r = M.resolveProductForUpload('Atem Car 800.jpg', 'Atem Car 滤芯\n除甲醛、苯、颗粒物等\n适用机型：Atem Car', [machine, filter]);
    assert.strictEqual(r.method, 'ocr_override_filename');
    assert.strictEqual(r.product.id, 'filter');
  });

  t('resolveProductForUpload 文件名不确定时退到 OCR 反查', () => {
    const r = M.resolveProductForUpload('IMG_0001.jpg', 'GCX XE 静音悬浮马达', products);
    assert.strictEqual(r.method, 'ocr');
    assert.strictEqual(r.product.id, 'pb');
  });

  t('resolveProductForUpload 两级都无法判定时标记待人工选择', () => {
    const r = M.resolveProductForUpload('IMG_0001.jpg', '无关文字', products);
    assert.strictEqual(r.method, null);
    assert.strictEqual(r.product, null);
    assert.strictEqual(r.ambiguous, true);
  });

  t('crossCheckWarning 文件名判定和 OCR 倾向一致时无提示', () => {
    const w = M.crossCheckWarning(productA, 'GC-Multi 抗菌滤网认证号XXX', products);
    assert.strictEqual(w, null);
  });

  t('crossCheckWarning OCR 明显倾向另一个产品时给出提示', () => {
    const w = M.crossCheckWarning(productA, 'GCX XE 静音悬浮马达', products);
    assert.ok(w && w.includes('GCX XE'));
  });

  t('matchAgainstProduct 全部命中且无多出的词时通过', () => {
    const r = M.matchAgainstProduct('GC-Multi 抗菌滤网认证号XXX', productA, products);
    assert.deepStrictEqual(r.missingKeywords, []);
    assert.deepStrictEqual(r.extraKeywords, []);
    assert.strictEqual(r.status, 'pass');
  });

  t('matchAgainstProduct 未入库 OCR 词只提示、不影响通过，并且已知串词不重复列入', () => {
    const r = M.matchAgainstProduct('GC-Multi 抗菌滤网认证号XXX\nSF', productA, products);
    assert.deepStrictEqual(r.extraKeywords, []);
    assert.deepStrictEqual(r.unregisteredKeywords, ['SF']);
    assert.strictEqual(r.status, 'pass');

    const withCrossedProduct = M.matchAgainstProduct('GC-Multi 抗菌滤网认证号XXX\nGCX XE', productA, products);
    assert.deepStrictEqual(withCrossedProduct.extraKeywords, ['GCX XE']);
    assert.deepStrictEqual(withCrossedProduct.unregisteredKeywords, []);
  });

  t('matchAgainstProduct 未入库词会排除已登记长词的片段及只用版式符号拼接的已登记词', () => {
    const hp = {
      id: 'hp',
      name: 'HP',
      keywords: ['热销70+国家和地区', '百万级净化量*', '真H13级滤芯']
    };
    const r = M.matchAgainstProduct('热销70+国家和地区\n70+\n百万级净化量*|真H13级滤芯\nSF', hp, [hp]);
    assert.deepStrictEqual(r.unregisteredKeywords, ['SF']);
  });

  t('matchAgainstProduct 缺词判定为提醒状态', () => {
    const r = M.matchAgainstProduct('GC-Multi', productA, products);
    assert.deepStrictEqual(r.missingKeywords, ['抗菌滤网认证号XXX']);
    assert.strictEqual(r.status, 'warn');
  });

  t('matchAgainstProduct 单字写错应归为错词而不是缺词，并保留错误字位置', () => {
    const p = { id: 'coldfire', name: 'GCX MG ColdFire', keywords: ['GCX MG ColdFire 过滤筒'] };
    const r = M.matchAgainstProduct('GCX MG ColdFire 过滤桶', p, [p]);
    assert.deepStrictEqual(r.missingKeywords, []);
    assert.deepStrictEqual(r.wrongKeywords, [{
      expected: 'GCX MG ColdFire 过滤筒', actual: 'GCXMGColdFire过滤桶',
      differences: [{ expectedIndex: 15, actualIndex: 15, expected: '筒', actual: '桶', type: 'replace' }]
    }]);
    assert.strictEqual(r.matchedKeywords[0].status, 'wrong');
    assert.strictEqual(r.status, 'warn');
  });

  t('matchAgainstProduct 词库词被未配置前后缀包住时应提示前后缀不一致，而不是精确命中', () => {
    const p = { id: 'hyper', name: 'HyperHEPA CF 滤芯', keywords: [{ text: 'Premax滤芯或H11滤芯', category: '附加权益' }] };
    const r = M.matchAgainstProduct('赠Premax滤芯或H11滤芯', p, [p]);
    assert.deepStrictEqual(r.missingKeywords, []);
    assert.deepStrictEqual(r.expandedKeywords, [{
      expected: 'Premax滤芯或H11滤芯', actual: '赠Premax滤芯或H11滤芯', prefix: '赠', suffix: ''
    }]);
    assert.strictEqual(r.matchedKeywords[0].status, 'expanded');
    assert.strictEqual(r.status, 'warn');
  });

  t('matchAgainstProduct 同行由其它已配置关键词覆盖的组合文案不应误报前后缀不一致', () => {
    const p = { id: 'promo', name: '促销产品', keywords: [{ text: '3期免息', category: '日常销售利益点' }, { text: '晒单送10元现金红包', category: '日常销售利益点' }] };
    const r = M.matchAgainstProduct('3期免息|晒单送10元现金红包', p, [p]);
    assert.deepStrictEqual(r.expandedKeywords, []);
    assert.strictEqual(r.status, 'pass');
  });

  t('classifyKeywordMatch 逐字命中标记为 exact，理由列表为空', () => {
    const r = M.classifyKeywordMatch('CCM颗粒物>1,000,000 mg', 'CCM颗粒物>1,000,000 mg');
    assert.deepStrictEqual(r, { found: true, exact: true, reasons: [] });
  });

  t('classifyKeywordMatch 靠归一化规则命中标记为非 exact，理由能反推出具体是哪几条规则起了作用', () => {
    // 全角＞ + 空格，命中靠"比较符号忽略"和"空白/换行忽略"两条规则
    const r = M.classifyKeywordMatch('CCM颗粒物＞1,000,000 mg', 'CCM颗粒物>1,000,000mg');
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.exact, false);
    assert.ok(r.reasons.includes('比较符号（<>＜＞）忽略'));
    assert.ok(r.reasons.includes('空白/换行忽略'));
  });

  t('classifyKeywordMatch 全角￥词库对半角¥ OCR 文字，理由里能看到是￥/¥归一化起的作用', () => {
    const r = M.classifyKeywordMatch('¥399', '￥399');
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.exact, false);
    assert.deepStrictEqual(r.reasons, ['￥/¥ 全角半角统一']);
  });

  t('classifyKeywordMatch 两种归一化都命中不了时判定为缺失，理由列表为空', () => {
    const r = M.classifyKeywordMatch('完全不相关的文字', '缺失的词');
    assert.deepStrictEqual(r, { found: false, exact: false, reasons: [] });
  });

  t('matchedKeywordDetail 按产品自己适用于该比例的词库逐一判三态，缺失排最前面', () => {
    const p = { id: 'mkd1', name: 'MKD', keywords: [
      { text: '缺失的词', category: '产品型号' },
      { text: 'CCM颗粒物>1,000,000mg', category: '产品利益点' }, // 靠归一化命中
      { text: '逐字命中的词', category: '其它' }
    ] };
    const detail = M.matchedKeywordDetail('逐字命中的词 CCM颗粒物＞1,000,000mg', p, null);
    assert.deepStrictEqual(detail.map((d) => d.status), ['missing', 'fuzzy', 'exact']);
    assert.strictEqual(detail[0].text, '缺失的词');
    assert.ok(detail[1].reasons.length > 0);
    assert.deepStrictEqual(detail[2].reasons, []);
  });

  t('matchedKeywordDetail 按素材比例过滤，不适用于当前比例的词不出现在明细里', () => {
    const p = { id: 'mkd2', name: 'MKD2', keywords: [
      { text: '仅3:4的词', category: '其它', ratio: '3:4' },
      { text: '通用词', category: '其它' }
    ] };
    const detail = M.matchedKeywordDetail('通用词', p, '1:1');
    assert.deepStrictEqual(detail.map((d) => d.text), ['通用词']);
  });

  t('matchAgainstProduct 返回结果里带上 matchedKeywords 明细，跟 missingKeywords 判定一致', () => {
    const r = M.matchAgainstProduct('GC-Multi', productA, products);
    const statuses = new Map(r.matchedKeywords.map((d) => [d.text, d.status]));
    assert.strictEqual(statuses.get('GC-Multi'), 'exact');
    assert.strictEqual(statuses.get('抗菌滤网认证号XXX'), 'missing');
  });

  t('matchAgainstProduct 出现别的产品的词时判定为多出的词、报错状态', () => {
    const r = M.matchAgainstProduct('GC-Multi 抗菌滤网认证号XXX GCX XE', productA, products);
    assert.deepStrictEqual(r.missingKeywords, []);
    assert.deepStrictEqual(r.extraKeywords, ['GCX XE']);
    assert.strictEqual(r.status, 'error');
  });

  t('matchAgainstProduct 既有多出的词又有缺词时，报错优先，但详情仍分别列出', () => {
    const r = M.matchAgainstProduct('GCX XE', productA, products);
    assert.deepStrictEqual(r.missingKeywords, ['GC-Multi', '抗菌滤网认证号XXX']);
    assert.deepStrictEqual(r.extraKeywords, ['GCX XE']);
    assert.strictEqual(r.status, 'error');
  });

  t('matchAgainstProduct 产品与关键词强绑定：两个产品都重复录入同一个词，这个词对谁都不算多出的', () => {
    const shared1 = { id: 'ps1', name: '共享词产品A', keywords: ['专属词A', '分期免息'] };
    const shared2 = { id: 'ps2', name: '共享词产品B', keywords: ['专属词B', '分期免息'] };
    const r = M.matchAgainstProduct('专属词A 分期免息', shared1, [shared1, shared2]);
    assert.deepStrictEqual(r.missingKeywords, []);
    assert.deepStrictEqual(r.extraKeywords, []);
    assert.strictEqual(r.status, 'pass');
  });

  t('matchAgainstProduct 多个别的产品都有同一个多出的词时只报一次，不重复', () => {
    const target = { id: 'pt', name: '目标产品', keywords: ['目标专属词'] };
    const other1 = { id: 'po1', name: '别的产品1', keywords: ['共同串出的词'] };
    const other2 = { id: 'po2', name: '别的产品2', keywords: ['共同串出的词'] };
    const r = M.matchAgainstProduct('目标专属词 共同串出的词', target, [target, other1, other2]);
    assert.deepStrictEqual(r.extraKeywords, ['共同串出的词']);
  });

  t('commonKeywordTexts 词在达到阈值个数的产品里各自登记过才算通用词', () => {
    const mk = (id, kws) => ({ id, name: id, keywords: kws });
    const products5 = [mk('a', ['logo']), mk('b', ['logo']), mk('c', ['logo']), mk('d', ['独有词']), mk('e', [])];
    const common = M.commonKeywordTexts(products5, 3);
    assert.strictEqual(common.has('logo'), true); // 3 个产品都有，达阈值
    assert.strictEqual(common.has('独有词'), false); // 只有 1 个产品有，没到阈值
  });

  t('matchAgainstProduct 品牌logo这类几乎每个产品都注册过的词，不该被当成"串错产品"的信号', () => {
    // 复刻真实场景：IQAir 在很多滤芯/配件产品词库里都注册了（logo文字，哪张图都有），
    // 但目标产品（一台整机）自己词库里没有 IQAir——这个词本身没有辨识力，即便在
    // 目标产品的素材图里识别到了，也不该被判定为"混进了别的产品的内容"。
    const target = { id: 'pt', name: 'Atem Car', keywords: ['Atem Car'] };
    const f1 = { id: 'f1', name: '滤芯A', keywords: ['IQAir'] };
    const f2 = { id: 'f2', name: '滤芯B', keywords: ['IQAir'] };
    const f3 = { id: 'f3', name: '滤芯C', keywords: ['IQAir'] };
    const r = M.matchAgainstProduct('IQAir Atem Car', target, [target, f1, f2, f3]);
    assert.deepStrictEqual(r.extraKeywords, []);
    assert.strictEqual(r.status, 'pass');
  });

  t('matchAgainstProduct 自己已有的词跟串出来的词只是全角/半角或空格不同，也算已覆盖，不算多出的词', () => {
    // 复刻真实场景：HP250 XE 写的是半角">"，HP100 XE 曾经写成全角"＞"，两个产品
    // 数量都没到通用词阈值，原始字符串比较会误判——归一化后比较才对
    const hp250 = { id: 'p1', name: 'HP250 XE', keywords: ['CCM颗粒物>1,000,000 mg'] };
    const hp100 = { id: 'p2', name: 'HP100 XE', keywords: ['CCM颗粒物＞1,000,000 mg'] };
    const r = M.matchAgainstProduct('CCM颗粒物>1,000,000 mg', hp250, [hp250, hp100]);
    assert.deepStrictEqual(r.extraKeywords, []);
    assert.strictEqual(r.status, 'pass');
  });

  t('matchAgainstProduct 本产品完整型号覆盖别的产品短词时，不把型号前缀误报为串词', () => {
    // 复刻 HP 250 XE 实测：OCR 已精确识别“HealthPro 250 XE”，但滤芯词库中的
    // “HealthPro”短词不该被当成混入了别的产品文案。
    const hp250 = { id: 'hp250', name: 'HP250 XE', keywords: ['HealthPro 250 XE'] };
    const filter = { id: 'filter', name: 'HP250 滤芯套装', keywords: ['HealthPro'] };
    const r = M.matchAgainstProduct('HealthPro 250 XE', hp250, [hp250, filter]);
    assert.deepStrictEqual(r.extraKeywords, []);
    assert.strictEqual(r.status, 'pass');
  });

  t('matchAgainstProduct 通用词豁免不影响真正的低频串词检测（还没到阈值的照样要报）', () => {
    const target = { id: 'pt', name: '目标产品', keywords: ['目标专属词'] };
    const other1 = { id: 'po1', name: '别的产品1', keywords: ['别人的词'] };
    const other2 = { id: 'po2', name: '别的产品2', keywords: ['别人的词'] };
    // 只有 2 个产品登记了"别人的词"，没到 3 个的阈值，依旧要判定为多出的词
    const r = M.matchAgainstProduct('目标专属词 别人的词', target, [target, other1, other2]);
    assert.deepStrictEqual(r.extraKeywords, ['别人的词']);
    assert.strictEqual(r.status, 'error');
  });

  t('normalize 把上标数字折成普通数字、去掉比较符号（含全角＜＞），OCR对这两类小符号本来就不可靠', () => {
    assert.strictEqual(M.normalize('快速净化3m³整车空间*'), '快速净化3m3整车空间*');
    assert.strictEqual(M.normalize('CCM颗粒物>1,000,000 mg'), 'CCM颗粒物1,000,000mg');
    assert.strictEqual(M.normalize('CCM颗粒物＞1,000,000 mg'), 'CCM颗粒物1,000,000mg'); // 全角变体，词库里实际出现过
    assert.strictEqual(M.normalize('CCM颗粒物 1,000,000 mg'), 'CCM颗粒物1,000,000mg');
  });

  t('normalize 把全角￥折成半角¥——PP-OCRv4/v6两个模型档位对这个符号的识别宽度不一样', () => {
    // 实测：v4-mobile 稳定吐全角￥399，v6-medium 稳定吐半角¥399，词库里登记的是全角
    assert.strictEqual(M.normalize('￥399'), M.normalize('¥399'));
    assert.strictEqual(M.normalize('￥399'), '¥399');
  });

  t('findKeywordHits 全角￥词库对上半角¥ OCR文字依旧能命中（反之亦然）', () => {
    assert.deepStrictEqual(M.findKeywordHits('¥399', ['￥399']), ['￥399']);
    assert.deepStrictEqual(M.findKeywordHits('￥399', ['¥399']), ['¥399']);
  });

  t('findKeywordHits OCR把上标³识成普通数字3、把">"漏识别时依旧能命中关键词', () => {
    // Atem Car 真实场景：词库写的是"快速净化3m³整车空间*"，OCR 识成"快速净化3m3整车空间*"
    assert.deepStrictEqual(M.findKeywordHits('快速净化3m3整车空间*', ['快速净化3m³整车空间*']), ['快速净化3m³整车空间*']);
    // HP250 XE 真实场景：词库写的是"CCM颗粒物>1,000,000 mg"，OCR 漏识别了 ">"
    assert.deepStrictEqual(M.findKeywordHits('CCM颗粒物1,000,000 mg', ['CCM颗粒物>1,000,000 mg']), ['CCM颗粒物>1,000,000 mg']);
  });

  t('normalize 数字和计量单位之间夹着孤立乱入字母时忽略掉这个字母，不误伤正常紧贴写法', () => {
    // HP250 XE / HP100 XE 1:1 裁图真实场景：">" 在小尺寸下被稳定误识成字母 r，
    // 前后被空格/换行隔开——这种"孤立"形状才处理
    assert.strictEqual(M.normalize('1,000,000 r\nmg'), '1,000,000mg');
    // 安全底线：正常紧贴写法（没有孤立字母）不能被误伤，尤其"mg"自己的"m"不能被当成杂散字母吃掉
    assert.strictEqual(M.normalize('1,000,000 mg'), '1,000,000mg');
    assert.strictEqual(M.normalize('1,000,000mg'), '1,000,000mg');
    assert.strictEqual(M.normalize('CCM颗粒物>1,000,000 mg'), 'CCM颗粒物1,000,000mg');
  });

  t('findKeywordHits 数字和单位之间被乱入字母打断的 OCR 文字依旧能命中关键词', () => {
    // 复刻 HP250 XE 1440.png 真实 OCR：CCM颗粒物\n1,000,000 r\nmg
    const ocrText = 'CCM颗粒物\n1,000,000 r\nmg';
    assert.deepStrictEqual(M.findKeywordHits(ocrText, ['CCM颗粒物>1,000,000 mg']), ['CCM颗粒物>1,000,000 mg']);
  });

  t('keywordText/keywordCategory 兼容纯字符串和 {text,category} 对象；旧版价格分类回退为其它', () => {
    assert.strictEqual(M.keywordText('纯字符串词'), '纯字符串词');
    assert.strictEqual(M.keywordText({ text: '对象词', category: '价格' }), '对象词');
    assert.strictEqual(M.keywordCategory('纯字符串词'), '其它');
    assert.strictEqual(M.keywordCategory({ text: '对象词', category: '价格' }), '其它');
    assert.strictEqual(M.keywordCategory({ text: '脏数据', category: '不存在的分类' }), '其它');
  });

  t('matchAgainstProduct 关键词是 {text,category} 对象时匹配逻辑不受影响', () => {
    const objProduct = { id: 'po', name: 'Obj', keywords: [{ text: 'OBJ-100', category: '产品型号' }, { text: '国补价1999', category: '国补' }] };
    const r = M.matchAgainstProduct('OBJ-100', objProduct, [objProduct]);
    assert.deepStrictEqual(r.missingKeywords, ['国补价1999']);
    assert.strictEqual(r.status, 'warn');
  });

  t('extractPriceCandidates 能识别符号跟数字隔着换行、或数字在符号前面的情况', () => {
    assert.deepStrictEqual(M.extractPriceCandidates('预估活动到手价\n775\n￥'), new Set([775]));
    assert.deepStrictEqual(M.extractPriceCandidates('晒单即享\n￥399'), new Set([399]));
    assert.deepStrictEqual(M.extractPriceCandidates('选购价5880元'), new Set([5880]));
    assert.deepStrictEqual(M.extractPriceCandidates('没有任何价格的文字'), new Set());
  });

  t('extractPriceCandidates "到手价"标签后价格跟￥符号隔了好几行时，靠标签锚点也能抓到', () => {
    // 复刻真实素材版式：￥被排到价格数字后面好几行开外，早就超出符号邻近匹配的范围
    const text = '预估补贴到手价\n支付补贴省15%\n行业63+年深耕\n16328\n★★★★★\n￥\n至高补贴2000元先到先得\n现金红包60元';
    const candidates = M.extractPriceCandidates(text);
    assert.strictEqual(candidates.has(16328), true);
    // 附近无关的"元"结尾数字依旧会被提取（不是bug，checkPrice只要求命中预期价即可）
    assert.strictEqual(candidates.has(2000), true);
    assert.strictEqual(candidates.has(60), true);
  });

  t('extractPriceCandidates "到手价"标签紧跟数字（不隔行）同样能抓到', () => {
    const candidates = M.extractPriceCandidates('晒单即享\n￥248\n香氛盒+电源线\n预估活动到手价\n3300\n咨询客服惊喜好礼');
    assert.strictEqual(candidates.has(3300), true);
  });

  t('checkPrice 到手价被排版拆得很远时，靠标签锚点规则依旧能校验通过', () => {
    const p = { id: 'p1', name: 'GC XE', price: 16328 };
    const text = '预估补贴到手价\n支付补贴省15%\n行业63+年深耕\n16328\n★★★★★\n￥\n现金红包60元';
    assert.strictEqual(M.checkPrice(text, p), null);
  });

  t('matchAgainstProduct 按 OCR 坐标合并同一视觉列的到手价标签，并识别相邻主价格', () => {
    // 复刻 2026-08-03 GCX 国补主图：Paddle 的原始输出顺序会把“入会有礼”插到
    // “预估补贴”和“到手价”中间，28188 又与标签分成不同识别框。
    const p = { id: 'p1', name: 'GCX Series XE', price: 28188, keywords: ['预估补贴到手价'] };
    const lines = [
      { text: '预估补贴', score: 0.99, box: [30, 1200, 180, 1260] },
      { text: '28188', score: 0.99, box: [200, 1200, 520, 1260] },
      { text: '支付补贴省15%', score: 0.99, box: [620, 1200, 1120, 1260] },
      { text: '入会有礼', score: 0.99, box: [1180, 1200, 1400, 1260] },
      { text: '到手价', score: 0.99, box: [30, 1270, 170, 1330] }
    ];
    const text = lines.map((line) => line.text).join('\n');
    const result = M.matchAgainstProduct(text, p, [p], '1:1', lines);
    assert.deepStrictEqual(result.missingKeywords, []);
    assert.strictEqual(result.priceIssue, null);
  });

  t('matchAgainstProduct 旧记录没有坐标时，仅跳过中间已配置文案，不把到手价误判缺词', () => {
    const p = { id: 'p1', name: 'GCX Series XE', price: 28188, keywords: ['预估补贴到手价', '入会有礼'] };
    const result = M.matchAgainstProduct('预估补贴\n入会有礼\n到手价\n28188', p, [p], '1:1');
    assert.deepStrictEqual(result.missingKeywords, []);
    assert.strictEqual(result.priceIssue, null);
    assert.deepStrictEqual(result.matchedKeywords.find((kw) => kw.text === '预估补贴到手价').reasons, ['已配置文案穿插忽略']);
  });

  t('matchAgainstProduct 本产品的完整赠品词已按版面命中时，不把其中的香氛盒误报为串词', () => {
    const car = { id: 'car', name: 'Atem Car', keywords: ['晒单赠 香氛盒+数据线'] };
    const other = { id: 'other', name: '其它产品', keywords: ['香氛盒'] };
    const lines = [
      { text: '晒单赠', score: 0.99, box: [100, 100, 240, 150] },
      { text: '¥248', score: 0.99, box: [500, 100, 620, 150] },
      { text: '香氛盒+数据线', score: 0.99, box: [100, 160, 410, 210] }
    ];
    const result = M.matchAgainstProduct(lines.map((line) => line.text).join('\n'), car, [car, other], '1:1', lines);
    assert.deepStrictEqual(result.missingKeywords, []);
    assert.deepStrictEqual(result.extraKeywords, []);
    assert.strictEqual(result.status, 'pass');
  });

  t('checkPrice 没配置 price 的产品不校验；价格对上/图里没价格/价格对不上分别处理', () => {
    const noPrice = { id: 'p1', name: 'X', price: null };
    assert.strictEqual(M.checkPrice('随便什么文字￥299', noPrice), null);

    const withPrice = { id: 'p2', name: 'Y', price: 399 };
    assert.strictEqual(M.checkPrice('晒单即享￥399', withPrice), null); // 价格对上，没问题

    const missing = M.checkPrice('这张图完全没有价格数字', withPrice);
    assert.deepStrictEqual(missing, { expected: 399, found: [] });

    const wrong = M.checkPrice('促销价￥299', withPrice);
    assert.deepStrictEqual(wrong, { expected: 399, found: [299] });
  });

  t('matchAgainstProduct 价格不对时归为报错状态，跟多出的词同级', () => {
    const p = { id: 'p1', name: '空气净化器', type: 'machine', keywords: ['空气净化器'], price: 399 };
    const rWrong = M.matchAgainstProduct('空气净化器 促销价￥299', p, [p]);
    assert.deepStrictEqual(rWrong.priceIssue, { expected: 399, found: [299] });
    assert.strictEqual(rWrong.status, 'error');

    const rOk = M.matchAgainstProduct('空气净化器 促销价￥399', p, [p]);
    assert.strictEqual(rOk.priceIssue, null);
    assert.strictEqual(rOk.status, 'pass');
  });

  t('detectProgressState 准备阶段结束后以30%为基线，其余进度按完成数填满', () => {
    const active = frontendDetectProgressState([{ state: 'done' }, { state: 'processing' }, { state: 'needsPick' }, { state: 'cancelled' }]);
    assert.ok(Math.abs(active.ratio - 0.65) < 1e-9);
    assert.strictEqual(active.text, '65%');
    assert.strictEqual(active.active, true);

    const settled = frontendDetectProgressState([{ state: 'done' }, { state: 'needsPick' }, { state: 'cancelled' }]);
    assert.ok(Math.abs(settled.ratio - (0.3 + 0.7 * (2 / 3))) < 1e-9);
    assert.strictEqual(settled.text, '77%');
    assert.strictEqual(settled.active, false);

    const justSubmitted = frontendDetectProgressState([{ state: 'processing' }, { state: 'processing' }]);
    assert.strictEqual(justSubmitted.ratio, 0.3);
    assert.strictEqual(justSubmitted.text, '30%');
  });

  t('createQueuedProgressWarmup 从1%随机小步增长到30%，不会直接跳到30%', () => {
    const queued = [];
    const scheduled = [];
    let completed = 0;
    const warmup = frontendDetectProgressState().createQueuedProgressWarmup({
      random: () => 0,
      schedule: (fn) => { scheduled.push(fn); return scheduled.length; },
      clearSchedule: () => {},
      onProgress: (value) => queued.push(value),
      onComplete: () => { completed++; }
    });

    assert.deepStrictEqual(queued, [1]);
    while (scheduled.length) scheduled.shift()();
    assert.strictEqual(queued.at(-1), 30);
    assert.strictEqual(completed, 1);
    assert.ok(queued.every((value, index) => index === 0 || value - queued[index - 1] >= 1 && value - queued[index - 1] <= 3));
    warmup.stop();
  });

  t('matchAgainstProduct 始终返回价格校验明细，明确区分未配置、通过与不一致', () => {
    const unconfigured = M.matchAgainstProduct('空气净化器 ￥299', { id: 'p0', name: '未配置', keywords: ['空气净化器'], price: null }, []);
    assert.deepStrictEqual(unconfigured.priceCheck, { status: 'unconfigured' });

    const passed = M.matchAgainstProduct('空气净化器 ￥399', { id: 'p1', name: '已通过', keywords: ['空气净化器'], price: 399 }, []);
    assert.deepStrictEqual(passed.priceCheck, { status: 'passed', expected: 399 });

    const failed = M.matchAgainstProduct('空气净化器 ￥299', { id: 'p2', name: '不一致', keywords: ['空气净化器'], price: 399 }, []);
    assert.deepStrictEqual(failed.priceCheck, { status: 'failed', expected: 399, found: [299] });
  });

  t('keywordRatio 兼容纯字符串和脏数据，没配置/不合法值一律归到 both', () => {
    assert.strictEqual(M.keywordRatio('纯字符串词'), 'both');
    assert.strictEqual(M.keywordRatio({ text: '词', ratio: '1:1' }), '1:1');
    assert.strictEqual(M.keywordRatio({ text: '词', ratio: '3:4' }), '3:4');
    assert.strictEqual(M.keywordRatio({ text: '词', ratio: '不合法比例' }), 'both');
    assert.strictEqual(M.keywordRatio({ text: '词' }), 'both');
  });

  t('keywordApplies：没传 materialRatio 时不过滤（兼容旧调用方）；传了就按 both/精确匹配过滤', () => {
    const kwBoth = { text: 'x', ratio: 'both' };
    const kw11 = { text: 'x', ratio: '1:1' };
    const kw34 = { text: 'x', ratio: '3:4' };
    assert.strictEqual(M.keywordApplies(kw11, undefined), true);
    assert.strictEqual(M.keywordApplies(kwBoth, '1:1'), true);
    assert.strictEqual(M.keywordApplies(kwBoth, '3:4'), true);
    assert.strictEqual(M.keywordApplies(kw11, '1:1'), true);
    assert.strictEqual(M.keywordApplies(kw11, '3:4'), false);
    assert.strictEqual(M.keywordApplies(kw34, '1:1'), false);
    assert.strictEqual(M.keywordApplies(kw34, '3:4'), true);
  });

  t('matchAgainstProduct 按素材比例过滤必需词：1:1 素材不因缺了仅3:4专属词报缺词，反之亦然', () => {
    const p = {
      id: 'p1', name: '满赠产品',
      keywords: [
        { text: '八大数据', ratio: 'both' },
        { text: '赠品套装', ratio: '3:4' },
        { text: '实时监测', ratio: '1:1' }
      ]
    };
    const rFor11 = M.matchAgainstProduct('八大数据 实时监测', p, [p], '1:1');
    assert.deepStrictEqual(rFor11.missingKeywords, []); // 仅3:4专属的"赠品套装"不该被要求
    assert.strictEqual(rFor11.status, 'pass');

    const rFor34 = M.matchAgainstProduct('八大数据 赠品套装', p, [p], '3:4');
    assert.deepStrictEqual(rFor34.missingKeywords, []); // 仅1:1专属的"实时监测"不该被要求
    assert.strictEqual(rFor34.status, 'pass');

    const rFor11Missing = M.matchAgainstProduct('八大数据', p, [p], '1:1');
    assert.deepStrictEqual(rFor11Missing.missingKeywords, ['实时监测']); // 1:1 自己的专属词缺了照样要报
  });

  t('isPriceLikeLine 整行只有符号+数字（可选"元"）才算价格行', () => {
    assert.strictEqual(M.isPriceLikeLine('¥951'), true);
    assert.strictEqual(M.isPriceLikeLine('￥ 951'), true);
    assert.strictEqual(M.isPriceLikeLine('951'), true);
    assert.strictEqual(M.isPriceLikeLine('1,299元'), true);
    assert.strictEqual(M.isPriceLikeLine('  ￥399  '), true);
    assert.strictEqual(M.isPriceLikeLine('3期免息'), false);
    assert.strictEqual(M.isPriceLikeLine('晒单送10元现金红包'), false);
    assert.strictEqual(M.isPriceLikeLine('满3w赠'), false);
    assert.strictEqual(M.isPriceLikeLine(''), false);
  });

  t('buildKeywordCandidates 每行都是候选词，排除价格行和已有的词，同行重复只留一个', () => {
    const product = { id: 'p1', name: 'GC HEPA H11 底层滤芯', keywords: ['GC HEPA H11 底层滤芯'] };
    const ocrText = [
      'GC HEPA H11 底层滤芯', // 已有，排除
      '除花粉、宠物毛发、粗尘等',
      '预估活动到手价',
      '951', // 价格行，排除
      '￥', // 价格行，排除
      '3期免息',
      '晒单送10元现金红包',
      '晒单送10元现金红包', // 同行重复，只留一次
      '' // 空行，排除
    ].join('\n');
    assert.deepStrictEqual(M.buildKeywordCandidates(ocrText, product), [
      '除花粉、宠物毛发、粗尘等', '预估活动到手价', '3期免息', '晒单送10元现金红包'
    ]);
  });

  t('buildKeywordCandidates 去重按去空格后的文字比较，不做模糊/相似度匹配', () => {
    const product = { id: 'p1', name: 'PreScreen 粗筛滤网', keywords: [{ text: '晒单送十元现金红包', category: '附加权益' }] };
    // 已有词库里的是"晒单送十元现金红包"，OCR 识别出来的是少两个字的"晒单送十元红包"——
    // 只做精确去重，不合并，这条应该仍然被列为候选
    const r = M.buildKeywordCandidates('晒单送十元红包', product);
    assert.deepStrictEqual(r, ['晒单送十元红包']);
  });

  // ── materialcheck-store.js ────────────────────────────
  const { MaterialCheckStore, PLATFORMS } = require('./materialcheck-store.js');
  const stubOcr = (text, confidence = 1) => async () => ({ text, confidence });
  const PF = 'tmall';

  /** 造一个"够用"的假 PNG buffer：只需要 sniffImageSize() 读的那几个固定偏移量对得上
   *  （signature + IHDR 里的宽高），不需要真的能被图片解码器打开——这里没有真实像素/
   *  CRC 数据，纯粹用来测宽高探测和比例交叉校验这条逻辑。 */
  function fakePng(width, height) {
    const buf = Buffer.alloc(33);
    buf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    return buf;
  }

  async function freshStore() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const store = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store.load();
    const libId = store.getLibrary(PF).id;
    await store.saveProducts(PF, libId, [
      { id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi', '抗菌滤网认证号XXX', '7天无理由退换'] },
      { id: 'pb', name: 'GCX XE', keywords: ['GCX XE', '静音悬浮马达'] }
    ]);
    return store;
  }

  t('PLATFORMS 导出天猫京东两个平台', () => {
    assert.deepStrictEqual(PLATFORMS, ['tmall', 'jd']);
  });

  await tAsync('新建的 store 每个平台都自带一套「默认词库」', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const store = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store.load();
    assert.strictEqual(store.listLibraries('tmall').length, 1);
    assert.strictEqual(store.listLibraries('tmall')[0].name, '默认词库');
    assert.strictEqual(store.listLibraries('jd').length, 1);
  });

  await tAsync('createLibrary 新建空词库，名字重复时拒绝', async () => {
    const store = await freshStore();
    const lib = await store.createLibrary(PF, '大促专用');
    assert.strictEqual(lib.products.length, 0);
    assert.strictEqual(store.listLibraries(PF).length, 2);
    await assert.rejects(store.createLibrary(PF, '大促专用'), /已经用过/);
    await assert.rejects(store.createLibrary(PF, '  '), /不能为空/);
  });

  await tAsync('copyLibrary 同平台复制出内容一致但 id 不同的新词库，不带检测历史', async () => {
    const store = await freshStore();
    const srcId = store.getLibrary(PF).id;
    const copy = await store.copyLibrary(PF, srcId, PF, '复制版');
    assert.notStrictEqual(copy.id, srcId);
    assert.strictEqual(copy.products.length, 2);
    // 复制后的产品是深拷贝，改动互不影响
    copy.products[0].name = '改过的名字';
    assert.strictEqual(store.getLibrary(PF, srcId).products[0].name, 'GC-Multi');
  });

  await tAsync('copyLibrary 源词库不存在时拒绝', async () => {
    const store = await freshStore();
    await assert.rejects(store.copyLibrary(PF, 'lib_不存在', PF, '新名字'), /不存在/);
  });

  await tAsync('copyLibrary 可跨平台复制，并只带走选中分类的关键词', async () => {
    const store = await freshStore();
    const srcId = store.getLibrary('tmall').id;
    const sourceProducts = [
      { id: 'p1', name: '产品A', type: 'machine', keywords: [
        { text: '型号A', category: '产品型号', ratio: 'both' },
        { text: '利益点A', category: '产品利益点', ratio: '3:4' }
      ] },
      { id: 'p2', name: '产品B', type: 'filter', keywords: [
        { text: '权益B', category: '大促销售权益', ratio: 'both' }
      ] }
    ];
    await store.saveProducts('tmall', srcId, sourceProducts);
    const copy = await store.copyLibrary('tmall', srcId, 'jd', '京东型号词库', ['产品型号']);
    assert.strictEqual(copy.name, '京东型号词库');
    assert.strictEqual(store.listLibraries('jd').some((l) => l.id === copy.id), true);
    assert.deepStrictEqual(copy.products.map((p) => p.keywords.map((k) => k.text)), [['型号A'], []]);
    assert.strictEqual(copy.products[0].id, 'p1');
  });

  await tAsync('renameLibrary 改名，跟同平台已有名字冲突时拒绝', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    await store.createLibrary(PF, '另一套');
    await assert.rejects(store.renameLibrary(PF, libId, '另一套'), /已经用过/);
    const renamed = await store.renameLibrary(PF, libId, '改名后');
    assert.strictEqual(renamed.name, '改名后');
  });

  await tAsync('deleteLibrary 只剩最后一套时拒绝删除', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    await assert.rejects(store.deleteLibrary(PF, libId), /至少要保留一套/);
    const other = await store.createLibrary(PF, '另一套');
    await store.deleteLibrary(PF, other.id); // 不是最后一套，可以删
    assert.strictEqual(store.listLibraries(PF).length, 1);
  });

  await tAsync('saveProducts 允许同一个词出现在多个产品里，不再报冲突', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const saved = await store.saveProducts(PF, libId, [
      { id: 'pa', name: 'A', keywords: ['同一个词'] },
      { id: 'pb', name: 'B', keywords: ['同一个词'] }
    ]);
    assert.strictEqual(saved.products[0].keywords[0].text, '同一个词');
    assert.strictEqual(saved.products[1].keywords[0].text, '同一个词');
  });

  await tAsync('saveProducts 只更新实际变更产品的词库更新时间，并能保留旧时间', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const first = await store.saveProducts(PF, libId, [
      { id: 'pa', name: 'A', keywords: ['关键词 A'] },
      { id: 'pb', name: 'B', keywords: ['关键词 B'] }
    ]);
    const firstA = first.products[0].updatedAt;
    const firstB = first.products[1].updatedAt;
    assert.ok(Number.isFinite(Date.parse(firstA)));
    assert.ok(Number.isFinite(Date.parse(firstB)));

    const same = await store.saveProducts(PF, libId, first.products);
    assert.strictEqual(same.products[0].updatedAt, firstA);
    assert.strictEqual(same.products[1].updatedAt, firstB);

    const renamed = await store.saveProducts(PF, libId, [{ ...same.products[0], name: 'A 新名称' }, same.products[1]]);
    assert.strictEqual(renamed.products[0].updatedAt, firstA);

    await new Promise((resolve) => setTimeout(resolve, 3));
    const changed = await store.saveProducts(PF, libId, [
      { ...renamed.products[0], keywords: ['关键词 A', '新增词'] },
      renamed.products[1]
    ]);
    assert.notStrictEqual(changed.products[0].updatedAt, firstA);
    assert.strictEqual(changed.products[1].updatedAt, firstB);
  });

  await tAsync('saveProducts 拒绝不认识的平台参数', async () => {
    const store = await freshStore();
    await assert.rejects(store.saveProducts('pdd', 'lib_x', []), /平台参数不对/);
  });

  await tAsync('saveProducts 拒绝不存在的词库 id', async () => {
    const store = await freshStore();
    await assert.rejects(store.saveProducts(PF, 'lib_不存在', []), /不存在/);
  });

  await tAsync('saveProducts 清洗 price 字段：合法数字保留，非法/未填的归一化成 null', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const saved = await store.saveProducts(PF, libId, [
      { id: 'pa', name: 'A', price: 399, keywords: [] },
      { id: 'pb', name: 'B', price: '299', keywords: [] }, // 前端 number input 传字符串也要认
      { id: 'pc', name: 'C', price: -50, keywords: [] }, // 非正数当没填
      { id: 'pd', name: 'D', price: '', keywords: [] },
      { id: 'pe', name: 'E', keywords: [] } // 完全没给 price 字段
    ]);
    assert.strictEqual(saved.products[0].price, 399);
    assert.strictEqual(saved.products[1].price, 299);
    assert.strictEqual(saved.products[2].price, null);
    assert.strictEqual(saved.products[3].price, null);
    assert.strictEqual(saved.products[4].price, null);
  });

  await tAsync('saveProducts 把关键词归一化成 {text,category,ratio} 对象，产品 type 校验非法值兜底为空', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const saved = await store.saveProducts(PF, libId, [
      { id: 'pa', name: 'GC-Multi', type: 'machine', keywords: [{ text: 'GC-Multi', category: '产品型号', ratio: '3:4' }, '国补价1999'] },
      { id: 'pb', name: 'GCX XE', type: '不合法类型', keywords: ['GCX XE'] }
    ]);
    assert.deepStrictEqual(saved.products[0].keywords, [
      { text: 'GC-Multi', category: '产品型号', ratio: '3:4' },
      { text: '国补价1999', category: '其它', ratio: 'both' }
    ]);
    assert.strictEqual(saved.products[0].type, 'machine');
    assert.strictEqual(saved.products[1].type, ''); // 非法 type 兜底为空，不抛错
  });

  await tAsync('天猫和京东两个平台的词库完全独立，互不影响', async () => {
    const store = await freshStore();
    const jdLibId = store.getLibrary('jd').id;
    await store.saveProducts('jd', jdLibId, [{ id: 'pj', name: '京东专属产品', keywords: ['京东词'] }]);
    assert.strictEqual(store.getLibrary('tmall').products.length, 2);
    assert.strictEqual(store.getLibrary('jd').products.length, 1);
    assert.strictEqual(store.getLibrary('jd').products[0].name, '京东专属产品');
    // 同一个词在天猫和京东各自的库里都能用，互不冲突
    await store.saveProducts('jd', jdLibId, [{ id: 'pj', name: '京东专属产品', keywords: ['GC-Multi'] }]);
    assert.strictEqual(store.getLibrary('jd').products[0].keywords[0].text, 'GC-Multi');
  });

  await tAsync('同一个平台下的两套词库互相独立，互不冲突', async () => {
    const store = await freshStore();
    const libA = store.getLibrary(PF).id;
    const libB = await store.createLibrary(PF, '词库B');
    await store.saveProducts(PF, libB.id, [{ id: 'pn', name: '新产品', keywords: ['GC-Multi'] }]); // 跟词库A里的词重名也没事
    assert.strictEqual(store.getLibrary(PF, libA).products.length, 2);
    assert.strictEqual(store.getLibrary(PF, libB.id).products.length, 1);
  });

  await tAsync('detectFile 拒绝不认识的平台参数', async () => {
    const store = await freshStore();
    await assert.rejects(store.detectFile({ buf: Buffer.from('x'), ext: '.jpg', filename: 'a.jpg', batchId: 'b1', uploadedBy: 'li', platform: 'pdd', libraryId: 'lib_x', ocr: stubOcr('x') }), /平台参数不对/);
  });

  await tAsync('detectFile 拒绝不存在的词库 id', async () => {
    const store = await freshStore();
    await assert.rejects(store.detectFile({ buf: Buffer.from('x'), ext: '.jpg', filename: 'a.jpg', batchId: 'b1', uploadedBy: 'li', platform: PF, libraryId: 'lib_不存在', ocr: stubOcr('x') }), /不存在/);
  });

  await tAsync('detectFile 文件名可判定时直接产出通过结果，记录带 platform 和 libraryId', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const result = await store.detectFile({
      buf: Buffer.from('fake-image-bytes'), ext: '.jpg', filename: 'GC-Multi_主图.jpg', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX 7天无理由退换')
    });
    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.productId, 'pa');
    assert.strictEqual(result.matchMethod, 'filename');
    assert.strictEqual(result.platform, PF);
    assert.strictEqual(result.libraryId, libId);
    assert.strictEqual(store.records.length, 1);
  });

  await tAsync('detectFile 不传 libraryId 时兜底用平台第一套词库', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg', platform: PF,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX 7天无理由退换')
    });
    assert.strictEqual(result.libraryId, store.getLibrary(PF).id);
  });

  await tAsync('detectFile 缺词时判定为提醒状态', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi')
    });
    assert.strictEqual(result.status, 'warn');
    assert.deepStrictEqual(result.missingKeywords, ['抗菌滤网认证号XXX', '7天无理由退换']);
  });

  await tAsync('detectFile OCR 失败时判定为 ocr_failed', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const stubOcrFail = () => async () => { throw new Error('识别失败：图片损坏'); };
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0001.jpg', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcrFail()
    });
    assert.strictEqual(result.status, 'ocr_failed');
    assert.strictEqual(store.records.length, 1);
    assert.strictEqual(store.pending.size, 0);
  });

  await tAsync('detectFile 客户端取消后不写入检测历史或保留上传素材', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    await store.saveProducts(PF, libId, [{ id: 'pa', name: 'GC-Multi', type: 'machine', keywords: ['GC-Multi'] }]);
    await assert.rejects(() => store.detectFile({
      buf: Buffer.from('cancelled-material'), ext: '.jpg', filename: 'GC-Multi.jpg', platform: PF, libraryId: libId,
      isCancelled: () => true, ocr: stubOcr('GC-Multi', 0.95)
    }), /已取消/);
    assert.strictEqual(store.records.length, 0);
    assert.deepStrictEqual(await fsp.readdir(store.uploadDir), []);
  });

  await tAsync('detectFile 文件名和 OCR 都无法判定时返回待人工选择，不写入历史记录', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0001.jpg', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('无关文字')
    });
    assert.strictEqual(result.needsManualPick, true);
    assert.ok(result.pendingId);
    assert.strictEqual(store.records.length, 0);
  });

  await tAsync('resolvePending 用人工选择的产品完成判定并写入历史，记录带正确的 platform 和 libraryId', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0001.jpg', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX')
    });
    // 用一段两个产品都不命中的文字，强迫走人工选择路径
    const ambiguousPending = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0002.jpg', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('完全无关的文字')
    });
    const resolved = await store.resolvePending(ambiguousPending.pendingId, 'pa', 'li');
    assert.strictEqual(resolved.matchMethod, 'manual');
    assert.strictEqual(resolved.productId, 'pa');
    assert.strictEqual(resolved.platform, PF);
    assert.strictEqual(resolved.libraryId, libId);
    assert.strictEqual(store.records.length, 2); // pending 本身没落库，resolvePending 后 + 上面那条 filename 判定的
  });

  await tAsync('detectFile 按传入的 ratio 过滤必需词，并把 ratio 写进检测记录', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    await store.saveProducts(PF, libId, [
      { id: 'pa', name: 'GC-Multi', keywords: [{ text: 'GC-Multi', ratio: 'both' }, { text: '仅3:4专属词', ratio: '3:4' }] },
      { id: 'pb', name: 'GCX XE', keywords: ['GCX XE', '静音悬浮马达'] }
    ]);
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_a.jpg', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ratio: '1:1', ocr: stubOcr('GC-Multi')
    });
    assert.strictEqual(result.ratio, '1:1');
    assert.deepStrictEqual(result.missingKeywords, []); // 仅3:4专属的词不该在 1:1 素材上报缺
    assert.strictEqual(result.status, 'pass');
  });

  await tAsync('detectFile 传入不合法/缺失的 ratio 时兜底为 null，不过滤任何词（等价于旧行为）', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    await store.saveProducts(PF, libId, [
      { id: 'pa', name: 'GC-Multi', keywords: [{ text: '仅3:4专属词', ratio: '3:4' }] }
    ]);
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_a.jpg', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ratio: '不合法比例', ocr: stubOcr('')
    });
    assert.strictEqual(result.ratio, null);
    assert.deepStrictEqual(result.missingKeywords, ['仅3:4专属词']); // 没有可信的比例上下文，照旧全量校验
  });

  await tAsync('detectFile 素材实际像素比例跟选的入口对不上时，报警但仍按选的入口判定，不拦截', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    await store.saveProducts(PF, libId, [
      { id: 'pa', name: 'GC-Multi', keywords: [{ text: '仅3:4专属词', ratio: '3:4' }] }
    ]);
    // 图片实际是 1440x1920（3:4），但用户选了 1:1 入口
    const result = await store.detectFile({
      buf: fakePng(1440, 1920), ext: '.png', filename: 'GC-Multi_a.png', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ratio: '1:1', ocr: stubOcr('')
    });
    assert.strictEqual(result.ratio, '1:1'); // 判定仍以入口选择为准
    assert.deepStrictEqual(result.missingKeywords, []); // 按 1:1 过滤，3:4 专属词不算缺
    assert.ok(result.warning && result.warning.includes('3:4'), '应该提示实际像素比例跟选的入口不一致');
  });

  await tAsync('detectFile 素材像素比例跟入口一致时不产生比例提示', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const result = await store.detectFile({
      buf: fakePng(1440, 1920), ext: '.png', filename: 'GC-Multi_a.png', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ratio: '3:4', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX 7天无理由退换')
    });
    assert.strictEqual(result.warning, null);
  });

  await tAsync('resolvePending 人工选择产品后，pending 阶段算出的比例提示仍然带在最终记录里', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const pending = await store.detectFile({
      buf: fakePng(1440, 1920), ext: '.png', filename: 'IMG_0099.png', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ratio: '1:1', ocr: stubOcr('完全无关的文字')
    });
    assert.strictEqual(pending.needsManualPick, true);
    assert.ok(pending.ratioMismatch && pending.ratioMismatch.includes('3:4'));
    const resolved = await store.resolvePending(pending.pendingId, 'pa', 'li');
    assert.strictEqual(resolved.ratio, '1:1');
    assert.strictEqual(resolved.warning, pending.ratioMismatch);
  });

  await tAsync('detectFile 整体识别置信度低时转人工核对，即便文件名本可判定产品', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX', 0.4)
    });
    assert.strictEqual(result.needsManualPick, true);
    assert.strictEqual(result.lowConfidence, true);
    assert.strictEqual(store.records.length, 0); // 待人工核对不落历史记录，跟其它 pending 情况一致
  });

  await tAsync('resolvePending 完成判定后记录里带着识别置信度', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX 7天无理由退换', 0.93)
    });
    assert.ok(Math.abs(result.ocrConfidence - 0.93) < 1e-9);
  });

  await tAsync('reassignRecord 人工切换产品后立刻按新产品词库重算并持久化记录', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    await store.saveProducts(PF, libId, [
      { id: 'pa', name: '产品 A', keywords: ['产品 A'] },
      { id: 'pb', name: '产品 B', keywords: ['产品 B', '产品 B 专属词'] }
    ]);
    const detected = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: '产品 A.jpg', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('产品 B 产品 B 专属词')
    });
    const reassigned = await store.reassignRecord(detected.id, 'pb');
    assert.strictEqual(reassigned.productId, 'pb');
    assert.strictEqual(reassigned.productName, '产品 B');
    assert.strictEqual(reassigned.matchMethod, 'manual');
    assert.strictEqual(reassigned.status, 'pass');
    const reloaded = new MaterialCheckStore(store.dir, store.uploadDir);
    await reloaded.load();
    assert.strictEqual(reloaded.records[0].productId, 'pb');
  });

  await tAsync('resolvePending 对不存在的 pendingId 抛出错误', async () => {
    const store = await freshStore();
    await assert.rejects(store.resolvePending('mcp_不存在', 'pa', 'li'), /过期|不存在/);
  });

  await tAsync('detectFile 出现别的产品的词时判定为多出的词、报错状态', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX GCX XE')
    });
    assert.strictEqual(result.status, 'error');
    assert.deepStrictEqual(result.extraKeywords, ['GCX XE']);
  });

  await tAsync('detectFile 配置了 price 的产品，图里价格不对时报错并把 priceIssue 写进历史记录', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    await store.saveProducts(PF, libId, [
      { id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi', '抗菌滤网认证号XXX'], price: 399 },
      { id: 'pb', name: 'GCX XE', keywords: ['GCX XE', '静音悬浮马达'] }
    ]);
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg', platform: PF, libraryId: libId,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX ￥299')
    });
    assert.strictEqual(result.status, 'error');
    assert.deepStrictEqual(result.priceIssue, { expected: 399, found: [299] });
    assert.deepStrictEqual(store.records[0].priceIssue, { expected: 399, found: [299] });
  });

  await tAsync('listRecords 按产品和状态过滤，最新的排最前', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    await store.detectFile({ buf: Buffer.from('1'), ext: '.jpg', filename: 'GC-Multi_a.jpg', platform: PF, libraryId: libId, batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX 7天无理由退换') });
    await store.detectFile({ buf: Buffer.from('2'), ext: '.jpg', filename: 'GC-Multi_b.jpg', platform: PF, libraryId: libId, batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi') });
    const passOnly = store.listRecords({ productId: 'pa', status: 'pass' });
    assert.strictEqual(passOnly.length, 1);
    assert.strictEqual(passOnly[0].filename, 'GC-Multi_a.jpg');
  });

  await tAsync('listRecords 按平台过滤', async () => {
    const store = await freshStore();
    const tmallLibId = store.getLibrary('tmall').id;
    const jdLibId = store.getLibrary('jd').id;
    await store.saveProducts('jd', jdLibId, [{ id: 'pj', name: '京东产品', keywords: ['京东词'] }]);
    await store.detectFile({ buf: Buffer.from('1'), ext: '.jpg', filename: 'GC-Multi_a.jpg', platform: 'tmall', libraryId: tmallLibId, batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX') });
    await store.detectFile({ buf: Buffer.from('2'), ext: '.jpg', filename: '京东产品_a.jpg', platform: 'jd', libraryId: jdLibId, batchId: 'b2', uploadedBy: 'li', ocr: stubOcr('京东词') });
    assert.strictEqual(store.listRecords({ platform: 'tmall' }).length, 1);
    assert.strictEqual(store.listRecords({ platform: 'jd' }).length, 1);
    assert.strictEqual(store.listRecords({}).length, 2);
  });

  await tAsync('listRecords 按词库过滤', async () => {
    const store = await freshStore();
    const libA = store.getLibrary(PF).id;
    const libB = await store.createLibrary(PF, '词库B');
    await store.saveProducts(PF, libB.id, [{ id: 'pn', name: '新产品', keywords: ['新品词'] }]);
    await store.detectFile({ buf: Buffer.from('1'), ext: '.jpg', filename: 'GC-Multi_a.jpg', platform: PF, libraryId: libA, batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX') });
    await store.detectFile({ buf: Buffer.from('2'), ext: '.jpg', filename: '新产品_a.jpg', platform: PF, libraryId: libB.id, batchId: 'b2', uploadedBy: 'li', ocr: stubOcr('新品词') });
    assert.strictEqual(store.listRecords({ libraryId: libA }).length, 1);
    assert.strictEqual(store.listRecords({ libraryId: libB.id }).length, 1);
  });

  await tAsync('detectFile 服务端 OCR 并发受限于设定上限', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const store = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'), { ocrConcurrency: 1 });
    await store.load();
    const libId = store.getLibrary(PF).id;
    await store.saveProducts(PF, libId, [{ id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi'] }]);

    let active = 0, maxActive = 0;
    const controlledOcr = () => new Promise((resolve) => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => { active--; resolve({ text: 'GC-Multi', confidence: 1 }); }, 20);
    });

    await Promise.all([
      store.detectFile({ buf: Buffer.from('1'), ext: '.jpg', filename: 'GC-Multi_a.jpg', platform: PF, libraryId: libId, batchId: 'b1', uploadedBy: 'li', ocr: controlledOcr }),
      store.detectFile({ buf: Buffer.from('2'), ext: '.jpg', filename: 'GC-Multi_b.jpg', platform: PF, libraryId: libId, batchId: 'b1', uploadedBy: 'li', ocr: controlledOcr }),
      store.detectFile({ buf: Buffer.from('3'), ext: '.jpg', filename: 'GC-Multi_c.jpg', platform: PF, libraryId: libId, batchId: 'b1', uploadedBy: 'li', ocr: controlledOcr })
    ]);

    assert.strictEqual(maxActive, 1);
  });

  await tAsync('saveProducts 拒绝产品名为空的库并保留原有数据', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    await assert.rejects(
      store.saveProducts(PF, libId, [{ id: 'pa', name: '   ', keywords: ['GC-Multi'] }, { id: 'pb', name: 'GCX XE', keywords: ['静音悬浮马达'] }]),
      /产品名称不能为空/
    );
    assert.strictEqual(store.getLibrary(PF, libId).products.length, 2); // 拒绝后没有把坏数据写进去
  });

  await tAsync('saveProducts 保留 /uploads/ 开头的 imageUrl，拒绝其它任意字符串', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const saved = await store.saveProducts(PF, libId, [
      { id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi'], imageUrl: '/uploads/abc123.jpg' },
      { id: 'pb', name: 'GCX XE', keywords: ['GCX XE'], imageUrl: 'javascript:alert(1)' }
    ]);
    assert.strictEqual(saved.products[0].imageUrl, '/uploads/abc123.jpg');
    assert.strictEqual(saved.products[1].imageUrl, null);
  });

  await tAsync('withAutoImages 给产品附上最近一条已匹配到它的检测记录图，没记录的是 null', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    await store.detectFile({ buf: Buffer.from('1'), ext: '.jpg', filename: 'a1.jpg', platform: PF, libraryId: libId, batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi') });
    await store.detectFile({ buf: Buffer.from('2'), ext: '.jpg', filename: 'a2.jpg', platform: PF, libraryId: libId, batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi') });
    const lib = store.getLibrary(PF, libId);
    const withImgs = store.withAutoImages(lib, PF, libId);
    const pa = withImgs.products.find((p) => p.id === 'pa');
    const pb = withImgs.products.find((p) => p.id === 'pb');
    // 最近一条（a2.jpg）覆盖第一条（a1.jpg）
    assert.ok(pa.autoImage && pa.autoImage.includes('/uploads/materialcheck/'));
    assert.strictEqual(pb.autoImage, null); // 没有任何检测记录匹配到这个产品
  });

  await tAsync('load() 能重新读回持久化的数据', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const store1 = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store1.load();
    const libId = store1.getLibrary(PF).id;
    await store1.saveProducts(PF, libId, [{ id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi'] }]);
    await store1.detectFile({ buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi.jpg', platform: PF, libraryId: libId, batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi') });

    const store2 = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store2.load();
    assert.strictEqual(store2.getLibrary(PF).products.length, 1);
    assert.strictEqual(store2.records.length, 1);
  });

  await tAsync('load() 重新读盘后 imageUrl 不会丢（normalizeLibrary 要保留这个字段，不只是 saveProducts 存对）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const store1 = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store1.load();
    const libId = store1.getLibrary(PF).id;
    await store1.saveProducts(PF, libId, [{ id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi'], imageUrl: '/uploads/abc123.jpg' }]);

    const store2 = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store2.load();
    assert.strictEqual(store2.getLibrary(PF).products[0].imageUrl, '/uploads/abc123.jpg');
  });

  await tAsync('load() 自动把 v1 最老的扁平结构迁移成天猫命名空间下的「默认词库」', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const mcDir = path.join(dir, 'materialcheck');
    await fsp.mkdir(mcDir, { recursive: true });
    await fsp.writeFile(path.join(mcDir, 'products.json'), JSON.stringify({
      products: [{ id: 'old1', name: '旧产品', keywords: ['旧关键词'] }]
    }));

    const store = new MaterialCheckStore(mcDir, path.join(dir, 'uploads'));
    await store.load();
    assert.strictEqual(store.getLibrary('tmall').name, '默认词库');
    assert.strictEqual(store.getLibrary('tmall').products.length, 1);
    assert.strictEqual(store.getLibrary('tmall').products[0].name, '旧产品');
    assert.strictEqual(store.getLibrary('jd').products.length, 0);
    assert.strictEqual(store.getLibrary('jd').name, '默认词库');

    // 迁移后落盘为新格式，重新 load 应该直接读到新格式，不再重复触发迁移逻辑
    const raw = JSON.parse(await fsp.readFile(path.join(mcDir, 'products.json'), 'utf8'));
    assert.ok(Array.isArray(raw.tmall.libraries) && Array.isArray(raw.jd.libraries));
  });

  await tAsync('load() 自动把 v2 单词库结构迁移成多词库结构下的「默认词库」', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const mcDir = path.join(dir, 'materialcheck');
    await fsp.mkdir(mcDir, { recursive: true });
    await fsp.writeFile(path.join(mcDir, 'products.json'), JSON.stringify({
      tmall: { products: [{ id: 'p1', name: 'GCX XE', keywords: ['瑞士精工'] }] },
      jd: { products: [] }
    }));

    const store = new MaterialCheckStore(mcDir, path.join(dir, 'uploads'));
    await store.load();
    assert.strictEqual(store.listLibraries('tmall').length, 1);
    assert.strictEqual(store.getLibrary('tmall').name, '默认词库');
    assert.strictEqual(store.getLibrary('tmall').products[0].name, 'GCX XE');
    assert.strictEqual(store.listLibraries('jd').length, 1);
  });

  await tAsync('autobuildScan 文件名可判定产品时，返回排除了已有词和价格行的候选词，不写检测记录', async () => {
    const store = await freshStore();
    const before = store.records.length;
    const ocr = stubOcr('GC-Multi\n抗菌滤网认证号XXX\n新的卖点一\n￥399\n新的卖点一', 0.95);
    const result = await store.autobuildScan({ buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi.jpg', platform: PF, libraryId: store.getLibrary(PF).id, ocr });
    assert.strictEqual(result.productId, 'pa');
    assert.strictEqual(result.productName, 'GC-Multi');
    assert.deepStrictEqual(result.candidates, ['新的卖点一']);
    assert.strictEqual(result.candidateProducts.length, 0);
    assert.strictEqual(store.records.length, before); // 只是扫描预览，不落检测记录
  });

  await tAsync('autobuildScan 相同素材确认复用时读取已缓存 OCR，但按当前词库重新生成候选词', async () => {
    const store = await freshStore();
    const buf = Buffer.from('same-material-content');
    let calls = 0;
    const first = await store.autobuildScan({
      buf, ext: '.jpg', filename: 'GC-Multi.jpg', platform: PF, libraryId: store.getLibrary(PF).id,
      ocr: async () => { calls++; return { text: 'GC-Multi\n新的卖点', confidence: 0.96 }; }
    });
    assert.strictEqual(first.reusedOcr, false);
    assert.strictEqual(calls, 1);
    const hash = require('crypto').createHash('sha256').update(buf).digest('hex');
    assert.strictEqual(store.autobuildCacheExists(hash), true);
    const second = await store.autobuildScan({
      buf, ext: '.jpg', filename: 'GC-Multi.jpg', platform: PF, libraryId: store.getLibrary(PF).id, reuseOcr: true,
      ocr: async () => { throw new Error('确认复用后不应重新调用 OCR'); }
    });
    assert.strictEqual(second.reusedOcr, true);
    assert.deepStrictEqual(second.candidates, ['新的卖点']);
  });

  await tAsync('autobuildScan 可复用检测台历史素材的 OCR，而不只限于批量识别缓存', async () => {
    const store = await freshStore();
    const buf = Buffer.from('material-already-scanned-at-detection-desk');
    const imageName = 'previously-detected.jpg';
    await require('fs').promises.writeFile(require('path').join(store.uploadDir, imageName), buf);
    store.records.push({
      imagePath: '/uploads/materialcheck/' + imageName,
      ocrText: 'GC-Multi\n来自检测台的既有 OCR',
      ocrConfidence: 0.98
    });
    assert.strictEqual(await store.autobuildCacheExistsFor(buf), true);
    const result = await store.autobuildScan({
      buf, ext: '.jpg', filename: 'GC-Multi.jpg', platform: PF, libraryId: store.getLibrary(PF).id, reuseOcr: true,
      ocr: async () => { throw new Error('复用检测台历史结果时不应启动 OCR'); }
    });
    assert.strictEqual(result.reusedOcr, true);
    assert.deepStrictEqual(result.candidates, ['来自检测台的既有 OCR']);
  });

  await tAsync('autobuildScan 自动从真实尺寸识别比例；不符合两种规格时拒绝 OCR', async () => {
    const store = await freshStore();
    const ocr = stubOcr('GC-Multi\n新的卖点一', 0.95);
    const result = await store.autobuildScan({
      buf: fakePng(1440, 1920), ext: '.png', filename: 'GC-Multi.png', platform: PF, libraryId: store.getLibrary(PF).id, requireDetectedRatio: true, ocr
    });
    assert.strictEqual(result.ratio, '3:4');
    await assert.rejects(() => store.autobuildScan({
      buf: fakePng(1600, 900), ext: '.png', filename: 'GC-Multi-wide.png', platform: PF, libraryId: store.getLibrary(PF).id, requireDetectedRatio: true, ocr
    }), /只支持接近 1:1 或 3:4/);
  });

  await tAsync('autobuildScan 文件名和 OCR 都判断不出产品时，返回待人工指定，候选词为空', async () => {
    const store = await freshStore();
    const ocr = stubOcr('随便什么完全不相关的文字', 0.95);
    const result = await store.autobuildScan({ buf: Buffer.from('x'), ext: '.jpg', filename: 'random.jpg', platform: PF, libraryId: store.getLibrary(PF).id, ocr });
    assert.strictEqual(result.productId, null);
    assert.deepStrictEqual(result.candidates, []);
  });

  await tAsync('autobuildCandidatesFor 人工指定产品后，按该产品自己的词库算候选词', async () => {
    const store = await freshStore();
    const candidates = store.autobuildCandidatesFor({
      platform: PF, libraryId: store.getLibrary(PF).id, productId: 'pb',
      ocrText: 'GCX XE\n静音悬浮马达\n又一个新卖点'
    });
    assert.deepStrictEqual(candidates.candidates, ['又一个新卖点']);
    assert.deepStrictEqual(candidates.recognizedCandidates, ['GCX XE', '静音悬浮马达', '又一个新卖点']);
  });

  await tAsync('autobuildCandidatesFor 产品不存在时抛出错误', async () => {
    const store = await freshStore();
    assert.throws(() => store.autobuildCandidatesFor({ platform: PF, libraryId: store.getLibrary(PF).id, productId: 'nope', ocrText: '随便' }), /不存在/);
  });

  t('批量审核按每张素材手动指定的目标产品重新分组，不把误判素材收进同一产品', () => {
    const groups = frontendAutobuildGroups([
      { status: 'resolved', productId: 'wrong', productName: '误判产品', targetProductId: 'cf', targetProductName: 'HyperHEPA CF 滤芯', candidates: ['CF 关键词'], ratio: '1:1' },
      { status: 'resolved', productId: 'wrong', productName: '误判产品', targetProductId: 'hf', targetProductName: 'HyperHEPA HF 滤芯', candidates: ['HF 关键词'], ratio: '3:4' },
      { status: 'resolved', productId: 'wrong', productName: '误判产品', targetProductId: 'plus', targetProductName: 'HyperHEPA Plus 滤芯', candidates: ['Plus 关键词'], ratio: '1:1' }
    ]);
    assert.strictEqual(groups.size, 3);
    assert.deepStrictEqual([...groups.keys()].sort(), ['cf', 'hf', 'plus']);
  });

  t('批量审核在后续素材识别完成并重绘时，保留已选择的写入方式与词勾选状态', () => {
    const reviewState = new Map();
    const first = [{ status: 'resolved', productId: 'p1', productName: 'Atem Desk', candidates: ['词 A'], ratio: '1:1' }];
    const initial = frontendAutobuildGroups(first, reviewState);
    const group = initial.get('p1');
    assert.strictEqual(group.mode, 'replace');
    group.mode = 'append';
    group.cands.get('词A').checked = false;

    const afterAnotherImage = frontendAutobuildGroups([...first, { status: 'resolved', productId: 'p1', productName: 'Atem Desk', candidates: ['词 B'], ratio: '3:4' }], reviewState);
    const restored = afterAnotherImage.get('p1');
    assert.strictEqual(restored.mode, 'append');
    assert.strictEqual(restored.cands.get('词A').checked, false);
    assert.strictEqual(restored.cands.get('词B').checked, true);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
