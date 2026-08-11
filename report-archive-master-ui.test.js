'use strict';
const assert = require('assert');
const fs = require('fs');

const slides = fs.readFileSync('public/report-slides.js', 'utf8');
const report = fs.readFileSync('public/report.js', 'utf8');

assert.match(slides, /masterVersion = 1/, '自定义页渲染器必须维护母版版本');
assert.match(slides, /function setMasterVersion\(value\)/, '渲染器必须允许报告视图传入冻结的母版版本');
assert.match(slides, /if \(masterVersion > 0\) canvas\.appendChild\(buildSlideMaster/, '版本 0 的历史档案不能叠加母版层');
assert.match(report, /ReportSlides\.setMasterVersion\(data\?\.slideMasterVersion \?\? 1\)/, '当前报告应使用当前母版版本');
assert.match(report, /ReportSlides\.setMasterVersion\(data\.slideMasterVersion \?\? 0\)/, '旧档案缺少版本时必须按无母版显示');

console.log('✓ archived custom slides render only their frozen master version');
