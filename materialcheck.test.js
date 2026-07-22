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
  const universal = ['7天无理由退换', '包邮'];

  t('findKeywordHits 找出命中的关键词，忽略空白', () => {
    const hits = M.findKeywordHits('这款 GC-Multi 带 抗菌滤网认证号XXX 效果好', ['GC-Multi', '抗菌滤网认证号XXX', 'GCX XE']);
    assert.deepStrictEqual(hits, ['GC-Multi', '抗菌滤网认证号XXX']);
  });

  t('findKeywordHits 忽略文本中的换行空格', () => {
    const hits = M.findKeywordHits('这款 GC\n-Multi 不错', ['GC-Multi']);
    assert.deepStrictEqual(hits, ['GC-Multi']);
  });

  t('validateLibrary 无冲突时返回空数组', () => {
    assert.deepStrictEqual(M.validateLibrary(products, universal), []);
  });

  t('validateLibrary 检出跨产品重复关键词', () => {
    const dup = [productA, { id: 'pc', name: 'C', keywords: ['GC-Multi'] }];
    const conflicts = M.validateLibrary(dup, []);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].keyword, 'GC-Multi');
  });

  t('validateLibrary 检出产品词和通用词重复', () => {
    const conflicts = M.validateLibrary(products, ['GC-Multi']);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].keyword, 'GC-Multi');
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

  t('matchAgainstProduct 全部命中且无串词时通过', () => {
    const r = M.matchAgainstProduct('GC-Multi 抗菌滤网认证号XXX 7天无理由退换', productA, products);
    assert.deepStrictEqual(r.missingKeywords, []);
    assert.deepStrictEqual(r.crossedKeywords, []);
    assert.strictEqual(r.status, 'pass');
  });

  t('matchAgainstProduct 缺词判定为提醒状态', () => {
    const r = M.matchAgainstProduct('GC-Multi', productA, products);
    assert.deepStrictEqual(r.missingKeywords, ['抗菌滤网认证号XXX']);
    assert.strictEqual(r.status, 'warn');
  });

  t('matchAgainstProduct 串词判定为报错状态，标注来源产品', () => {
    const r = M.matchAgainstProduct('GC-Multi 抗菌滤网认证号XXX GCX XE', productA, products);
    assert.deepStrictEqual(r.missingKeywords, []);
    assert.strictEqual(r.crossedKeywords.length, 1);
    assert.strictEqual(r.crossedKeywords[0].keyword, 'GCX XE');
    assert.strictEqual(r.crossedKeywords[0].fromProductId, 'pb');
    assert.strictEqual(r.status, 'error');
  });

  t('matchAgainstProduct 既有串词又有缺词时，报错优先，但详情仍分别列出', () => {
    const r = M.matchAgainstProduct('GCX XE', productA, products);
    assert.deepStrictEqual(r.missingKeywords, ['GC-Multi', '抗菌滤网认证号XXX']);
    assert.strictEqual(r.crossedKeywords.length, 1);
    assert.strictEqual(r.status, 'error');
  });

  t('matchAgainstProduct 通用词不参与缺词也不参与串词', () => {
    const r = M.matchAgainstProduct('GC-Multi 抗菌滤网认证号XXX', productA, products);
    assert.deepStrictEqual(r.missingKeywords, []);
    assert.deepStrictEqual(r.crossedKeywords, []);
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

  t('validateLibrary 检出产品词和机器组内通用词重复', () => {
    const conflicts = M.validateLibrary(products, [], { machine: ['GC-Multi'] });
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].keyword, 'GC-Multi');
    assert.strictEqual(conflicts[0].second, '机器组内通用词');
  });

  t('validateLibrary 不传 sharedPools 时行为跟老版本一致', () => {
    assert.deepStrictEqual(M.validateLibrary(products, universal), []);
  });

  // ── materialcheck-store.js ────────────────────────────
  const { MaterialCheckStore, PLATFORMS } = require('./materialcheck-store.js');
  const stubOcr = (text, confidence = 1) => async () => ({ text, confidence });
  const PF = 'tmall';

  async function freshStore() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const store = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store.load();
    await store.saveProducts(
      PF,
      [
        { id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi', '抗菌滤网认证号XXX'] },
        { id: 'pb', name: 'GCX XE', keywords: ['GCX XE', '静音悬浮马达'] }
      ],
      ['7天无理由退换']
    );
    return store;
  }

  t('PLATFORMS 导出天猫京东两个平台', () => {
    assert.deepStrictEqual(PLATFORMS, ['tmall', 'jd']);
  });

  await tAsync('saveProducts 拒绝重复关键词并保留原有数据', async () => {
    const store = await freshStore();
    await assert.rejects(
      store.saveProducts(PF, [{ id: 'pa', name: 'A', keywords: ['同一个词'] }, { id: 'pb', name: 'B', keywords: ['同一个词'] }], []),
      /同一个词/
    );
    assert.strictEqual(store.getLibrary(PF).products.length, 2); // 拒绝后没有把坏数据写进去
  });

  await tAsync('saveProducts 拒绝不认识的平台参数', async () => {
    const store = await freshStore();
    await assert.rejects(store.saveProducts('pdd', [], []), /平台参数不对/);
  });

  await tAsync('saveProducts 把关键词归一化成 {text,category} 对象，产品 type 校验非法值兜底为空', async () => {
    const store = await freshStore();
    const saved = await store.saveProducts(PF, [
      { id: 'pa', name: 'GC-Multi', type: 'machine', keywords: [{ text: 'GC-Multi', category: '产品型号' }, '国补价1999'] },
      { id: 'pb', name: 'GCX XE', type: '不合法类型', keywords: ['GCX XE'] }
    ], []);
    assert.deepStrictEqual(saved.products[0].keywords, [{ text: 'GC-Multi', category: '产品型号' }, { text: '国补价1999', category: '其它' }]);
    assert.strictEqual(saved.products[0].type, 'machine');
    assert.strictEqual(saved.products[1].type, ''); // 非法 type 兜底为空，不抛错
  });

  await tAsync('saveProducts 保存三套组内通用词，且跟专属词冲突时拒绝', async () => {
    const store = await freshStore();
    const saved = await store.saveProducts(PF, [{ id: 'pa', name: 'GC-Multi', type: 'machine', keywords: ['GC-Multi'] }], [], {
      machine: ['机器组内共享词'], filter: ['滤芯组内共享词'], accessory: ['附件组内共享词']
    });
    assert.deepStrictEqual(saved.machineSharedKeywords, ['机器组内共享词']);
    assert.deepStrictEqual(saved.filterSharedKeywords, ['滤芯组内共享词']);
    assert.deepStrictEqual(saved.accessorySharedKeywords, ['附件组内共享词']);

    await assert.rejects(
      store.saveProducts(PF, [{ id: 'pa', name: 'GC-Multi', keywords: ['冲突词'] }], [], { machine: ['冲突词'] }),
      /冲突词/
    );
  });

  await tAsync('天猫和京东两个平台的词库完全独立，互不影响', async () => {
    const store = await freshStore();
    await store.saveProducts('jd', [{ id: 'pj', name: '京东专属产品', keywords: ['京东词'] }], []);
    assert.strictEqual(store.getLibrary('tmall').products.length, 2);
    assert.strictEqual(store.getLibrary('jd').products.length, 1);
    assert.strictEqual(store.getLibrary('jd').products[0].name, '京东专属产品');
    // 同一个词在天猫和京东各自的库里都能用，互不冲突
    await store.saveProducts('jd', [{ id: 'pj', name: '京东专属产品', keywords: ['GC-Multi'] }], []);
    assert.strictEqual(store.getLibrary('jd').products[0].keywords[0].text, 'GC-Multi');
  });

  await tAsync('detectFile 拒绝不认识的平台参数', async () => {
    const store = await freshStore();
    await assert.rejects(store.detectFile({ buf: Buffer.from('x'), ext: '.jpg', filename: 'a.jpg', batchId: 'b1', uploadedBy: 'li', platform: 'pdd', ocr: stubOcr('x') }), /平台参数不对/);
  });

  await tAsync('detectFile 文件名可判定时直接产出通过结果，记录带 platform', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('fake-image-bytes'), ext: '.jpg', filename: 'GC-Multi_主图.jpg', platform: PF,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX 7天无理由退换')
    });
    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.productId, 'pa');
    assert.strictEqual(result.matchMethod, 'filename');
    assert.strictEqual(result.platform, PF);
    assert.strictEqual(store.records.length, 1);
  });

  await tAsync('detectFile 缺词时判定为提醒状态', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg', platform: PF,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi')
    });
    assert.strictEqual(result.status, 'warn');
    assert.deepStrictEqual(result.missingKeywords, ['抗菌滤网认证号XXX']);
  });

  await tAsync('detectFile OCR 失败时判定为 ocr_failed', async () => {
    const store = await freshStore();
    const stubOcrFail = () => async () => { throw new Error('识别失败：图片损坏'); };
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0001.jpg', platform: PF,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcrFail()
    });
    assert.strictEqual(result.status, 'ocr_failed');
    assert.strictEqual(store.records.length, 1);
    assert.strictEqual(store.pending.size, 0);
  });

  await tAsync('detectFile 文件名和 OCR 都无法判定时返回待人工选择，不写入历史记录', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0001.jpg', platform: PF,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('无关文字')
    });
    assert.strictEqual(result.needsManualPick, true);
    assert.ok(result.pendingId);
    assert.strictEqual(store.records.length, 0);
  });

  await tAsync('resolvePending 用人工选择的产品完成判定并写入历史，记录带正确的 platform', async () => {
    const store = await freshStore();
    await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0001.jpg', platform: PF,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX')
    });
    // 用一段两个产品都不命中的文字，强迫走人工选择路径
    const ambiguousPending = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0002.jpg', platform: PF,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('完全无关的文字')
    });
    const resolved = await store.resolvePending(ambiguousPending.pendingId, 'pa', 'li');
    assert.strictEqual(resolved.matchMethod, 'manual');
    assert.strictEqual(resolved.productId, 'pa');
    assert.strictEqual(resolved.platform, PF);
    assert.strictEqual(store.records.length, 2); // pending 本身没落库，resolvePending 后 + 上面那条 filename 判定的
  });

  await tAsync('detectFile 整体识别置信度低时转人工核对，即便文件名本可判定产品', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg', platform: PF,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX', 0.4)
    });
    assert.strictEqual(result.needsManualPick, true);
    assert.strictEqual(result.lowConfidence, true);
    assert.strictEqual(store.records.length, 0); // 待人工核对不落历史记录，跟其它 pending 情况一致
  });

  await tAsync('resolvePending 完成判定后记录里带着识别置信度', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg', platform: PF,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX 7天无理由退换', 0.93)
    });
    assert.ok(Math.abs(result.ocrConfidence - 0.93) < 1e-9);
  });

  await tAsync('resolvePending 对不存在的 pendingId 抛出错误', async () => {
    const store = await freshStore();
    await assert.rejects(store.resolvePending('mcp_不存在', 'pa', 'li'), /过期|不存在/);
  });

  await tAsync('detectFile 串词时标注来源产品，判定为报错状态', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg', platform: PF,
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX GCX XE')
    });
    assert.strictEqual(result.status, 'error');
    assert.strictEqual(result.crossedKeywords[0].fromProductName, 'GCX XE');
  });

  await tAsync('listRecords 按产品和状态过滤，最新的排最前', async () => {
    const store = await freshStore();
    await store.detectFile({ buf: Buffer.from('1'), ext: '.jpg', filename: 'GC-Multi_a.jpg', platform: PF, batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX') });
    await store.detectFile({ buf: Buffer.from('2'), ext: '.jpg', filename: 'GC-Multi_b.jpg', platform: PF, batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi') });
    const passOnly = store.listRecords({ productId: 'pa', status: 'pass' });
    assert.strictEqual(passOnly.length, 1);
    assert.strictEqual(passOnly[0].filename, 'GC-Multi_a.jpg');
  });

  await tAsync('listRecords 按平台过滤', async () => {
    const store = await freshStore();
    await store.saveProducts('jd', [{ id: 'pj', name: '京东产品', keywords: ['京东词'] }], []);
    await store.detectFile({ buf: Buffer.from('1'), ext: '.jpg', filename: 'GC-Multi_a.jpg', platform: 'tmall', batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX') });
    await store.detectFile({ buf: Buffer.from('2'), ext: '.jpg', filename: '京东产品_a.jpg', platform: 'jd', batchId: 'b2', uploadedBy: 'li', ocr: stubOcr('京东词') });
    assert.strictEqual(store.listRecords({ platform: 'tmall' }).length, 1);
    assert.strictEqual(store.listRecords({ platform: 'jd' }).length, 1);
    assert.strictEqual(store.listRecords({}).length, 2);
  });

  await tAsync('detectFile 服务端 OCR 并发受限于设定上限', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const store = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'), { ocrConcurrency: 1 });
    await store.load();
    await store.saveProducts(PF, [{ id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi'] }], []);

    let active = 0, maxActive = 0;
    const controlledOcr = () => new Promise((resolve) => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => { active--; resolve({ text: 'GC-Multi', confidence: 1 }); }, 20);
    });

    await Promise.all([
      store.detectFile({ buf: Buffer.from('1'), ext: '.jpg', filename: 'GC-Multi_a.jpg', platform: PF, batchId: 'b1', uploadedBy: 'li', ocr: controlledOcr }),
      store.detectFile({ buf: Buffer.from('2'), ext: '.jpg', filename: 'GC-Multi_b.jpg', platform: PF, batchId: 'b1', uploadedBy: 'li', ocr: controlledOcr }),
      store.detectFile({ buf: Buffer.from('3'), ext: '.jpg', filename: 'GC-Multi_c.jpg', platform: PF, batchId: 'b1', uploadedBy: 'li', ocr: controlledOcr })
    ]);

    assert.strictEqual(maxActive, 1);
  });

  await tAsync('saveProducts 拒绝产品名为空的库并保留原有数据', async () => {
    const store = await freshStore();
    await assert.rejects(
      store.saveProducts(PF, [{ id: 'pa', name: '   ', keywords: ['GC-Multi'] }, { id: 'pb', name: 'GCX XE', keywords: ['静音悬浮马达'] }], []),
      /产品名称不能为空/
    );
    assert.strictEqual(store.getLibrary(PF).products.length, 2); // 拒绝后没有把坏数据写进去
  });

  await tAsync('load() 能重新读回持久化的数据', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const store1 = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store1.load();
    await store1.saveProducts(PF, [{ id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi'] }], []);
    await store1.detectFile({ buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi.jpg', platform: PF, batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi') });

    const store2 = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store2.load();
    assert.strictEqual(store2.getLibrary(PF).products.length, 1);
    assert.strictEqual(store2.records.length, 1);
  });

  await tAsync('load() 自动把旧版扁平结构的 products.json 迁移到天猫命名空间下', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const mcDir = path.join(dir, 'materialcheck');
    await fsp.mkdir(mcDir, { recursive: true });
    await fsp.writeFile(path.join(mcDir, 'products.json'), JSON.stringify({
      products: [{ id: 'old1', name: '旧产品', keywords: ['旧关键词'] }],
      universalKeywords: ['旧通用词']
    }));

    const store = new MaterialCheckStore(mcDir, path.join(dir, 'uploads'));
    await store.load();
    assert.strictEqual(store.getLibrary('tmall').products.length, 1);
    assert.strictEqual(store.getLibrary('tmall').products[0].name, '旧产品');
    assert.deepStrictEqual(store.getLibrary('tmall').universalKeywords, ['旧通用词']);
    assert.strictEqual(store.getLibrary('jd').products.length, 0);

    // 迁移后落盘为新格式，重新 load 应该直接读到新格式，不再重复触发迁移逻辑
    const raw = JSON.parse(await fsp.readFile(path.join(mcDir, 'products.json'), 'utf8'));
    assert.ok(raw.tmall && raw.jd);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
