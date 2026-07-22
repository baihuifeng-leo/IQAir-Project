# 样板间：共享外壳 + 价格带沙盘 双主题改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让顶栏共享外壳（Tab导航 + ⋯菜单）和价格带沙盘页支持深浅双主题切换（深色=极光玻璃 Aurora Glass，浅色=商务瓷白），同时把沙盘页侧栏按「说明/操作/统计」三分区规则重排，⋯菜单按受众/风险分组——这是整站重建四阶段路线图的第一阶段，验证过的规则会在阶段二复制到其余六个页面。

**Architecture:** 深浅两态共用同一份 HTML/组件骨架，不做双模板；`<html data-theme="dark|light">` 驱动 CSS 自定义属性，纯装饰性元素（极光渐变团）常驻 DOM 靠主题属性控制显隐。未迁移的五个页面（竞品对位/评论风向标/竞品3D预览/报告管理，以及沙盘页以外的部分）通过 `.view[data-theme-ready="false"]` 选择器重新声明深色令牌值，在切到浅色主题时仍强制保持现状深色渲染，避免半新半旧的视觉断层。主题偏好走现有「功能显示设置」同款的服务端按用户存储路径（`PATCH /api/users/:id`），不是纯 `localStorage`。

**Tech Stack:** 原生 JS（无框架）+ 原生 CSS 自定义属性 + Node `http` 服务端（`server.js`），零构建、零 CDN、零 npm 依赖——沿用项目现状技术栈，不引入新工具链。

## Global Constraints

- 零外部依赖：不引入任何 npm 包、构建工具、CDN 资源；所有新增代码是手写原生 JS/CSS
- `backdrop-filter` 只能用在共享外壳层（顶栏/侧栏/⋯菜单），沙盘的 `.paper`/`.canvas` 画布内部禁止使用——PNG 导出走 `html2canvas`，对 `backdrop-filter` 支持不可靠
- `prefers-reduced-motion: reduce` 时必须关闭所有装饰性动画（极光漂移等）
- 本项目**没有自动化前端测试**（`CLAUDE.md` 明确写死）——凡是前端可见行为的验证步骤，一律是"启动服务、打开浏览器、执行 XX 操作、确认看到 YY"的手工步骤，不是可自动运行的测试断言。后端（`server.js`）逻辑改动用 `curl` 命令验证请求/响应，同样是手工执行，不接入自动化 CI
- **每个改动了仓库根目录"摊平源码"的提交，必须在同一个提交里重新打包 `competitive-workbench.tar.gz`**（`CLAUDE.md` 里记录过这个包没跟着更新、线上部署悄悄落后的事故）。本计划第一个任务就是补一个打包脚本，后续每个任务的提交步骤都会调用它
- `server.js` 无法直接从仓库根目录运行——它 `require('./merge.js')`、`require('./audit.js')`，这两个文件和 `public/` 目录只存在于 tarball 里，不在仓库根目录摊平存放。凡是需要跑服务器做验证的任务，先把 tarball 解到一个临时目录，把改动过的文件覆盖进去，再从那个临时目录启动

---

## 文件结构

| 文件 | 改动 | 责任 |
|---|---|---|
| `scripts/repack-tarball.sh`（新增） | 打包脚本 | 从当前 tarball 提取"仅存在于 tarball 里"的文件作为基线，覆盖仓库根目录的最新文件，重新打包 |
| `server.js` | 修改 `pubUser()`、`PATCH /api/users/:id` | 主题偏好的服务端持久化 |
| `index.html` | 修改 `<head>`、`.topbar`、`#more-menu`、`#view-matrix` 的 `.rail` | FOUC 防闪烁脚本、主题切换按钮、`data-theme-ready` 标记、⋯菜单分组标签、沙盘侧栏三分区包裹、极光装饰层的容器 `<div>` |
| `core.js` | 新增 `applyTheme`/`setTheme`，修改 `boot()` | 主题切换的前端状态机与持久化调用 |
| `styles.css` | 新增令牌层、覆写层、外壳视觉 | 双主题令牌架构、⋯菜单分组样式、侧栏三分区样式、深色极光玻璃/浅色商务瓷白视觉 |

不新增/不修改：`matrix.js`（沙盘侧栏内容靠 id 挂载，容器重排不影响它）、`compare.js`/`reviews.js`/`preview3d.js`/`report.js`/`admin.js`/`users.js`/`settings.js`（阶段二范围）。

---

## Task 1: 打包脚本

**Files:**
- Create: `scripts/repack-tarball.sh`

**Interfaces:**
- Consumes: 仓库根目录的摊平源文件 + 现有的 `competitive-workbench.tar.gz`
- Produces: 更新后的 `competitive-workbench.tar.gz`（后续每个任务的提交步骤都会调用这个脚本，命令固定为 `bash scripts/repack-tarball.sh`）

- [ ] **Step 1: 写脚本**

`CLAUDE.md` 里给的打包命令假设 `merge.js`/`audit.js`/`merge.test.js`/`Dockerfile`/`docker-compose.yml`/`workbench.service`/`public/seed.json` 这几个文件在仓库根目录摊平存在——但实际上它们只存在于当前的 tarball 里（`CLAUDE.md` 自己也写了这个例外）。直接照抄那段命令会因为找不到这几个文件而失败。这个脚本先把当前 tarball 解出来当基线（这样那几个"仅存在于 tarball"的文件就有了），再用仓库根目录的最新文件覆盖，然后重新打包：

```bash
#!/usr/bin/env bash
# 重新打包 competitive-workbench.tar.gz。
#
# merge.js / audit.js / merge.test.js / Dockerfile / docker-compose.yml /
# workbench.service / public/seed.json 这几个文件只存在于当前的
# tarball 里，不在仓库根目录摊平存放（见 CLAUDE.md）。所以不能直接
# cp 仓库根目录的文件去拼一个全新的包——先把当前 tarball 解出来当
# 基线，用它兜底这几个文件，再拿仓库根目录的最新文件覆盖其余部分。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f competitive-workbench.tar.gz ]; then
  echo "competitive-workbench.tar.gz 不存在，无法用它做基线" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

tar xzf competitive-workbench.tar.gz -C "$WORK"

cp server.js xlsx-lite.js reviews-nlp.js reviews-ingest.js \
   reviews-store.js preview3d-store.js report-store.js install.sh README.md \
   "$WORK/competitive-workbench/"

cp index.html login.html core.js matrix.js compare.js reviews.js preview3d.js \
   report.js admin.js users.js settings.js styles.css \
   echarts.min.js echarts-gl.min.js html2canvas.min.js \
   "$WORK/competitive-workbench/public/"

tar czf competitive-workbench.tar.gz -C "$WORK" competitive-workbench
echo "已重新打包 competitive-workbench.tar.gz"
```

- [ ] **Step 2: 加执行权限**

Run: `chmod +x scripts/repack-tarball.sh`

