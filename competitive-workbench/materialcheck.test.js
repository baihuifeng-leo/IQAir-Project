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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
