'use strict';

// 防止自定义页的母版又退化成可拖动正文元素：新页要有独立标题，
// 旧第四页的顶部素材要被迁走，编辑、放映与 PDF 使用同一套固定母版。
const assert = require('assert');
const fs = require('fs');

const slides = fs.readFileSync(require.resolve('./public/report-slides.js'), 'utf8');
const css = fs.readFileSync(require.resolve('./public/styles.css'), 'utf8');

assert.match(slides, /function migrateSlideMaster\(page\)/, '旧自定义页必须迁移到母版数据模型');
assert.match(slides, /pages\s*=\s*.*\.map\(migrateSlideMaster\)/, '加载页面时必须执行母版迁移');
assert.match(slides, /title:\s*'未命名页面'/, '新建页面必须拥有独立默认标题');
assert.match(slides, /function buildSlideMaster\(page/, '编辑、放映和导出必须共享母版构造器');
assert.match(slides, /canvas\.appendChild\(buildSlideMaster\(page, \{ editable: !presenting && !readOnly \}\)\)/, '编辑画布必须显示固定母版');
assert.match(slides, /canvas\.appendChild\(buildSlideMaster\(page, \{ print: true \}\)\)/, 'PDF 必须使用相同母版');
assert.match(slides, /title\.contentEditable = 'true'/, '标题区必须可直接输入');
assert.match(slides, /page\.title\s*=\s*title\.textContent/, '标题输入必须保存到页面数据');
assert.match(slides, /BODY_TOP = 100/, '正文安全区必须从母版分隔线下方开始');
assert.match(slides, /y:\s*BODY_TOP/, '新建文字必须避开标题区');
assert.match(css, /\.rs-slide-master\s*\{/, '母版必须有固定定位样式');
assert.match(css, /\.rs-slide-title\s*\{/, '标题区必须有独立样式');
assert.match(css, /\.rs-slide-master-line\s*\{/, '横线必须由 CSS 绘制而非可变形图片');

console.log('✓ 自定义页以固定母版渲染，标题独立编辑并同步到导出');
