const assert = require('assert');
const { runOcr, checkAvailable } = require('./materialcheck-ocr.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '-', e.message); }
};
const tAsync = async (name, fn) => {
  try { await fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '-', e.message); }
};

async function run() {
  // ── materialcheck-ocr.js ──────────────────────────────
  await tAsync('runOcr 用正确的命令调用 tesseract', async () => {
    let calledWith = null;
    const stubExec = (cmd, args, opts, cb) => { calledWith = { cmd, args, opts }; cb(null, '识别出的文字\n', ''); };
    const text = await runOcr('/tmp/x.jpg', { exec: stubExec });
    assert.strictEqual(calledWith.cmd, 'tesseract');
    assert.deepStrictEqual(calledWith.args, ['/tmp/x.jpg', 'stdout', '-l', 'chi_sim+eng']);
    assert.strictEqual(text, '识别出的文字');
  });

  await tAsync('runOcr 支持自定义语言参数', async () => {
    let calledWith = null;
    const stubExec = (cmd, args, opts, cb) => { calledWith = { cmd, args }; cb(null, 'text', ''); };
    await runOcr('/tmp/x.jpg', { exec: stubExec, lang: 'eng' });
    assert.deepStrictEqual(calledWith.args, ['/tmp/x.jpg', 'stdout', '-l', 'eng']);
  });

  await tAsync('runOcr 命令失败时 reject 出有意义的错误', async () => {
    const stubExec = (cmd, args, opts, cb) => cb(new Error('spawn failed'), '', '图片格式不支持');
    await assert.rejects(runOcr('/tmp/bad.jpg', { exec: stubExec }), /OCR 识别失败.*图片格式不支持/);
  });

  await tAsync('checkAvailable 二进制存在时返回 true', async () => {
    const stubExec = (cmd, args, opts, cb) => cb(null, 'tesseract 5.3.0', '');
    assert.strictEqual(await checkAvailable({ exec: stubExec }), true);
  });

  await tAsync('checkAvailable 二进制缺失时返回 false（不抛出）', async () => {
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
