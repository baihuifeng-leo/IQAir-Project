'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const js = fs.readFileSync('public/report.js', 'utf8');
const slides = fs.readFileSync('public/report-slides.js', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');

// 页面目录必须由同一份持久化排序驱动，拖动后编辑与放映翻页才不会分叉。
assert.match(js, /const FIXED_REPORT_PAGES/);
assert.match(js, /function reportPages\(\)/);
assert.match(js, /function reorderReportPage\(sourceId, targetId\)/);
assert.match(js, /ReportSlides\.savePageOrder\(data\.pageOrder\)/);
assert.match(js, /wrap\.draggable = !presenting/);
assert.match(js, /dragstart/);
assert.match(js, /drop/);

// 编辑全屏是画布编辑能力，不应切换到只读的放映模式。
assert.match(slides, /toggleEditFullscreen, fullscreen \? '退出全屏编辑' : '放大当前画布进行编辑'/);
assert.match(slides, /function toggleEditFullscreen\(\)/);
assert.match(slides, /fullscreenchange/);
// 画布会在空白处点击时重渲染；全屏根必须是稳定的宿主容器，不能是会被替换的 shell。
assert.match(slides, /const fullscreenTarget = host/);
assert.match(slides, /enter\.call\(fullscreenTarget\)/);
assert.doesNotMatch(slides, /const shell = host\?\.querySelector\('\.rs-shell'\)/);
assert.match(css, /\.rpt-page-custom:fullscreen\s*,/);

// 导航条必须从编辑器的实时页集合读取：重命名、新增、删除后不能等待刷新接口。
// 若移除编辑器对当前 pages 的公开读取能力，本用例会失败。
const slideContext = {
  setTimeout: () => 1,
  clearTimeout: () => {},
  window: { addEventListener: () => {} },
  document: { addEventListener: () => {}, querySelector: () => null }
};
slideContext.globalThis = slideContext;
vm.runInNewContext(`${slides}; globalThis.ReportSlidesForTest = ReportSlides;`, slideContext);
const liveSlides = slideContext.ReportSlidesForTest;
liveSlides.init({ uid: (prefix) => `${prefix}new`, toast: () => {} });
liveSlides.setPages([{ id: 'weekly', name: '原始名称', title: '原始标题', elements: [] }]);
liveSlides.renamePage('weekly', '实时名称');
const created = liveSlides.addPage();
liveSlides.deletePage('weekly');
assert.deepStrictEqual(JSON.parse(JSON.stringify(liveSlides.getPages())), [{ id: created.id, name: '', title: '未命名页面', elements: [] }], '导航条应能读取新增、重命名和删除后的实时页集合');
console.log('✓ report pages keep drag order and editor fullscreen controls');
