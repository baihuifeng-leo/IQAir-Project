'use strict';
const assert = require('assert');
const fs = require('fs');
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
assert.match(css, /\.rs-shell:fullscreen\s*,/);
console.log('✓ report pages keep drag order and editor fullscreen controls');
