'use strict';

// 自定义页 PPT 化升级：画布自适应缩放 + 形状/符号/复制/居中/键盘操作。
// 跟 report-slides-editing.test.js 一样是静态结构契约测试（这个仓库前端没有测试框架/jsdom）。
const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync(require.resolve('./public/report-slides.js'), 'utf8');

// 画布自适应：不能只靠 window resize（Ctrl+滚轮缩放等场景不一定派发该事件），
// 必须用 ResizeObserver 直接盯着容器盒子。
assert.match(source, /new ResizeObserver\(scaleCanvas\)/, '必须用 ResizeObserver 监听画布容器尺寸变化');
assert.match(source, /resizeObserver\.observe\(host\)/, 'ResizeObserver 必须观察画布宿主容器');

// 形状：矩形/椭圆/直线，带填充色、边框色、边框粗细
assert.match(source, /SHAPE_TYPES = \[\['rect', '矩形'\], \['ellipse', '椭圆'\], \['line', '直线'\]\]/, '形状类型必须是矩形/椭圆/直线');
assert.match(source, /function addShapeElement\(shapeType\)/, '必须提供插入形状的函数');
assert.match(source, /el\.type === 'shape'/, '元素渲染必须处理 shape 类型');
assert.match(source, /function startShapeResize\(/, '矩形/椭圆必须支持自由拉伸（不锁定宽高比）');
assert.match(source, /function startLineResize\(/, '直线必须支持独立的拉伸逻辑');
assert.doesNotMatch(source.match(/function startShapeResize\([\s\S]*?\n  \}/)[0], /ratio/, '形状拉伸不应像图片一样锁定宽高比');

// 符号：复用文字元素而不是新建一套渲染逻辑，保持零依赖
assert.match(source, /function addSymbolElement\(symbol\)/, '必须提供插入符号的函数');
assert.match(source, /addSymbolElement[\s\S]*?type: 'text'/, '符号应该复用文字元素（颜色/字号/拖拽都能直接用）');

// 常用 PPT 操作：复制、水平/垂直居中、Delete 删除、方向键微调、Ctrl/Cmd+D 复制
assert.match(source, /function duplicateSelected\(/, '必须支持复制选中元素');
assert.match(source, /function centerHorizontal\(/, '必须支持水平居中');
assert.match(source, /function centerVertical\(/, '必须支持垂直居中');
assert.match(source, /function onKeydown\(e\)/, '必须提供键盘快捷操作入口');
assert.match(source, /e\.key === 'Delete' \|\| e\.key === 'Backspace'/, 'Delete/Backspace 应该删除选中元素');
assert.match(source, /e\.key\.toLowerCase\(\) === 'd'/, 'Ctrl/Cmd+D 应该复制选中元素');
assert.match(source, /e\.key === 'ArrowLeft'/, '方向键应该微调选中元素位置');
assert.match(source, /document\.addEventListener\('keydown', onKeydown\)/, '必须挂载键盘事件监听');

// 打印/导出（PDF）路径不能漏画形状，否则周报导出后形状会消失
assert.match(source, /function buildPrintPage\(id\)[\s\S]*?el\.type === 'shape'[\s\S]*?buildShapeNode\(el\)/, 'PDF 导出路径必须渲染形状元素，不能只处理文字和图片');

console.log('✓ 自定义页 PPT 编辑器：画布自适应、形状/符号、复制/居中/键盘操作均已接入');
