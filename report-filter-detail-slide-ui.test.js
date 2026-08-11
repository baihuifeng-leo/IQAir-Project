'use strict';

// 第五页的长图和模块图在画布中必须完整呈现，并能在放映时点开原图；
// 导出的静态页只保留完整比例图片，不携带任何交互控件。
const assert = require('assert');
const fs = require('fs');

const slides = fs.readFileSync(require.resolve('./public/report-slides.js'), 'utf8');
const css = fs.readFileSync(require.resolve('./public/styles.css'), 'utf8');

assert.match(slides, /img\.classList\.toggle\('contain', el\.fit === 'contain'\)/, '自定义页图片应支持完整比例显示');
assert.match(slides, /if \(el\.preview\)[\s\S]*?A\.lightbox\(el\.url, el\.previewTitle \|\| '查看原图'\)/, '标记为预览的素材应使用现有原图查看浮窗');
assert.match(slides, /presenting \? 'click' : 'dblclick'/, '放映时单击查看，编辑时双击查看，避免干扰编辑选择');
assert.match(slides, /buildPrintPage\(id\)[\s\S]*?img\.classList\.toggle\('contain', el\.fit === 'contain'\)/, 'PDF 静态页也要保留素材完整比例');
assert.match(css, /\.rs-image\.contain\s*\{[^}]*object-fit:\s*contain/, '完整比例图片必须由专用样式控制');
assert.match(css, /\.rs-previewable\s*\{[^}]*cursor:\s*zoom-in/, '可查看原图的素材应有明确的放大指针');

console.log('✓ filter detail slide keeps complete images and opens source previews');
