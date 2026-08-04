'use strict';

const assert = require('assert');
const fs = require('fs');

const js = fs.readFileSync('public/report.js', 'utf8');
const slides = fs.readFileSync('public/report-slides.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');

assert.match(html, /id="rpt-export-pdf-btn"/, '个人报告标题栏应有导出 PDF 入口');
assert.match(js, /function pdfFilename\(date = new Date\(\)\)/, '文件名必须随当前日期生成');
assert.match(js, /FY\$\{String\(year\)\.slice\(-2\)\} Q\$\{quarter\}W\$\{String\(week\)\.padStart\(2, '0'\)\}-Weekly Meeting/, 'PDF 文件名应包含财年、季度和周次');
assert.match(js, /function preparePdfPages\(\)/, '导出必须按报告页面顺序准备内容');
assert.match(js, /ReportSlides\.buildPrintPage\(item\.id\)/, '自定义页必须进入导出 PDF');
assert.match(js, /window\.print\(\)/, '导出应调起浏览器 PDF 保存流程');
assert.match(slides, /function buildPrintPage\(id\)/, '自定义页应可生成静态打印画布');
assert.match(css, /@page rptpdf \{ size: 13\.333in 7\.5in; margin: 0; \}/, 'PDF 应使用 PowerPoint 默认宽屏纸张');
assert.match(html, /class="sheet rpt-rename-page-sheet"/, '重命名弹窗需要专用布局类');
assert.match(html, /class="sheet-head"><h2 id="rpt-rename-page-title"/, '重命名弹窗必须使用标准标题区');

console.log('✓ report PDF export and rename dialog structure are present');
