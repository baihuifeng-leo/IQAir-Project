'use strict';
// 生成 AI 新闻时可以明确选目标期数（本周 or 已归档的某一周），生成后直接绑定进
// 对应归档，不再默认只落在本周实时工作区——避免"回头给上周补录新闻却顺手覆盖了
// 本周刚生成的内容"这类问题重演（历史上已经发生过两次，一次是归档接口的自动
// 回退逻辑，一次是清空范围过大，这次从根上给使用者一个明确的目标选择）。
const assert = require('assert');
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const js = fs.readFileSync('public/report.js', 'utf8');

assert.match(html, /<select id="rpt-news-target"><\/select>/, '新闻编辑弹窗必须有目标期数选择器');

assert.match(js, /let newsTarget = null;/, '必须有目标期数状态');
assert.match(js, /function renderNewsTargetSelect\(\)/, '必须有渲染目标选择器的函数');
assert.match(js, /\.concat\(archives\.map/, '选择器选项必须包含已归档的周');
assert.match(js, /archivePeriodLabel\(item\.weekStart\)/, '已归档周的选项要用 QxWxx 这种口头习惯的标签');

// 打开弹窗必须先重置目标、拉一份最新归档列表，否则选择器里可能是空的或过期的
assert.match(js, /async function openNewsPicker\(\)[\s\S]*?newsTarget = null;[\s\S]*?await loadArchives\(\);[\s\S]*?renderNewsTargetSelect\(\)/, '打开选新闻弹窗时必须重置目标并刷新归档列表');
// 关闭弹窗（不管是不是真的生成了）也必须复位，不能把上次选的目标周残留到下一次打开
assert.match(js, /function closeNewsPicker\(\)\s*\{\s*newsPickerOpen = false;\s*newsTarget = null;/, '关闭弹窗必须复位目标选择，不能残留上一次的选择');

// 添加候选链接、生成新闻都要用选中的目标周，而不是永远用本周
assert.match(js, /weekStart:\s*newsTarget \|\| news\.weekStart,\s*url/, '添加候选新闻链接必须尊重选中的目标周');
assert.match(js, /weekStart:\s*targetWeek \|\| news\.weekStart,\s*ids:/, '生成新闻必须尊重选中的目标周');

// 目标是已归档周时：生成后要走绑定路径，不能只是简单地 loadNews()（那只会刷新本周）
assert.match(js, /async function bindNewsToArchive\(targetWeek, generatedNews\)/, '必须有把生成的新闻绑定进归档的函数');
assert.match(js, /snapshot:\s*\{\s*report:\s*current\.version\.snapshot\.report,\s*news:\s*generatedNews\s*\}/, '绑定进归档时必须原样保留 report，只替换 news——不能连带覆盖归档的报告内容');
assert.match(js, /if \(targetWeek\)\s*\{\s*await bindNewsToArchive\(targetWeek, generated\);/, '目标是已归档周时生成后必须调用绑定，不能停在实时工作区');

// 绑定会覆盖归档已有的新闻，必须有确认，避免手滑覆盖掉正确内容
assert.match(js, /if \(targetWeek && !confirm\(/, '绑定进已归档周之前必须有确认提示，防止手滑覆盖');

console.log('✓ AI 新闻生成支持显式选择目标期数（本周/已归档），并能正确绑定进对应归档');
