'use strict';

// 自定义页的文字编辑必须走原生 textarea：输入值由 value/input 驱动，
// 不受画布元素的拖拽、选中事件影响。这个检查锁住编辑器的实际渲染路径。
const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync(require.resolve('./public/report-slides.js'), 'utf8');

assert.match(source, /const isEditing = editingId === el\.id;[\s\S]*?document\.createElement\(isEditing \? 'textarea' : 'div'\)/, '编辑中的文字元素应渲染为 textarea');
assert.match(source, /box\.addEventListener\('input',[\s\S]*?el\.text\s*=\s*box\.value/, 'textarea 输入必须立即写回页面数据');
assert.match(source, /mkBtn\('编辑文字',\s*\(\)\s*=>\s*enterTextEdit\(el\)\)/, '选中文字后必须提供明确的编辑入口');

console.log('✓ 自定义页文字编辑器使用可输入且可保存的 textarea');
