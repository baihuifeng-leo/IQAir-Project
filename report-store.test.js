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
  await t('共享报告账户读写同一份个人报告', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rs-shared-'));
    const s = new ReportStore(dir, (userId) => userId === 'u_leo' ? 'u_admin' : userId);
    await s.slidesSave('u_admin', [{ id: 'shared-page', name: '共同周报', elements: [] }]);
    assert.strictEqual((await s.summary('u_leo')).slides[0].name, '共同周报');
    await s.weimengSave('u_leo', { weekStart: '2026-08-10', pageviews: 88, channels: {} });
    assert.strictEqual((await s.summary('u_admin')).weimeng[0].pageviews, 88);
    await fsp.rm(dir, { recursive: true, force: true });
  });
  await t('slidesSave 保存并可读回', async () => {
    const s = await freshStore();
    await s.slidesSave('u1', [{ id: 'pg_1', name: '市场复盘', title: '详情页改版', elements: [{ id: 'el_1', type: 'text', x: 1, y: 2, w: 100, h: 30, z: 1, text: '你好' }] }]);
    assert.strictEqual((await s.summary('u1')).slides[0].elements[0].text, '你好');
    assert.strictEqual((await s.summary('u1')).slides[0].name, '市场复盘');
    assert.strictEqual((await s.summary('u1')).slides[0].title, '详情页改版');
  });
  await t('slidesSave 保留图片完整显示与原图预览设置', async () => {
    const s = await freshStore();
    await s.slidesSave('u1', [{ id: 'pg_1', elements: [{ id: 'img_1', type: 'image', x: 1, y: 2, w: 100, h: 30, z: 1, url: '/uploads/filter-detail.png', fit: 'contain', preview: true, previewTitle: '旧版详情页 · 原图' }] }]);
    const image = (await s.summary('u1')).slides[0].elements[0];
    assert.strictEqual(image.fit, 'contain');
    assert.strictEqual(image.preview, true);
    assert.strictEqual(image.previewTitle, '旧版详情页 · 原图');
  });
  await t('slidesSave 保留形状元素的样式并校验非法值', async () => {
    const s = await freshStore();
    await s.slidesSave('u1', [{ id: 'pg_1', elements: [
      { id: 'sh_1', type: 'shape', shapeType: 'ellipse', x: 1, y: 2, w: 100, h: 60, z: 1, fill: '#4ee0c1', stroke: '#1f9e85', strokeWidth: 3 },
      { id: 'sh_2', type: 'shape', shapeType: 'not-a-real-type', x: 1, y: 2, w: 100, h: 20, z: 2, fill: 'javascript:alert(1)', stroke: '#zzz', strokeWidth: 999 }
    ] }]);
    const [ellipse, fallback] = (await s.summary('u1')).slides[0].elements;
    assert.strictEqual(ellipse.shapeType, 'ellipse');
    assert.strictEqual(ellipse.fill, '#4ee0c1');
    assert.strictEqual(ellipse.stroke, '#1f9e85');
    assert.strictEqual(ellipse.strokeWidth, 3);
    assert.strictEqual(fallback.shapeType, 'rect', '非法 shapeType 应回退成矩形');
    assert.strictEqual(fallback.fill, null, '非法/非十六进制颜色值应被丢弃');
    assert.strictEqual(fallback.stroke, null);
    assert.strictEqual(fallback.strokeWidth, 40, '边框粗细应夹到上限');
  });
  await t('slidesSave 直线形状不保留填充色', async () => {
    const s = await freshStore();
    await s.slidesSave('u1', [{ id: 'pg_1', elements: [
      { id: 'sh_1', type: 'shape', shapeType: 'line', x: 1, y: 2, w: 200, h: 20, z: 1, fill: '#4ee0c1', stroke: '#1f9e85', strokeWidth: 4 }
    ] }]);
    const line = (await s.summary('u1')).slides[0].elements[0];
    assert.strictEqual(line.fill, null, '直线形状不应该有填充色');
    assert.strictEqual(line.stroke, '#1f9e85');
  });
  await t('slidesSave 是整份覆盖', async () => {
    const s = await freshStore(); await s.slidesSave('u1', [{ id: 'a', elements: [] }, { id: 'b', elements: [] }]);
    await s.slidesSave('u1', [{ id: 'a', elements: [] }]);
    assert.strictEqual((await s.summary('u1')).slides.length, 1);
  });
  await t('页面顺序与自定义页一起保存，并在普通编辑保存时保留', async () => {
    const s = await freshStore();
    await s.slidesSave('u1', [{ id: 'a', elements: [] }], ['news', 'a', 'business', 'weimeng']);
    await s.slidesSave('u1', [{ id: 'a', elements: [] }, { id: 'b', elements: [] }]);
    assert.deepStrictEqual((await s.summary('u1')).pageOrder, ['news', 'a', 'business', 'weimeng']);
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
  await t('周报档案冻结正式版，并可创建独立修订版', async () => {
    const s = await freshStore();
    await s.slidesSave('u1', [{ id: 'a', name: '原始页', elements: [] }], ['business', 'a']);
    const archived = await s.archiveCreate('u1', '2026-07-27', { weekStart: '2026-07-27', pages: { global: [{ title: '新闻' }] } });
    assert.equal(archived.version.number, 1);
    assert.equal(archived.version.snapshot.report.slideMasterVersion, 1, '新归档必须冻结当前母版版本');
    assert.deepStrictEqual((await s.summary('u1')).slides, [], '归档后实时报告应移除自定义页');
    assert.deepStrictEqual((await s.summary('u1')).pageOrder, [], '归档后实时报告应回到系统页顺序');
    await s.slidesSave('u1', [{ id: 'a', name: '实时页已修改', elements: [] }]);
    const frozen = await s.archiveGet('u1', '2026-07-27');
    assert.equal(frozen.version.snapshot.report.slides[0].name, '原始页');
    const revision = await s.archiveRevision('u1', '2026-07-27', frozen.version.id);
    revision.version.snapshot.report.slides[0].name = '修订页';
    await s.archiveSave('u1', '2026-07-27', revision.version.id, revision.version.snapshot);
    assert.equal((await s.archiveGet('u1', '2026-07-27', frozen.version.id)).version.snapshot.report.slides[0].name, '原始页');
    assert.equal((await s.archiveGet('u1', '2026-07-27', revision.version.id)).version.snapshot.report.slides[0].name, '修订页');
    await s.archiveSetOfficial('u1', '2026-07-27', revision.version.id);
    const list = await s.archives('u1');
    assert.equal(list[0].versions.find((item) => item.id === revision.version.id).isOfficial, true);
  });
  console.log(`\n${pass} passed, ${fail} failed`); process.exitCode = fail ? 1 : 0;
}
run();