- [ ] **Step 3: 跑一次，确认打包内容正确**

Run:
```bash
bash scripts/repack-tarball.sh
tar tzf competitive-workbench.tar.gz | sort
```
Expected: 输出里同时包含仓库根目录摊平存放的文件（如 `competitive-workbench/server.js`、`competitive-workbench/public/index.html`）和只存在于 tarball 里的文件（如 `competitive-workbench/merge.js`、`competitive-workbench/audit.js`、`competitive-workbench/public/seed.json`）。

再确认覆盖生效、不是简单沿用了旧内容：
```bash
WORK=$(mktemp -d) && tar xzf competitive-workbench.tar.gz -C "$WORK"
diff index.html "$WORK/competitive-workbench/public/index.html"
rm -rf "$WORK"
```
Expected: `diff` 没有输出（两份文件一致，说明打包用的是仓库根目录的最新版本）。

- [ ] **Step 4: 提交**

```bash
git add scripts/repack-tarball.sh competitive-workbench.tar.gz
git commit -m "$(cat <<'EOF'
新增打包脚本：从当前 tarball 提取基线，覆盖最新摊平源码

CLAUDE.md 里那段打包命令假设 merge.js/audit.js 等几个文件在仓库根目录
摊平存在，但它们其实只存在于 tarball 里，直接抄会因为文件缺失而失败。
这个脚本先解出当前 tarball 当基线兜底那几个文件，再用仓库根目录的最新
文件覆盖，后续每个改动前端/服务端代码的提交都会调用它。
EOF
)"
```

---

## Task 2: 主题偏好的服务端持久化

**Files:**
- Modify: `server.js:103` (`pubUser`)
- Modify: `server.js:366-393` (`PATCH /api/users/:id`)

**Interfaces:**
- Consumes: 无（这是最底层的存储改动）
- Produces: `pubUser(u)` 返回值新增 `theme: 'dark' | 'light'` 字段；`PATCH /api/users/:id` 接受 `{ theme: 'dark' | 'light' }`，只能改自己的（`isSelf` 检查），非法值返回 400。Task 3 的前端代码依赖这两点。

- [ ] **Step 1: 改 `pubUser`**

`server.js:103` 现状：
```js
const pubUser = (u) => ({ id: u.id, name: u.name, admin: !!u.admin, color: u.color, defaultPin: !!u.defaultPin, hiddenModules: u.hiddenModules || [] });
```
改成：
```js
const pubUser = (u) => ({ id: u.id, name: u.name, admin: !!u.admin, color: u.color, defaultPin: !!u.defaultPin, hiddenModules: u.hiddenModules || [], theme: u.theme === 'light' ? 'light' : 'dark' });
```

- [ ] **Step 2: 改 `PATCH /api/users/:id`**

`server.js:369` 现状：
```js
const { pin, name, admin, hiddenModules } = await body(req, 4096);
```
改成：
```js
const { pin, name, admin, hiddenModules, theme } = await body(req, 4096);
```

`server.js:386-393` 现状（`hiddenModules` 校验块之后）：
```js
        if (hiddenModules !== undefined) {
          if (!isSelf) return json(res, 403, { error: '只能改自己的显示设置' });
          if (!Array.isArray(hiddenModules) || hiddenModules.some((m) => !MODULES.includes(m))) {
            return json(res, 400, { error: '模块列表不对' });
          }
          if (hiddenModules.length >= MODULES.length) return json(res, 400, { error: '至少要留一个模块显示' });
          u.hiddenModules = hiddenModules;
        }
        await saveUsers();
```
在 `u.hiddenModules = hiddenModules; }` 之后、`await saveUsers();` 之前插入：
```js
        // 主题偏好，跟 hiddenModules 一样只能改自己的——管理员也不能替别人切主题
        if (theme !== undefined) {
          if (!isSelf) return json(res, 403, { error: '只能改自己的主题偏好' });
          if (theme !== 'dark' && theme !== 'light') return json(res, 400, { error: '主题只能是 dark 或 light' });
          u.theme = theme;
        }
```
（不加入 `what` 数组、不写变更日志——跟 `hiddenModules` 一样，是纯个人偏好，`server.js:400` 那行注释已经解释过这个决定，主题偏好沿用同样的理由。）

- [ ] **Step 3: 打包**

Run: `bash scripts/repack-tarball.sh`

- [ ] **Step 4: 手工验证——起一个临时服务实例，用 curl 走一遍**

```bash
rm -rf /tmp/verify-task2 && mkdir -p /tmp/verify-task2
tar xzf competitive-workbench.tar.gz -C /tmp/verify-task2
cd /tmp/verify-task2/competitive-workbench
DATA_DIR=/tmp/verify-task2/data ADMIN_USER=admin ADMIN_PIN=123456 PORT=8099 node server.js &
sleep 1

curl -s -c /tmp/verify-task2/cookies -X POST localhost:8099/api/login \
  -H 'Content-Type: application/json' -d '{"name":"admin","pin":"123456"}'
# 期望：200，返回体里 user.theme 是 "dark"（新用户没设置过，走默认值）

ME=$(curl -s -b /tmp/verify-task2/cookies localhost:8099/api/me)
echo "$ME"
UID=$(echo "$ME" | node -e "process.stdin.once('data',d=>console.log(JSON.parse(d).id))")

curl -s -b /tmp/verify-task2/cookies -X PATCH "localhost:8099/api/users/$UID" \
  -H 'Content-Type: application/json' -d '{"theme":"light"}'
# 期望：200，返回体里 theme 变成 "light"

curl -s -b /tmp/verify-task2/cookies localhost:8099/api/me
# 期望：theme 仍是 "light"——确认真的存进 users.json 了，不是只在这次响应里回显

curl -s -b /tmp/verify-task2/cookies -X PATCH "localhost:8099/api/users/$UID" \
  -H 'Content-Type: application/json' -d '{"theme":"purple"}'
# 期望：400，{"error":"主题只能是 dark 或 light"}

kill %1
```

Expected: 上面五步全部符合注释里写的预期。

- [ ] **Step 5: 提交**

```bash
git add server.js competitive-workbench.tar.gz
git commit -m "$(cat <<'EOF'
新增：主题偏好的服务端持久化

跟 hiddenModules（功能显示设置）走同一套模式——PATCH /api/users/:id
存进 users.json，只能改自己的，换设备/重新登录都保持。不进变更日志，
理由跟 hiddenModules 一样：纯个人偏好，不是协同数据变更。
EOF
)"
```

---

## Task 3: 主题切换机制（令牌架构 + 切换按钮 + 前端持久化）

**Files:**
- Modify: `styles.css:39` （`:root` 之后插入新块）
- Modify: `styles.css:55-150`（`.topbar`/`.ghost`/`.editbtn`/`.tab`/`.stat`/`.menu`/`.tag-row .sq` 里的硬编码半透明色改成令牌引用）
- Modify: `index.html:1-9`（`<head>`，FOUC 防闪烁脚本）
- Modify: `index.html:12-54`（`.topbar`，新增主题按钮）
- Modify: `index.html:60,105,158,214,267`（五个 `.view` 加 `data-theme-ready`）
- Modify: `core.js`（新增 `applyTheme`/`setTheme`，`boot()` 里接线）

