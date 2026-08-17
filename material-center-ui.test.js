'use strict';
// 静态结构锁：素材中心下拉导航 + 平台账号独立入口，锁住 Task 8 的可访问性契约，
// 不启动真实浏览器（本项目没有前端自动化测试栈），只解析源码文本做确定性断言。
const assert = require('assert');
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const css = fs.readFileSync('public/styles.css', 'utf8');
const core = fs.readFileSync('public/core.js', 'utf8');
const pa = fs.readFileSync('public/platform-accounts.js', 'utf8');

// 一个“素材中心”触发按钮，带 aria-haspopup，默认动作仍是 data-view="materialcheck"
const triggerMatches = html.match(/<button[^>]*id="mc-trigger"[^>]*>/g) || [];
assert.equal(triggerMatches.length, 1, '应该只有一个 mc-trigger');
assert.match(triggerMatches[0], /aria-haspopup="true"/);
assert.match(triggerMatches[0], /data-view="materialcheck"/);
assert.match(triggerMatches[0], /aria-controls="mc-submenu"/);

// 子菜单恰好两个按钮：素材质检 / 详情长图
const submenuBlock = html.match(/<div class="tab-submenu"[^>]*id="mc-submenu"[\s\S]*?<\/div>/);
assert.ok(submenuBlock, '找不到 mc-submenu');
const submenuItems = submenuBlock[0].match(/<button class="tab tab-submenu-item"/g) || [];
assert.equal(submenuItems.length, 2, '子菜单应该正好两个按钮');
assert.match(submenuBlock[0], /data-view="materialcheck"/);
assert.match(submenuBlock[0], /data-view="detail-long-image"/);

// 独立的“平台账号”标签，不在下拉菜单里
assert.match(html, /<button class="tab" role="tab" data-view="platform-accounts">平台账号<\/button>/);

// 对应的视图区块都存在
assert.match(html, /<section class="view" id="view-detail-long-image" data-view="detail-long-image"/);
assert.match(html, /<section class="view" id="view-platform-accounts" data-view="platform-accounts"/);

// 脚本顺序：两个新模块都在 core.js 之后加载
const scriptOrder = [...html.matchAll(/<script src="\/([\w.-]+)\.js">/g)].map((m) => m[1]);
const coreIndex = scriptOrder.indexOf('core');
assert.ok(coreIndex >= 0, '找不到 core.js 的 script 标签');
assert.ok(scriptOrder.indexOf('platform-accounts') > coreIndex, 'platform-accounts.js 必须排在 core.js 之后');
assert.ok(scriptOrder.indexOf('detail-long-image') > coreIndex, 'detail-long-image.js 必须排在 core.js 之后');

// materialcheck 的既有接口路径一个都不能改名
assert.doesNotMatch(pa, /\/api\/materialcheck\//);
const materialcheckJs = fs.readFileSync('public/materialcheck.js', 'utf8');
assert.match(materialcheckJs, /\/api\/materialcheck\//, 'materialcheck.js 原有接口路径必须还在');

// Escape 关闭下拉，聚焦/失焦也要处理
assert.match(pa, /key !== 'Escape'|key === 'Escape'/);
assert.match(pa, /addEventListener\('focus'/);
assert.match(pa, /addEventListener\('focusout'/);

// core.js：隐藏 materialcheck 偏好时，整个下拉组一起隐藏；detail-job SSE 接进 core
assert.match(core, /mcGroup\.hidden = hidden\.has\('materialcheck'\)/);
assert.match(core, /addEventListener\('detail-job'/);
assert.match(core, /PlatformAccounts\.onShow\(\)/);
assert.match(core, /DetailLongImage\.onShow\(\)/);

console.log('✓ material-center navigation contract holds');
