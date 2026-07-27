const assert = require('assert');
const { runOcr, checkAvailable, PaddleOcrWorker } = require('./materialcheck-ocr.js');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '-', e.message); }
};
const tAsync = async (name, fn) => {
  try { await fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '-', e.message); }
};

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

  t('resolveProductForUpload 文件名优先于 OCR', () => {
    const r = M.resolveProductForUpload('GC-Multi_主图.jpg', 'GCX XE 静音悬浮马达', products);
    assert.strictEqual(r.method, 'filename');
    assert.strictEqual(r.product.id, 'pa');
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

  t('matchAgainstProduct 缺词判定为提醒状态', () => {
    const r = M.matchAgainstProduct('GC-Multi', productA, products);
    assert.deepStrictEqual(r.missingKeywords, ['抗菌滤网认证号XXX']);
    assert.strictEqual(r.status, 'warn');
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

  t('keywordText/keywordCategory 兼容纯字符串和 {text,category} 对象两种关键词写法', () => {
    assert.strictEqual(M.keywordText('纯字符串词'), '纯字符串词');
    assert.strictEqual(M.keywordText({ text: '对象词', category: '价格' }), '对象词');
    assert.strictEqual(M.keywordCategory('纯字符串词'), '其它');
    assert.strictEqual(M.keywordCategory({ text: '对象词', category: '价格' }), '价格');
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

  await tAsync('copyLibrary 复制出内容一致但 id 不同的新词库，不带检测历史', async () => {
    const store = await freshStore();
    const srcId = store.getLibrary(PF).id;
    const copy = await store.copyLibrary(PF, srcId, '复制版');
    assert.notStrictEqual(copy.id, srcId);
    assert.strictEqual(copy.products.length, 2);
    // 复制后的产品是深拷贝，改动互不影响
    copy.products[0].name = '改过的名字';
    assert.strictEqual(store.getLibrary(PF, srcId).products[0].name, 'GC-Multi');
  });

  await tAsync('copyLibrary 源词库不存在时拒绝', async () => {
    const store = await freshStore();
    await assert.rejects(store.copyLibrary(PF, 'lib_不存在', '新名字'), /不存在/);
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

  await tAsync('saveProducts 把关键词归一化成 {text,category} 对象，产品 type 校验非法值兜底为空', async () => {
    const store = await freshStore();
    const libId = store.getLibrary(PF).id;
    const saved = await store.saveProducts(PF, libId, [
      { id: 'pa', name: 'GC-Multi', type: 'machine', keywords: [{ text: 'GC-Multi', category: '产品型号' }, '国补价1999'] },
      { id: 'pb', name: 'GCX XE', type: '不合法类型', keywords: ['GCX XE'] }
    ]);
    assert.deepStrictEqual(saved.products[0].keywords, [{ text: 'GC-Multi', category: '产品型号' }, { text: '国补价1999', category: '其它' }]);
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
    assert.deepStrictEqual(candidates, ['又一个新卖点']);
  });

  await tAsync('autobuildCandidatesFor 产品不存在时抛出错误', async () => {
    const store = await freshStore();
    assert.throws(() => store.autobuildCandidatesFor({ platform: PF, libraryId: store.getLibrary(PF).id, productId: 'nope', ocrText: '随便' }), /不存在/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