**Interfaces:**
- Consumes: Task 2 的 `PATCH /api/users/:id` 接受 `{theme}`；`me.theme` 来自 `GET /api/me`
- Produces: `<html data-theme="dark"|"light">`；`.view[data-theme-ready="true"|"false"]`；CSS 令牌 `--overlay-weak`、`--overlay-strong`、`--menu-shadow`、`--aurora-1`、`--aurora-2`（Task 6/7 会用到后两个和覆写层）；`#btn-theme` 按钮。Task 4/5/6/7 都建立在这个任务之上。

- [ ] **Step 1: styles.css——`:root` 之后插入浅色覆写层 + 未迁移页面的深色兜底层**

在 `styles.css:39`（`:root {...}` 的收尾 `}`）之后插入：

```css
/* ═══════════════════════════════════════════════════════════
   双主题：浅色覆写 + 未迁移页面的深色兜底
   深色是 :root 的默认值（现状不变）。浅色态覆写下面这些令牌。
   阶段一只有共享外壳 + 沙盘页做了双主题适配，其余视图还是旧的纯深色
   实现——:root[data-theme="light"] 会把这些令牌全站覆写成浅色值，
   所以未适配的视图需要在自己的 [data-theme-ready="false"] 作用域里
   把令牌重新声明回深色值，防止浅色态下出现"半新半旧"的视觉断层。
   等阶段二哪个视图做完适配，把它的 data-theme-ready 改成 "true"，
   这层兜底会自动失效，不用再改 CSS。
   ═══════════════════════════════════════════════════════════ */
:root[data-theme="light"] {
  --bg: #eef1f7;
  --surface: #ffffff;
  --surface-2: #f8f9fc;
  --line: #e6e9f0;
  --line-soft: #edf0f5;
  --text: #1b2740;
  --dim: #5b6a8c;
  --dimmer: #97a3bd;

  --mint: #1f9e85;
  --mint-dim: rgba(31, 158, 133, 0.14);
  --blue: #3358c9;

  --overlay-weak: rgba(20, 30, 60, 0.045);
  --overlay-strong: rgba(20, 30, 60, 0.08);
  --menu-shadow: 0 24px 50px -18px rgba(30, 50, 110, 0.18);

  --aurora-1: #c4b5fd;
  --aurora-2: #99f0dd;
}

.view[data-theme-ready="false"] {
  --bg: #080c14;
  --surface: #101725;
  --surface-2: #0c1220;
  --line: #1f2b42;
  --line-soft: #17203292;
  --text: #e9eef8;
  --dim: #79879f;
  --dimmer: #4d5a72;

  --mint: #4ee0c1;
  --mint-dim: rgba(78, 224, 193, 0.14);
  --blue: #5b8cff;

  --overlay-weak: #ffffff08;
  --overlay-strong: #ffffff12;
  --menu-shadow: 0 24px 50px -18px #000;
}
```

也在原有 `:root {...}` 块里补上这几个新令牌的深色默认值（紧接在 `--blue: #5b8cff;` 之后插入）：
```css
  --overlay-weak: #ffffff08;
  --overlay-strong: #ffffff12;
  --menu-shadow: 0 24px 50px -18px #000;
  --aurora-1: #8b5cf6;
  --aurora-2: #4ee0c1;
```

- [ ] **Step 2: styles.css——把硬编码半透明色换成令牌**

逐处替换（都在 `styles.css:55-150` 范围内，替换前后用 grep 核对没漏改）：

- `.ghost { background: #ffffff08; ... }` → `background: var(--overlay-weak);`
- `.ghost:hover { color: var(--text); border-color: #33456a; background: #ffffff12; }` → `background: var(--overlay-strong);`
- `.editbtn { background: #ffffff08; ... }` → `background: var(--overlay-weak);`
- `.tab:hover { color: var(--text); background: #ffffff08; }` → `background: var(--overlay-weak);`
- `.stat { background: #ffffff07; ... }` → `background: var(--overlay-weak);`
- `.tag-row .sq { ...; background: #ffffff0a; ... }` → `background: var(--overlay-weak);`
- `.menu button:hover { background: #ffffff0e; color: var(--text); }` → `background: var(--overlay-strong);`
- `.menu { ...; box-shadow: 0 24px 50px -18px #000; ... }` → `box-shadow: var(--menu-shadow);`

验证没漏改——只核对上面列出的这 8 处选择器，不是整个文件：
```bash
grep -nE '\.(ghost(:hover)?|editbtn|tab:hover|stat|tag-row \.sq|menu( button:hover)?) *\{' styles.css | grep '#ffffff0'
```
Expected: 无输出（这 8 处硬编码全部改成了令牌引用）。注意：`--overlay-weak: #ffffff08;` 这两行令牌定义（`:root` 和 `:root[data-theme="light"]` 里）本身就应该保留字面量——那是令牌的取值，不是要改的"用法"。文件里其余非本任务范围的 `#ffffff0x` 用法（评论看板、用户管理面板等还没迁移的模块样式）保持不动，本任务只改上面列出的这几条共享外壳选择器；一个不加限定的 `grep -n '#ffffff0[0-9a-f]\b' styles.css` 会连同这些未改动的、以及两行令牌定义一起匹配出来，不能作为"漏改"的判断依据。

- [ ] **Step 3: index.html——`<head>` 加 FOUC 防闪烁脚本**

`index.html:8-9` 现状：
```html
<link rel="stylesheet" href="/styles.css">
</head>
```
改成：
```html
<link rel="stylesheet" href="/styles.css">
<script>
  // 页面渲染前先按本机缓存的主题设值，避免先闪一下默认深色再跳成浅色。
  // 真正的账号偏好在 core.js 的 boot() 里从 /api/me 拿到后会再校正一次。
  (function () {
    var t = localStorage.getItem('wb.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  })();
</script>
</head>
```

- [ ] **Step 4: index.html——五个 `.view` 加 `data-theme-ready`**

```
line 60:  <section class="view" id="view-matrix" data-view="matrix">
```
改成：
```html
  <section class="view" id="view-matrix" data-view="matrix" data-theme-ready="true">
```

其余四处（`view-compare`/`view-reviews`/`view-preview3d`/`view-reports`）分别加 `data-theme-ready="false"`，例如 `index.html:105`：
```html
  <section class="view" id="view-compare" data-view="compare" data-theme-ready="false" hidden>
```
`index.html:158`：
```html
  <section class="view view-rv" id="view-reviews" data-view="reviews" data-theme-ready="false" hidden>
```
`index.html:214`：
```html
  <section class="view" id="view-preview3d" data-view="preview3d" data-theme-ready="false" hidden>
```
`index.html:267`：
```html
  <section class="view" id="view-reports" data-view="reports" data-theme-ready="false" hidden>
```

