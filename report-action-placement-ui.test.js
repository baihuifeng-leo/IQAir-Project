'use strict';

const assert = require('assert');
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const js = fs.readFileSync('public/report.js', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');

// 导入动作必须归属生意参谋页，并在时间范围控件之上；微盟只保留一个可选周的编辑入口。
const pageOne = html.slice(html.indexOf('id="rpt-page-1"'), html.indexOf('id="rpt-page-2"'));
assert.match(pageOne, /id="rpt-import-btn"[\s\S]*id="rpt-range-tabs"/);
assert.doesNotMatch(html, /id="rpt-weimeng-btn"/);
assert.match(html, /id="rpt-wm-edit-btn">新增 \/ 编辑该周数据</);
assert.doesNotMatch(js, /rpt-weimeng-btn/);
assert.match(css, /\.rpt-range > \.solid\s*\{[^}]*width:\s*auto/);
assert.match(pageOne, /class="rpt-range-controls">[\s\S]*id="rpt-range-tabs"[\s\S]*id="rpt-range-custom"/);
assert.match(css, /\.rpt-range-controls\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*nowrap/);

console.log('✓ report actions are placed with their owning data pages');
