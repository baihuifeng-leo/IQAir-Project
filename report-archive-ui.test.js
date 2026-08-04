'use strict';
const assert = require('assert');
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const js = fs.readFileSync('public/report.js', 'utf8');
const slides = fs.readFileSync('public/report-slides.js', 'utf8');

assert.match(html, /id="rpt-archive-btn"/, '个人报告标题栏应有周报档案入口');
assert.match(html, /id="rpt-archive-mask"/, '档案应使用可关闭的抽屉');
assert.match(js, /\/api\/reports\/personal\/archive\/create/, '前端应能创建周报归档');
assert.match(js, /\/api\/reports\/personal\/archive\/revision/, '前端应能创建历史修订版');
assert.match(js, /\/api\/reports\/personal\/archive\/official/, '前端应能设定正式版');
assert.match(js, /当前报告已还原为三个系统页/, '归档后应回到新的三页系统报告');
assert.match(js, /textContent = '删除'/, '自定义页应提供可见的删除动作');
assert.match(js, /archiveView \? new Date\(`\$\{archiveView\.weekStart\}T00:00:00`\)/, '历史 PDF 文件名应使用档案周');
assert.match(slides, /function setEditable\(value\)/, '正式档案应能让自定义页进入只读态');
assert.match(slides, /if \(presenting \|\| readOnly\) return/, '只读档案不应触发自定义页保存');
console.log('✓ report archive UI is wired for snapshot, revision, and weekly export');