- [ ] **Step 5: index.html——主题切换按钮**

`index.html:30-31` 现状：
```html
  <div class="topbar-right">
    <button class="editbtn" id="btn-edit" title="默认只读，防止浏览时误改">开启编辑</button>
```
改成：
```html
  <div class="topbar-right">
    <button class="ghost" id="btn-theme" title="切换深浅主题">切到浅色</button>
    <button class="editbtn" id="btn-edit" title="默认只读，防止浏览时误改">开启编辑</button>
```
（按钮文案跟 `#btn-edit` 一样是"点了会发生什么"的动作文案，不是"现在是什么状态"——这是 `setEditing()` 已经在用的约定，见 `core.js:245` 的 `完成编辑`/`开启编辑`。初始文案先写死"切到浅色"，Step 7 的 `applyTheme()` 会在页面加载时立刻纠正成正确的文案，不会有闪烁——这行只是给没跑 JS 前的兜底文本。）

- [ ] **Step 6: styles.css——主题按钮的选中态**

在 `.editbtn.is-on {...}` 规则块（`styles.css:837-840`）之后插入：
```css
#btn-theme.is-on { border-color: var(--mint); color: var(--mint); background: var(--mint-dim); }
```

- [ ] **Step 7: core.js——`applyTheme`/`setTheme`**

在 `refreshModuleVisibility()` 函数（`core.js:375-383`）之后插入：
```js
  /* ── 主题 ───────────────────────────────────────────── */
  /**
   * 只管本地生效（属性 + localStorage 缓存 + 按钮文案），不碰网络。
   * localStorage 只是同一台设备下次打开页面时避免闪烁的缓存，不是
   * 偏好的存储来源——存储来源是服务端的 users.json（见 setTheme）。
   */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('wb.theme', t);
    const b = $('#btn-theme');
    if (b) {
      b.textContent = t === 'light' ? '切到深色' : '切到浅色';
      b.classList.toggle('is-on', t === 'light');
    }
  }

  /** 切主题：本地立刻生效，同时同步到账号；同步失败就把本地状态退回去，跟 settings.js 的 toggle() 是一个套路。 */
  async function setTheme(t) {
    const prev = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(t);
    if (me) me.theme = t;
    try {
      const r = guard(await fetch('/api/users/' + me.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: t })
      }));
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || '保存失败');
    } catch (e) {
      if (e.expired) return;
      applyTheme(prev);
      if (me) me.theme = prev;
      toast('主题偏好没能同步到账号，换设备可能会看到旧主题：' + e.message, 'bad');
    }
  }
```

- [ ] **Step 8: core.js——`boot()` 里接线**

`core.js:589-591` 现状：
```js
    $$('.tab').forEach((t) => (t.onclick = () => go(t.dataset.view)));
    $('#btn-edit').onclick = () => setEditing(!editing);
    setEditing(localStorage.getItem('wb.editing') === '1');
```
改成：
```js
    $$('.tab').forEach((t) => (t.onclick = () => go(t.dataset.view)));
    $('#btn-edit').onclick = () => setEditing(!editing);
    setEditing(localStorage.getItem('wb.editing') === '1');
    applyTheme(me.theme || 'dark');
    $('#btn-theme').onclick = () => setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
```

（放在这里是因为这时候 `me` 已经从 `/api/me` 拿到了，`applyTheme(me.theme || 'dark')` 会用账号里的真实偏好纠正 Step 3 那个 localStorage 缓存猜的值——两者一般是一致的，只有换了新设备或者第一次登录时才会有分歧。）

`core.js:628` 的 `api` 对象不需要加东西——`applyTheme`/`setTheme` 只在 `core.js` 内部用，其他模块（`matrix.js` 等）这个阶段不需要调用它们。

- [ ] **Step 9: 打包**

Run: `bash scripts/repack-tarball.sh`

- [ ] **Step 10: 手工验证——浏览器里跑一遍**

```bash
rm -rf /tmp/verify-task3 && mkdir -p /tmp/verify-task3
tar xzf competitive-workbench.tar.gz -C /tmp/verify-task3
cd /tmp/verify-task3/competitive-workbench
DATA_DIR=/tmp/verify-task3/data ADMIN_USER=admin ADMIN_PIN=123456 PORT=8099 node server.js &
```
打开 `http://localhost:8099/login.html`，用 `admin` / `123456` 登录，然后：

1. 顶栏右侧应该看到一个"切到浅色"按钮，在"开启编辑"左边
2. 点它——`<html>` 的 `data-theme` 属性应该变成 `light`（开发者工具里查看 `<html>` 标签确认），按钮文案变成"切到深色"
3. 刷新页面——应该还是浅色（说明 `localStorage` 缓存生效，没有闪烁跳回深色再变浅色）
4. 开另一个浏览器 / 无痕窗口，同样登录 `admin`，应该直接是浅色（说明偏好是从服务端 `/api/me` 拿的，不是只在这台设备生效）
5. 切回深色，确认能来回切换、按钮文案跟着正确变化
6. 打开系统的"减弱动态效果"（macOS：系统设置 → 辅助功能 → 显示 → 减弱动态效果；或者开发者工具里模拟 `prefers-reduced-motion: reduce`），本任务还没加装饰动画所以这一步先跳过，留给 Task 6 再测

Expected: 以上 1-5 全部符合预期。此时因为 Task 4/5/6/7 还没做，浅色态下沙盘页以外的颜色变化可能还比较生硬（比如侧栏还没做玻璃质感），这是正常的——这个任务只验证"机制通不通"，不是最终视觉效果。

Run: `kill %1` 关掉临时服务。

- [ ] **Step 11: 提交**

```bash
git add index.html core.js styles.css competitive-workbench.tar.gz
git commit -m "$(cat <<'EOF'
新增：深浅双主题切换机制

data-theme 属性驱动 CSS 令牌；未迁移的四个视图靠
.view[data-theme-ready="false"] 重新声明深色令牌值兜底，浅色态下不
会出现半新半旧的视觉断层。偏好走服务端持久化（Task 2 的
PATCH /api/users/:id），localStorage 只做同设备下次打开的防闪烁缓存。
EOF
)"
```

---

## Task 4: ⋯ 菜单按受众/风险分组

**Files:**
- Modify: `index.html:38-53`（`#more-menu`）
- Modify: `styles.css`（新增 `.menu-group` 相关样式）

**Interfaces:**
- Consumes: Task 3 的令牌（`var(--overlay-strong)` 等）
- Produces: `.menu-group`/`.menu-group-label`/`.menu-group--admin`/`.menu-group--danger` 这几个 class；`core.js` 里 `wireMenu()`（`data-act` 委托）和管理员隐藏逻辑（`['reset','logs','backups'].forEach(...)`）都是按 `data-act` 属性选择器工作的，不依赖父级结构，本任务不需要改 `core.js`

