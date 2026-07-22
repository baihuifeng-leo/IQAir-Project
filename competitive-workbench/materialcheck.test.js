const assert = require('assert');
const { runOcr, checkAvailable } = require('./materialcheck-ocr.js');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '-', e.message); }
};
const tAsync = async (name, fn) => {
  try { await fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '-', e.message); }
};

// 模拟 convert + tesseract 两个外部命令的桩函数：按 cmd 名字分流，
// tesseract 按 --psm 后面的值返回不同文字，方便断言"取并集"的行为。
function makeStubExec({ convertOk = true, psmResults = {} } = {}) {
  const calls = [];
  const exec = (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    if (cmd === 'convert') {
      if (!convertOk) return cb(new Error('convert 不存在'), '', 'command not found');
      return cb(null, '', '');
    }
    if (cmd === 'tesseract') {
      const psm = args[args.indexOf('--psm') + 1];
      const result = psmResults[psm];
      if (result && result.fail) return cb(new Error('spawn failed'), '', result.stderr || '识别失败');
      return cb(null, (result && result.text) || '', '');
    }
    cb(new Error('未知命令 ' + cmd));
  };
  return { exec, calls };
}

async function run() {
  // ── materialcheck-ocr.js ──────────────────────────────
  await tAsync('runOcr 先预处理图片，再用默认三个 PSM 各跑一次取并集', async () => {
    const { exec, calls } = makeStubExec({
      psmResults: { 3: { text: 'A段文字' }, 6: { text: 'B段文字' }, 11: { text: 'C段文字' } }
    });
    const text = await runOcr('/tmp/x.jpg', { exec });
    assert.strictEqual(calls[0].cmd, 'convert');
    const preprocessedPath = calls[0].args[calls[0].args.length - 1];
    const tesseractCalls = calls.filter((c) => c.cmd === 'tesseract');
    assert.deepStrictEqual(tesseractCalls.map((c) => c.args[c.args.indexOf('--psm') + 1]), ['3', '6', '11']);
    tesseractCalls.forEach((c) => assert.strictEqual(c.args[0], preprocessedPath));
    assert.ok(text.includes('A段文字') && text.includes('B段文字') && text.includes('C段文字'));
  });

  await tAsync('runOcr 预处理失败时退回用原图识别，不阻断', async () => {
    const { exec, calls } = makeStubExec({ convertOk: false, psmResults: { 3: { text: 'x' }, 6: { text: 'x' }, 11: { text: 'x' } } });
    const text = await runOcr('/tmp/x.jpg', { exec });
    const tesseractCalls = calls.filter((c) => c.cmd === 'tesseract');
    tesseractCalls.forEach((c) => assert.strictEqual(c.args[0], '/tmp/x.jpg'));
    assert.strictEqual(text, 'x\nx\nx');
  });

  await tAsync('runOcr 部分 PSM 失败时仍返回成功那些的并集', async () => {
    const { exec } = makeStubExec({
      psmResults: { 3: { text: '成功的文字' }, 6: { fail: true }, 11: { text: '也成功' } }
    });
    const text = await runOcr('/tmp/x.jpg', { exec });
    assert.ok(text.includes('成功的文字') && text.includes('也成功'));
  });

  await tAsync('runOcr 全部 PSM 都失败时 reject 出有意义的错误', async () => {
    const { exec } = makeStubExec({
      psmResults: { 3: { fail: true, stderr: '图片格式不支持' }, 6: { fail: true }, 11: { fail: true } }
    });
    await assert.rejects(runOcr('/tmp/bad.jpg', { exec }), /OCR 识别失败.*图片格式不支持/);
  });

  await tAsync('runOcr 支持自定义语言参数和自定义 PSM 列表', async () => {
    const { exec, calls } = makeStubExec({ psmResults: { 6: { text: 'text' } } });
    await runOcr('/tmp/x.jpg', { exec, lang: 'eng', psms: ['6'] });
    const tc = calls.filter((c) => c.cmd === 'tesseract');
    assert.strictEqual(tc.length, 1);
    assert.deepStrictEqual(tc[0].args, [calls[0].args[calls[0].args.length - 1], 'stdout', '-l', 'eng', '--psm', '6']);
  });

  await tAsync('checkAvailable tesseract 和 convert 都存在时返回 true', async () => {
    const stubExec = (cmd, args, opts, cb) => cb(null, 'ok', '');
    assert.strictEqual(await checkAvailable({ exec: stubExec }), true);
  });

  await tAsync('checkAvailable tesseract 缺失时返回 false（不抛出，convert 缺不缺不影响这个返回值）', async () => {
    const stubExec = (cmd, args, opts, cb) => cb(new Error('command not found'));
    assert.strictEqual(await checkAvailable({ exec: stubExec }), false);
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

  t('matchAgainstProduct 缺词判定', () => {
    const r = M.matchAgainstProduct('GC-Multi', productA, products);
    assert.deepStrictEqual(r.missingKeywords, ['抗菌滤网认证号XXX']);
    assert.strictEqual(r.status, 'fail');
  });

  t('matchAgainstProduct 串词判定，标注来源产品', () => {
    const r = M.matchAgainstProduct('GC-Multi 抗菌滤网认证号XXX GCX XE', productA, products);
    assert.deepStrictEqual(r.missingKeywords, []);
    assert.strictEqual(r.crossedKeywords.length, 1);
    assert.strictEqual(r.crossedKeywords[0].keyword, 'GCX XE');
    assert.strictEqual(r.crossedKeywords[0].fromProductId, 'pb');
    assert.strictEqual(r.status, 'fail');
  });

  t('matchAgainstProduct 通用词不参与缺词也不参与串词', () => {
    const r = M.matchAgainstProduct('GC-Multi 抗菌滤网认证号XXX', productA, products);
    assert.deepStrictEqual(r.missingKeywords, []);
    assert.deepStrictEqual(r.crossedKeywords, []);
  });

  // ── materialcheck-store.js ────────────────────────────
  const { MaterialCheckStore } = require('./materialcheck-store.js');
  const stubOcr = (text) => async () => text;

  async function freshStore() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const store = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store.load();
    await store.saveProducts(
      [
        { id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi', '抗菌滤网认证号XXX'] },
        { id: 'pb', name: 'GCX XE', keywords: ['GCX XE', '静音悬浮马达'] }
      ],
      ['7天无理由退换']
    );
    return store;
  }

  await tAsync('saveProducts 拒绝重复关键词并保留原有数据', async () => {
    const store = await freshStore();
    await assert.rejects(
      store.saveProducts([{ id: 'pa', name: 'A', keywords: ['同一个词'] }, { id: 'pb', name: 'B', keywords: ['同一个词'] }], []),
      /同一个词/
    );
    assert.strictEqual(store.products.length, 2); // 拒绝后没有把坏数据写进去
  });

  await tAsync('detectFile 文件名可判定时直接产出通过结果', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('fake-image-bytes'), ext: '.jpg', filename: 'GC-Multi_主图.jpg',
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX 7天无理由退换')
    });
    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.productId, 'pa');
    assert.strictEqual(result.matchMethod, 'filename');
    assert.strictEqual(store.records.length, 1);
  });

  await tAsync('detectFile 缺词时判定不通过', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg',
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi')
    });
    assert.strictEqual(result.status, 'fail');
    assert.deepStrictEqual(result.missingKeywords, ['抗菌滤网认证号XXX']);
  });

  await tAsync('detectFile OCR 失败时判定为 ocr_failed', async () => {
    const store = await freshStore();
    const stubOcrFail = () => async () => { throw new Error('识别失败：图片损坏'); };
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0001.jpg',
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcrFail()
    });
    assert.strictEqual(result.status, 'ocr_failed');
    assert.strictEqual(store.records.length, 1);
    assert.strictEqual(store.pending.size, 0);
  });

  await tAsync('detectFile 文件名和 OCR 都无法判定时返回待人工选择，不写入历史记录', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0001.jpg',
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('无关文字')
    });
    assert.strictEqual(result.needsManualPick, true);
    assert.ok(result.pendingId);
    assert.strictEqual(store.records.length, 0);
  });

  await tAsync('resolvePending 用人工选择的产品完成判定并写入历史', async () => {
    const store = await freshStore();
    const pending = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0001.jpg',
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX')
    });
    // 用一段两个产品都不命中的文字，强迫走人工选择路径
    const ambiguousPending = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0002.jpg',
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('完全无关的文字')
    });
    const resolved = await store.resolvePending(ambiguousPending.pendingId, 'pa', 'li');
    assert.strictEqual(resolved.matchMethod, 'manual');
    assert.strictEqual(resolved.productId, 'pa');
    assert.strictEqual(store.records.length, 2); // pending 本身没落库，resolvePending 后 + 上面那条 filename 判定的
  });

  await tAsync('resolvePending 对不存在的 pendingId 抛出错误', async () => {
    const store = await freshStore();
    await assert.rejects(store.resolvePending('mcp_不存在', 'pa', 'li'), /过期|不存在/);
  });

  await tAsync('detectFile 串词时标注来源产品，判定不通过', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg',
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX GCX XE')
    });
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.crossedKeywords[0].fromProductName, 'GCX XE');
  });

  await tAsync('listRecords 按产品和状态过滤，最新的排最前', async () => {
    const store = await freshStore();
    await store.detectFile({ buf: Buffer.from('1'), ext: '.jpg', filename: 'GC-Multi_a.jpg', batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX') });
    await store.detectFile({ buf: Buffer.from('2'), ext: '.jpg', filename: 'GC-Multi_b.jpg', batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi') });
    const passOnly = store.listRecords({ productId: 'pa', status: 'pass' });
    assert.strictEqual(passOnly.length, 1);
    assert.strictEqual(passOnly[0].filename, 'GC-Multi_a.jpg');
  });

  await tAsync('detectFile 服务端 OCR 并发受限于设定上限', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const store = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'), { ocrConcurrency: 1 });
    await store.load();
    await store.saveProducts([{ id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi'] }], []);

    let active = 0, maxActive = 0;
    const controlledOcr = () => new Promise((resolve) => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => { active--; resolve('GC-Multi'); }, 20);
    });

    await Promise.all([
      store.detectFile({ buf: Buffer.from('1'), ext: '.jpg', filename: 'GC-Multi_a.jpg', batchId: 'b1', uploadedBy: 'li', ocr: controlledOcr }),
      store.detectFile({ buf: Buffer.from('2'), ext: '.jpg', filename: 'GC-Multi_b.jpg', batchId: 'b1', uploadedBy: 'li', ocr: controlledOcr }),
      store.detectFile({ buf: Buffer.from('3'), ext: '.jpg', filename: 'GC-Multi_c.jpg', batchId: 'b1', uploadedBy: 'li', ocr: controlledOcr })
    ]);

    assert.strictEqual(maxActive, 1);
  });

  await tAsync('saveProducts 拒绝产品名为空的库并保留原有数据', async () => {
    const store = await freshStore();
    await assert.rejects(
      store.saveProducts([{ id: 'pa', name: '   ', keywords: ['GC-Multi'] }, { id: 'pb', name: 'GCX XE', keywords: ['静音悬浮马达'] }], []),
      /产品名称不能为空/
    );
    assert.strictEqual(store.products.length, 2); // 拒绝后没有把坏数据写进去
  });

  await tAsync('load() 能重新读回持久化的数据', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const store1 = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store1.load();
    await store1.saveProducts([{ id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi'] }], []);
    await store1.detectFile({ buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi.jpg', batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi') });

    const store2 = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store2.load();
    assert.strictEqual(store2.products.length, 1);
    assert.strictEqual(store2.records.length, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
