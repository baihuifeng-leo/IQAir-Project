'use strict';

// 自定义页的文字编辑必须走原生 textarea：输入值由 value/input 驱动，
// 不受画布元素的拖拽、选中事件影响。这个检查锁住编辑器的实际渲染路径。
const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync(require.resolve('./public/report-slides.js'), 'utf8');

assert.match(source, /const isEditing = editingId === el\.id;[\s\S]*?document\.createElement\(isEditing \? 'textarea' : 'div'\)/, '编辑中的文字元素应渲染为 textarea');
assert.match(source, /box\.addEventListener\('input',[\s\S]*?el\.text\s*=\s*box\.value/, 'textarea 输入必须立即写回页面数据');
assert.match(source, /mkBtn\('编辑文字',\s*\(\)\s*=>\s*enterTextEdit\(el\)\)/, '选中文字后必须提供明确的编辑入口');
assert.match(source, /document\.addEventListener\('paste', pasteImage\)/, '自定义页必须监听剪贴板粘贴图片');
assert.match(source, /A\.uploadImageFile\(file\)/, '剪贴板图片必须走原图直传上传链路');
assert.match(source, /\(W - 120\) \/ nw, contentHeight \/ nh/, '图片初始尺寸必须在正文安全区内保持原图适配');
assert.match(source, /function setPageActions\(actions\)/, '自定义页工具条应支持页面级动作');
assert.match(source, /rs-toolbar-page-actions/, '重命名和删除应渲染在自定义页工具条右侧');

console.log('✓ 自定义页文字编辑器使用可输入且可保存的 textarea');