- [ ] **Step 1: index.html——菜单标签分组**

`index.html:38-53` 现状：
```html
    <div class="menu-wrap">
      <button class="ghost" id="btn-more" aria-haspopup="true">⋯</button>
      <div class="menu" id="more-menu" hidden>
        <button data-act="export">导出 JSON 备份</button>
        <button data-act="import">从 JSON 恢复</button>
        <button data-act="print">打印 / 导出 PDF</button>
        <div class="menu-sep"></div>
        <button data-act="logs">变更日志</button>
        <button data-act="backups">备份与恢复</button>
        <button data-act="users">用户管理</button>
        <button data-act="settings">功能显示设置</button>
        <div class="menu-sep"></div>
        <button data-act="reset" class="danger">恢复出厂数据</button>
        <button data-act="logout" id="btn-logout">退出登录 · <span id="whoami"></span></button>
      </div>
    </div>
```
改成（分组依据见设计文档：功能显示设置=个人偏好；用户管理=账号，全员可见；导出/导入/打印=数据治理，全员可用；变更日志/备份与恢复=管理员专区，`server.js` 里两个接口都强制 403；恢复出厂数据=危险操作）：
```html
    <div class="menu-wrap">
      <button class="ghost" id="btn-more" aria-haspopup="true">⋯</button>
      <div class="menu" id="more-menu" hidden>
        <div class="menu-group">
          <div class="menu-group-label">个人偏好</div>
          <button data-act="settings">功能显示设置</button>
        </div>
        <div class="menu-group">
          <div class="menu-group-label">账号</div>
          <button data-act="users">用户管理</button>
        </div>
        <div class="menu-group">
          <div class="menu-group-label">数据治理</div>
          <button data-act="export">导出 JSON 备份</button>
          <button data-act="import">从 JSON 恢复</button>
          <button data-act="print">打印 / 导出 PDF</button>
        </div>
        <div class="menu-group menu-group--admin">
          <div class="menu-group-label">管理员专区</div>
          <button data-act="logs">变更日志</button>
          <button data-act="backups">备份与恢复</button>
        </div>
        <div class="menu-group menu-group--danger">
          <button data-act="reset" class="danger">恢复出厂数据</button>
        </div>
        <div class="menu-group">
          <button data-act="logout" id="btn-logout">退出登录 · <span id="whoami"></span></button>
        </div>
      </div>
    </div>
```
（去掉了原来的 `.menu-sep` 分隔线，分组本身靠 `.menu-group` 之间的间距和 `.menu-group-label` 区分，不再需要单独的分割线元素。`class="danger"` 保留在按钮上，`styles.css` 里 `.menu button.danger:hover` 那条规则不用改。）

- [ ] **Step 2: styles.css——分组样式**

在 `.menu button.danger:hover {...}` 规则（`styles.css:150`）之后插入：
```css
.menu-group + .menu-group { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line-soft); }
.menu-group-label {
  padding: 4px 11px 6px; font-size: 10.5px; letter-spacing: 1px; text-transform: uppercase;
  color: var(--dimmer); font-weight: 700;
}
.menu-group--admin { position: relative; }
.menu-group--admin::before {
  content: ""; position: absolute; left: -6px; top: 0; bottom: 0; width: 2px;
  background: var(--dis); opacity: 0.5; border-radius: 2px;
}
.menu-group--danger button.danger {
  border: 1px solid transparent; transition: all var(--fast);
}
.menu-group--danger button.danger:hover { border-color: var(--dis); }
```

- [ ] **Step 3: 打包**

Run: `bash scripts/repack-tarball.sh`

- [ ] **Step 4: 手工验证**

沿用 Task 3 Step 10 起的临时服务（如果已经关了，按同样方式重新起一个），登录后：

1. 用 `admin` 账号点顶栏 `⋯`，应该看到六组：个人偏好 / 账号 / 数据治理 / 管理员专区（带一条细红色左侧标记）/ 危险操作 / 退出登录，组与组之间有分隔线和小标题
2. 「管理员专区」和「危险操作」两组视觉上要能一眼看出跟其他组不一样（红色标记、hover 时危险按钮描边变红）
3. 新建一个非管理员账号（⋯ → 用户管理 → 新增成员）登出重登，点 `⋯`——「管理员专区」整组应该消失（因为组内两个按钮都被 `core.js` 的 `['reset','logs','backups'].forEach(...)` 移除了，只剩一个空的 `.menu-group-label`）

第 3 点如果发现空标题还留着不好看，记下来但先不改代码——继续验证，跳到 Step 5 一起处理。

- [ ] **Step 5: 处理空分组标题**

Step 4 第 3 点会暴露一个问题：非管理员账号下，「管理员专区」两个按钮都被移除后，`.menu-group-label`（"管理员专区"四个字）和 `.menu-group--admin` 的红色左侧标记还留在菜单里，变成一个没有内容的空分组，不好看。改 `core.js` 的移除逻辑，把整个空分组一起清掉。

`core.js:602` 现状：
```js
    if (!me.admin) ['reset', 'logs', 'backups'].forEach((a) => $(`[data-act="${a}"]`)?.remove());
```
改成：
```js
    if (!me.admin) {
      $('.menu-group--admin')?.remove(); // logs/backups 都是管理员专区独有的，组一起删，不留空标题、也不用再逐个按钮找
      $('[data-act="reset"]')?.closest('.menu-group')?.remove(); // 危险操作是单独一组，同样整组删
    }
```
（原来是 `['reset', 'logs', 'backups'].forEach((a) => $(...).remove())` 逐个删按钮；现在这三个按钮分别在两个独立分组里，删整个 `.menu-group` 比逐个找按钮更干净，而且顺带清掉了空标题。效果不变——非管理员看不到这三个功能，跟改之前一样。）

- [ ] **Step 6: 打包，重新验证**

Run: `bash scripts/repack-tarball.sh`

重复 Step 4 的第 3 点：非管理员账号点 `⋯`，「管理员专区」「危险操作」两组应该完全不出现（不是留空标题），菜单从「数据治理」直接接到「退出登录」。管理员账号那边（Step 4 第 1、2 点）应该没有变化，重新确认一遍。

- [ ] **Step 7: 提交**

```bash
git add index.html styles.css core.js competitive-workbench.tar.gz
git commit -m "$(cat <<'EOF'
⋯菜单按受众/风险重新分组

原来是一份平铺列表，不分个人偏好/团队数据/管理员操作/危险操作。
按 server.js 的真实权限（变更日志、备份与恢复服务端强制仅管理员）
分成六组，管理员专区带视觉警示；非管理员看不到的分组现在是整组
移除，不会留空标题。
EOF
)"
```

---

## Task 5: 沙盘页侧栏三分区

**Files:**
- Modify: `index.html:61-87`（`#view-matrix .rail`）
- Modify: `styles.css`（新增 `.rail-zone` 相关样式）

