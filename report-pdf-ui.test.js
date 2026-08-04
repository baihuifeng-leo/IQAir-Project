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
assert.doesNotMatch(css, /#rpt-pdf-pages > \.rpt-page \{[\s\S]*?overflow: hidden; page: rptpdf/, '放映页不能在固定 720px 高度下直接裁切内容');
assert.match(js, /function fitPdfPages\(\)/, '固定报告页应按自身内容高度等比适配打印画布');
assert.match(js, /720 \/ Math\.max\(1, content\.scrollHeight\)/, 'PDF 内容缩放比例必须由实际溢出高度决定');
assert.doesNotMatch(css, /\.rpt-pdf-fit-content \{[^}]*transform: scale\(/, 'PDF 打印内容不能使用 transform 缩放，避免浏览器将整页栅格化为模糊虚影');
assert.match(js, /content\.style\.zoom = String\(scale\)/, 'PDF 必须用原生布局缩放而非合成层缩放');
assert.match(css, /\.rpt-pdf-fit-content \{[^}]*zoom: var\(--rpt-pdf-scale\)/, 'PDF 内容应通过 zoom 保持文字与矢量图清晰');
assert.doesNotMatch(css, /#rpt-page-[12] > \.rpt-sec-first/, 'PDF 包装层不能破坏第 1、2 页的放映布局选择器');
assert.match(html, /class="sheet rpt-rename-page-sheet"/, '重命名弹窗需要专用布局类');
assert.match(html, /class="sheet-head"><h2 id="rpt-rename-page-title"/, '重命名弹窗必须使用标准标题区');

console.log('✓ report PDF export and rename dialog structure are present');
