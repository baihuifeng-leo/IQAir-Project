'use strict';
const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { ReportStore } = require('./report-store.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '-', e.message); }
}
async function freshStore() { return new ReportStore(await fsp.mkdtemp(path.join(os.tmpdir(), 'rs-test-'))); }

async function run() {
  await t('新用户 summary 返回空 slides 数组', async () => {
    assert.deepStrictEqual((await (await freshStore()).summary('u1')).slides, []);
  });
  await t('slidesSave 保存并可读回', async () => {
    const s = await freshStore();
    await s.slidesSave('u1', [{ id: 'pg_1', elements: [{ id: 'el_1', type: 'text', x: 1, y: 2, w: 100, h: 30, z: 1, text: '你好' }] }]);
    assert.strictEqual((await s.summary('u1')).slides[0].elements[0].text, '你好');
  });
  await t('slidesSave 是整份覆盖', async () => {
    const s = await freshStore(); await s.slidesSave('u1', [{ id: 'a', elements: [] }, { id: 'b', elements: [] }]);
    await s.slidesSave('u1', [{ id: 'a', elements: [] }]);
    assert.strictEqual((await s.summary('u1')).slides.length, 1);
  });
  await t('拒绝非数组和无 id 页面', async () => {
    const s = await freshStore();
    await assert.rejects(s.slidesSave('u1', {}), /数组/);
    await assert.rejects(s.slidesSave('u1', [{ elements: [] }]), /id/);
  });
  await t('丢弃非法元素，不影响合法元素', async () => {
    const s = await freshStore();
    await s.slidesSave('u1', [{ id: 'a', elements: [
      { id: 'ok', type: 'text', x: 0, y: 0, w: 10, h: 10, z: 1 },
      { id: 'bad', type: 'image', x: 0, y: 0, w: 10, h: 10, z: 1, url: 'https://x' }
    ] }]);
    assert.strictEqual((await s.summary('u1')).slides[0].elements.length, 1);
  });
  await t('截断超长文本且不破坏微盟数据', async () => {
    const s = await freshStore();
    await s.weimengSave('u1', { weekStart: '2026-07-20', channels: {} });
    await s.slidesSave('u1', [{ id: 'a', elements: [{ id: 't', type: 'text', x: 0, y: 0, w: 10, h: 10, z: 0, text: 'x'.repeat(5000) }] }]);
    const out = await s.summary('u1');
    assert.strictEqual(out.slides[0].elements[0].text.length, 4000); assert.strictEqual(out.weimeng.length, 1);
  });
  console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
}
run();