**Interfaces:**
- Consumes: Task 3 的 `var(--overlay-weak)`、`var(--line-soft)`
- Produces: `.rail-zone`/`.rail-zone--info`/`.rail-zone--action`/`.rail-zone--stats` 这几个 class——阶段二给其余四个页面的侧栏分区时直接复用这套 class，不用再重新设计规则。`#tag-editor`/`#matrix-stats`/`#default-color` 等 id 不变，`matrix.js` 不需要改动

- [ ] **Step 1: index.html——三分区重排**

`index.html:61-87` 现状：
```html
    <aside class="rail">
      <div class="rail-head">
        <span>图例与分类</span>
        <button class="rail-toggle" title="收起工作台，腾出阅读空间" aria-label="收起工作台"></button>
      </div>
      <div class="rail-body">
        <p class="rail-hint">这些颜色同时控制沙盘里的产品标签。改一处，全盘生效。</p>
        <div id="tag-editor"></div>
        <button class="solid" id="btn-add-tag">新增一个分类</button>

        <div class="rail-sec">默认产品色</div>
        <div class="tag-row">
          <input type="color" id="default-color">
          <input type="text" id="default-color-hex" spellcheck="false">
        </div>

        <div class="rail-sec">结构</div>
        <button class="ghost wide" id="btn-add-brand">新增品牌列</button>
        <button class="ghost wide" id="btn-add-band">新增价格带</button>

        <div class="rail-sec">批量调整</div>
        <p class="rail-hint">在空白处按住鼠标拖出选框，可以一次选中多个产品；<kbd>Ctrl</kbd> 点击加选或取消。选中后整批拖到别的格子，或用底部工具条改分类、删除。</p>

        <div class="rail-sec">统计</div>
        <div class="stats" id="matrix-stats"></div>
      </div>
    </aside>
```
改成：
```html
    <aside class="rail rail--glass">
      <div class="rail--glass-aurora"><i></i><i></i></div>
      <div class="rail-head">
        <span>图例与分类</span>
        <button class="rail-toggle" title="收起工作台，腾出阅读空间" aria-label="收起工作台"></button>
      </div>
      <div class="rail-body">
        <div class="rail-zone rail-zone--info">
          <p class="rail-hint">这些颜色同时控制沙盘里的产品标签。改一处，全盘生效。</p>
          <p class="rail-hint">在空白处按住鼠标拖出选框，可以一次选中多个产品；<kbd>Ctrl</kbd> 点击加选或取消。选中后整批拖到别的格子，或用底部工具条改分类、删除。</p>
        </div>

        <div class="rail-zone rail-zone--action">
          <div id="tag-editor"></div>
          <button class="solid" id="btn-add-tag">新增一个分类</button>

          <div class="rail-sec">默认产品色</div>
          <div class="tag-row">
            <input type="color" id="default-color">
            <input type="text" id="default-color-hex" spellcheck="false">
          </div>

          <div class="rail-sec">结构</div>
          <button class="ghost wide" id="btn-add-brand">新增品牌列</button>
          <button class="ghost wide" id="btn-add-band">新增价格带</button>
        </div>

        <div class="rail-zone rail-zone--stats">
          <div class="rail-sec">统计</div>
          <div class="stats" id="matrix-stats"></div>
        </div>
      </div>
    </aside>
```
（`.rail--glass` 和 `.rail--glass-aurora` 是 Task 6 深色极光玻璃效果要用的挂载点，本任务先把标记和容器加上，Task 6 再补视觉样式——加了这两个 class/容器之后、Task 6 完成之前，因为对应的 CSS 规则还不存在，页面视觉不会有变化。）

- [ ] **Step 2: styles.css——三分区样式**

在 `.chip-mark.bad {...}` 规则（`styles.css:215`）之后、`/* ── 纸面画布 ── */` 注释（`styles.css:217`）之前插入：
```css
.rail-zone--info {
  padding: 10px 12px; margin-bottom: 18px; border-radius: 10px;
  background: var(--overlay-weak); border: 1px solid var(--line-soft);
}
.rail-zone--info .rail-hint { margin: 0 0 8px; font-size: 12px; opacity: 0.85; }
.rail-zone--info .rail-hint:last-child { margin-bottom: 0; }

.rail-zone--action .rail-sec:first-child { margin-top: 0; }

.rail-zone--stats {
  margin-top: 22px; padding-top: 16px; border-top: 1px dashed var(--line-soft);
}
.rail-zone--stats .rail-sec { margin-top: 0; }
```

- [ ] **Step 3: 打包**

Run: `bash scripts/repack-tarball.sh`

- [ ] **Step 4: 手工验证**

打开沙盘页（`view-matrix`，默认首屏），侧栏应该看到三段视觉上有区分的区域：

1. 最上面一段（说明）有浅浅的背景色块和圆角，跟下面的操作控件区分开
2. 中间（操作）是原来的标签编辑器、新增分类按钮、默认产品色、新增品牌列/价格带按钮——功能和交互跟改之前完全一样，只是不再跟提示文字混排
3. 底部（统计）有一条虚线分隔，跟上面的操作区分开
4. 原有功能全部正常：新增分类、改默认色、新增品牌列/价格带、统计数字实时更新——这些是 `matrix.js` 挂载在固定 id 上的逻辑，本任务没有改 `matrix.js`，应该完全不受影响，但还是要点一遍确认没有意外破坏

- [ ] **Step 5: 提交**

```bash
git add index.html styles.css competitive-workbench.tar.gz
git commit -m "$(cat <<'EOF'
沙盘页侧栏按「说明/操作/统计」三分区重排

原来提示文字、编辑控件、统计数字按 rail-sec 小标题平铺堆叠，三种
性质不同的内容没有视觉区分——五个页面的侧栏都是这个模式，这次先在
沙盘页验证规则，阶段二会复制到其余四个页面。id 都没变，matrix.js
不需要改动。
EOF
)"
```

---

## Task 6: 深色态 · 极光玻璃（Aurora Glass）

**Files:**
- Modify: `styles.css`（新增极光装饰、玻璃拟态样式）

**Interfaces:**
- Consumes: Task 3 的 `--aurora-1`/`--aurora-2` 令牌、Task 5 的 `.rail--glass`/`.rail--glass-aurora` 挂载点、`index.html` 里 `.topbar` 的结构
- Produces: `.topbar-aurora`（顶栏装饰层，Task 需要在 `index.html` 里补上容器）、`aurora-drift-1`/`aurora-drift-2` 关键帧动画——Task 7 的浅色态会复用同一套 `[data-theme="light"]` 选择器规则隐藏这些装饰层

- [ ] **Step 1: index.html——顶栏加极光装饰容器**

`index.html:12-13` 现状：
```html
<header class="topbar">
  <div class="brandmark">
```
改成：
```html
<header class="topbar">
  <div class="topbar-aurora"><i></i><i></i></div>
  <div class="brandmark">
```

