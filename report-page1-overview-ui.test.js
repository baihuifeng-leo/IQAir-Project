'use strict';

const assert = require('assert');
const fs = require('fs');
const js = fs.readFileSync('public/report.js', 'utf8');

// 防止放映汇报只保留首页口径结论而漏掉店铺整体的浏览/访客变化。
assert.match(js, /function buildShopOverview\(curLabel, rows, previousRows\)/);
assert.match(js, /shopPageviews/);
assert.match(js, /shopVisitors/);
assert.match(js, /buildShopOverview\(curLabel, thisWeek, lastWeek\)/);
assert.match(js, /highlightEl\.textContent = overview \? `\$\{overview\} \$\{text\}` : text/);

console.log('✓ presentation summary leads with whole-shop browsing and visitor changes');
