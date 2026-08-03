'use strict';
const assert = require('assert');
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const js = fs.readFileSync('public/report.js', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');

assert.match(html, /id="rpt-wm-trend"/);
assert.match(js, /function renderWeimengTrend\(weeks\)/);
assert.match(js, /name: label/);
assert.match(js, /channels\?\.?\[key\]\?\.pv/);
assert.match(js, /wmChart\.setOption/);
assert.doesNotMatch(js, /title:\s*\{ text: '三渠道流量趋势'/);
assert.match(js, /areaStyle:/);
assert.match(css, /\.rpt-wm-trend\s*\{/);
assert.match(css, /body\.rpt-presenting \.rpt-wm-trend\s*\{/);
assert.match(css, /\.rpt-wm-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(4,/);
assert.match(css, /body\.rpt-presenting \.rpt-wm-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(8,/);
console.log('✓ weimeng channel traffic trend is wired into the report');