- [ ] **Step 2: styles.css——极光漂移动画 + 顶栏/侧栏装饰层**

在 Task 5 Step 2 新增的 `.rail-zone--stats .rail-sec { margin-top: 0; }` 之后插入：
```css
/* ═══════════════════════════════════════════════════════════
   深色 · 极光玻璃（Aurora Glass）
   浅色态没有这层装饰——[data-theme="light"] 直接隐藏，视觉上走
   Task 7 的商务瓷白路线。
   ═══════════════════════════════════════════════════════════ */
@keyframes aurora-drift-1 { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(22px, 14px) scale(1.06); } }
@keyframes aurora-drift-2 { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(-18px, 10px) scale(1.04); } }
@media (prefers-reduced-motion: reduce) {
  .topbar-aurora i, .rail--glass-aurora i { animation: none !important; }
}

.topbar-aurora, .rail--glass-aurora {
  /* overflow:hidden 加在这一层自己身上就够了——它会裁掉自己的子元素（光斑），
     不需要也不能在 .topbar 本身上再加一次 overflow:hidden，那样会把 #more-menu
     下拉菜单（.topbar 的后代，靠 position:absolute 撑到 topbar 高度之外）一起裁掉，
     导致菜单打不开。.rail--glass 同理不需要额外裁一层——.tagmenu 之类的浮层
     是 appendChild 到 document.body 的，不在 .rail 的 DOM 子树里，不受影响。 */
  position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 0;
}
[data-theme="light"] .topbar-aurora, [data-theme="light"] .rail--glass-aurora { display: none; }

.topbar-aurora i { position: absolute; width: 140px; height: 140px; border-radius: 50%; filter: blur(34px); opacity: 0.3; }
.topbar-aurora i:nth-child(1) { background: var(--aurora-1); top: -70px; left: 8%; animation: aurora-drift-1 12s ease-in-out infinite; }
.topbar-aurora i:nth-child(2) { background: var(--aurora-2); top: -70px; left: 46%; animation: aurora-drift-2 14s ease-in-out infinite; }

.rail--glass-aurora i { position: absolute; width: 220px; height: 220px; border-radius: 50%; filter: blur(46px); opacity: 0.4; }
.rail--glass-aurora i:nth-child(1) { background: var(--aurora-1); top: -60px; left: -60px; animation: aurora-drift-1 12s ease-in-out infinite; }
.rail--glass-aurora i:nth-child(2) { background: var(--aurora-2); bottom: -70px; right: -50px; animation: aurora-drift-2 14s ease-in-out infinite; }

.topbar > *:not(.topbar-aurora) { position: relative; z-index: 1; }
.rail--glass { position: relative; overflow: hidden; }
.rail--glass > *:not(.rail--glass-aurora) { position: relative; z-index: 1; }

[data-theme="dark"] .topbar,
:root:not([data-theme]) .topbar {
  background: rgba(16, 12, 28, 0.55);
  backdrop-filter: blur(16px) saturate(160%);
}
[data-theme="dark"] .rail--glass,
:root:not([data-theme]) .rail--glass {
  background: rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(14px) saturate(160%);
}
[data-theme="dark"] .menu,
:root:not([data-theme]) .menu {
  backdrop-filter: blur(14px) saturate(160%);
}
```
（`:root:not([data-theme])` 这条兜底是给 `<html>` 还没被 `applyTheme()` 设过 `data-theme` 属性的那一刻用的——正常情况下 `index.html` 的 FOUC 脚本或者 `core.js` 的 `boot()` 会很快设上，但理论上两者都还没跑到的极短时间窗口里，希望默认呈现的还是深色玻璃效果而不是啥都没有。）

- [ ] **Step 3: 打包**

Run: `bash scripts/repack-tarball.sh`

- [ ] **Step 4: 手工验证**

延用之前的临时服务，深色态下打开沙盘页：

1. 顶栏和侧栏应该能看到模糊的紫色/薄荷绿光斑，缓慢漂移（不是瞬间跳动）
2. 顶栏和侧栏本身应该有磨砂玻璃质感（背后内容轻微模糊），不是纯色块
3. 点⋯打开菜单，菜单本身也应该有磨砂玻璃质感
4. 切到浅色态（点"切到浅色"按钮）——光斑和玻璃模糊应该完全消失，不应该有任何极光的痕迹残留
5. 模拟 `prefers-reduced-motion: reduce`（Chrome 开发者工具 → Rendering 面板 → Emulate CSS media feature），深色态下光斑应该保持静止，不再漂移
6. 沙盘页的 PNG 导出（画布右上角"⭳ 导出 PNG"按钮）——导出结果应该跟改动前一样，不受顶栏/侧栏玻璃效果影响，因为导出只截取 `.matrix-canvas` 这个画布区域，不包含顶栏和侧栏
7. 切到「竞品对位」等未迁移的视图——顶栏的极光玻璃效果应该还在（顶栏是全局共享的），但该视图自己的侧栏应该还是原来的纯色深色，没有玻璃/极光效果（因为它的 `.rail` 没有 `rail--glass` 修饰类，Task 5 只给沙盘页的 `.rail` 加了这个类）

Expected: 以上 7 点全部符合预期，尤其是第 6、7 两点——这是本任务风险最高的两处（导出兼容性、未迁移视图不受影响），如果有偏差要停下来排查，不要继续到下一个任务。

- [ ] **Step 5: 提交**

```bash
git add index.html styles.css competitive-workbench.tar.gz
git commit -m "$(cat <<'EOF'
深色态视觉升级：极光玻璃（Aurora Glass）

顶栏（全站共享）和沙盘页侧栏加流动极光渐变团 + 强玻璃拟态，
遵循 prefers-reduced-motion。画布/板面内部不用 backdrop-filter，
维持既有的 html2canvas 导出兼容约束；未迁移视图的侧栏没有
rail--glass 修饰类，不受影响。
EOF
)"
```

---

## Task 7: 浅色态 · 商务瓷白

**Files:**
- Modify: `styles.css`（新增浅色态外壳视觉覆写）

**Interfaces:**
- Consumes: Task 3 的 `:root[data-theme="light"]` 令牌层、Task 6 的 `.topbar`/`.rail--glass`/`.menu` 结构
- Produces: 无新增 class（全部是 `[data-theme="light"]` 覆写），阶段二迁移其余页面时可以直接参照这套覆写模式

- [ ] **Step 1: styles.css——浅色态外壳覆写**

