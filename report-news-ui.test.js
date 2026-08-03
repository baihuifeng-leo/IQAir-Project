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
assert.match(css, /body\.rpt-presenting \.rpt-news-page\s*\{[^}]*overflow:\s*hidden/);
assert.match(css, /body\.rpt-presenting \.rpt-news-body\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/);
assert.match(js, /A\.lightbox\(card\.imageUrl/);
assert.doesNotMatch(js, /imageLink\.href\s*=\s*card\.url/);
// 放映封面并非一律上图下文：竖图必须切换为左右布局，且正文不会被原文区挤出。
assert.match(js, /classifyNewsImage\(article, img\)/);
assert.match(css, /body\.rpt-presenting \.rpt-news-card\.image-portrait\s*\{[^}]*grid-template-columns:/);
assert.match(css, /body\.rpt-presenting \.rpt-news-card\.image-portrait\s*\{[^}]*grid-template-rows:\s*1fr/);
assert.match(css, /body\.rpt-presenting \.rpt-news-meta\s*\{[^}]*margin-top:\s*clamp\(12px,\s*1\.5vh,\s*22px\)/);
// 两则新闻共享同一张演示页高度；横图正文应在剩余空间中居中且使用更大的汇报字号。
assert.match(css, /body\.rpt-presenting \.rpt-news-grid\s*\{[^}]*align-items:\s*stretch/);
assert.match(css, /body\.rpt-presenting \.rpt-news-grid > \.rpt-news-card\s*\{[^}]*height:\s*100%/);
assert.match(css, /body\.rpt-presenting \.rpt-news-card\.image-wide \.rpt-news-body\s*\{[^}]*justify-content:\s*center/);
assert.match(css, /body\.rpt-presenting \.rpt-news-card\.image-portrait \.rpt-news-summary\s*\{[^}]*font-size:/);
// 放映页以摘要为主叙事，不再用三行上限产生“...”省略；彩色三条要点仍需保留。
assert.match(css, /body\.rpt-presenting \.rpt-news-summary\s*\{[^}]*display:\s*block/);
assert.doesNotMatch(css, /body\.rpt-presenting \.rpt-news-summary\s*\{[^}]*-webkit-line-clamp/);
assert.match(css, /body\.rpt-presenting \.rpt-news-bullets\s*\{[^}]*display:\s*grid/);
assert.match(css, /body\.rpt-presenting \.rpt-news-bullets\s*\{[^}]*margin-top:\s*clamp/);
console.log('✓ report-news picker remains closeable and compact');
