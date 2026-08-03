'use strict';
// 前端零依赖；这里锁住新闻页曾出现过的三个结构性回归，避免只读态、旧按钮
// 通用样式或固定卡高再次悄悄影响到实际操作。
const assert = require('assert');
const fs = require('fs');
const css = fs.readFileSync('public/styles.css', 'utf8');
const js = fs.readFileSync('public/report.js', 'utf8');

assert.match(css, /body\.readonly \.rpt-news-editor \.kill\s*\{[^}]*display:\s*grid\s*!important/);
assert.doesNotMatch(css, /\.rpt-news-card\s*\{[^}]*min-height:\s*400px/);
assert.match(css, /\.rpt-news-editor-actions\s*\{[^}]*flex-wrap:\s*nowrap/);
assert.match(js, /#rpt-news-editor'\)\.addEventListener\('click'/);
assert.match(js, /newsPickerOpen && e\.key === 'Escape'/);
console.log('✓ report-news picker remains closeable and compact');