在 Task 6 Step 2 新增的 `[data-theme="dark"] .menu, :root:not([data-theme]) .menu {...}` 规则之后插入：
```css
/* ═══════════════════════════════════════════════════════════
   浅色 · 商务瓷白
   不用极光/玻璃这套语言——纯净留白 + 软彩色阴影替代灰阴影，
   定位是"日常摸数据"场景下的低疲劳度界面，克制但有质感。
   ═══════════════════════════════════════════════════════════ */
[data-theme="light"] .topbar {
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(20, 30, 60, 0.05);
  backdrop-filter: none;
}
[data-theme="light"] .topbar::after { display: none; } /* 顶栏描边漂移动效是深色态专属的"高光时刻"，浅色态不用 */

[data-theme="light"] .rail--glass {
  background: #ffffff;
  backdrop-filter: none;
}

[data-theme="light"] .menu {
  background: #ffffff;
  backdrop-filter: none;
}

/* .rail-zone--info/.stat/.solid 都是通用类名，在还没迁移的视图里也用（比如
   评论风向标/竞品3D预览/报告管理的"导入 Excel"按钮也是 .solid）。这几条覆写
   必须限定在 .view[data-theme-ready="true"] 范围内，不然全局切到浅色态时，
   未迁移视图里这几个类名的阴影颜色会跟着跳变——Task 3 的兜底层只重新声明了
   自定义属性（--bg/--mint 等），没有也不该覆盖这种不经过自定义属性、直接写
   死颜色值的 box-shadow，所以这里必须自己限定作用域，不能指望兜底层兜底。 */
[data-theme="light"] .view[data-theme-ready="true"] .rail-zone--info,
[data-theme="light"] .view[data-theme-ready="true"] .stat {
  box-shadow: 0 6px 16px -10px rgba(30, 50, 110, 0.18);
}

[data-theme="light"] .view[data-theme-ready="true"] .solid {
  box-shadow: 0 6px 18px -8px rgba(31, 158, 133, 0.45);
}
```

- [ ] **Step 2: 打包**

Run: `bash scripts/repack-tarball.sh`

- [ ] **Step 3: 手工验证**

切到浅色态，沙盘页：

1. 顶栏、侧栏、⋯菜单都应该是纯白背景，没有磨砂模糊效果（`backdrop-filter: none`），跟深色态的玻璃质感形成明显反差
2. 顶栏应该有一条很浅的阴影分隔，但没有深色态那条会漂移发光的描边线
3. 侧栏顶部的说明区块（`.rail-zone--info`）和底部统计卡片（`.stat`）应该能看出轻微的浮起阴影（彩色阴影，不是纯灰色）
4. "新增一个分类"按钮（`.solid`）的阴影应该是绿色调而不是深色态的青色调
5. 文字对比度检查：侧栏里的说明文字、按钮文字、统计数字在白色背景上应该都清晰可读，没有哪处看起来发灰看不清
6. 再切回深色态，确认 Task 6 的效果没有被这次改动影响到

- [ ] **Step 4: 提交**

```bash
git add styles.css competitive-workbench.tar.gz
git commit -m "$(cat <<'EOF'
浅色态视觉升级：商务瓷白

顶栏/侧栏/菜单切成纯白底 + 软彩色阴影，不沿用深色态的极光玻璃语言
——两套主题在这次改动里第一次表现出"真正独立视觉语言"而不是简单
反色，对应设计文档里"两套独立视觉语言"的决定。
EOF
)"
```

---

## Task 8: 验收——回归检查清单

**Files:**
- 无代码改动（除非发现问题需要修）

**Interfaces:**
- Consumes: Task 1-7 的全部产出
- Produces: 无（本任务是阶段一的验收关卡；通过之后设计文档里的验收标准才算真正兑现，阶段二可以照抄这套三分区/双主题规则）

- [ ] **Step 1: 逐条对照设计文档的验收标准**

延用之前的临时服务实例（如果关掉了，重新按 Task 2 Step 4 的方式起一个），登录 `admin`，逐条过一遍 `docs/superpowers/specs/2026-07-16-matrix-showcase-dual-theme-design.md` 里的验收标准：

1. **深浅两态在共享外壳 + 沙盘页视觉均完整可用，切换后无样式残留/闪烁**——反复切换 10 次左右，留意有没有哪次切换后颜色没完全变过来（比如某个按钮还留着上一个主题的颜色）
2. **主题偏好换设备/重新登录后保持**——退出登录再重新登录，主题应该保持切换前的状态；换一个浏览器（或无痕窗口）登录同一账号，也应该是同样的主题
3. **沙盘页 PNG 导出在两种主题下都不受 backdrop-filter 影响，保真度不下降**——深色态导出一次、浅色态导出一次，两次导出的画面应该几乎一样（导出的是画布内容，不是外壳，两次应该看不出差异），文字清晰、颜色不发灰、不丢数据
4. **未迁移的四个页面在浅色偏好下仍强制深色渲染，不出现半新半旧的视觉断层**——浅色态下依次点开竞品对位、评论风向标、竞品3D预览、报告管理，四个页面的侧栏和画布应该还是完整的深色实现，跟改动前的截图（如果留了的话）比对没有差异；只有顶栏是白色的（因为顶栏是全局共享外壳，Task 6/7 让它全站生效了），页面主体区域是深色，两者的过渡不应该显得"坏掉了"，而应该是从深色顶栏很自然地接到下方深色主体
5. **`prefers-reduced-motion` 开启时装饰性动效关闭**——用 Task 6 Step 4 第 5 点的方法模拟，深色态的极光团应该保持静止
6. **响应式断点（≤1080px / ≤760px）下侧栏三分区规则依然清晰可辨**——开发者工具里切到这两个宽度，沙盘页侧栏变成悬浮抽屉后，三个分区（说明/操作/统计）之间的视觉区分应该还在，不会因为变窄就叠在一起分不清

- [ ] **Step 2: 记录结果**

对每一条标准，确认「通过」或者「有问题」。如果有问题：定位是哪个 Task 引入的，回到对应 Task 的验证步骤重新过一遍，改代码修掉问题，重新打包（`bash scripts/repack-tarball.sh`），提交一个小的修复提交（不要往前面已经提交过的 Task 上做 `git commit --amend`），再回到 Step 1 重新走一遍完整清单。

- [ ] **Step 3: 清理临时验证目录**

```bash
rm -rf /tmp/verify-task2 /tmp/verify-task3 /tmp/verify-task4-8 2>/dev/null
```
（具体目录名以实际验证时用到的为准——每个任务的手工验证步骤都建议用独立的 `/tmp/verify-taskN` 目录，避免不同任务之间的临时服务/数据互相干扰；全部验收通过后统一清掉。）

- [ ] **Step 4: 收尾**

全部 6 条验收标准通过后，阶段一（样板间）完成。这是整站重建四阶段路线图的第一阶段——阶段二（逐页铺开）要把这套 `.rail-zone` 三分区规则和双主题令牌覆写模式复制到竞品对位/评论风向标/竞品3D预览/报告管理/管理员面板/用户管理/设置，每迁移完一个页面就把它的 `data-theme-ready` 从 `"false"` 改成 `"true"`（去掉 Task 3 Step 1 那层深色兜底），不需要新起一轮设计讨论——除非某个页面暴露出这套三分区/双主题规则不适用的特殊情况。
