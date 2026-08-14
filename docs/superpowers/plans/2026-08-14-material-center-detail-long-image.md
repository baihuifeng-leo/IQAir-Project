# 素材中心与详情长图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有电商工作台中把素材质检升级为素材中心，增加可持久化淘宝/天猫受控登录会话和输入商品链接生成完整 PNG 详情长图的能力。

**Architecture:** 主服务继续负责工作台鉴权、API、任务持久化和静态文件；新的 `detail-worker.js` 子进程独占 Playwright/Chromium 和图片处理，主进程通过请求 ID 明确的 IPC 协议调用。平台会话、页面适配器、素材解析、PNG 合成和任务存储分别位于小型 CommonJS 模块，前端保持原生 JavaScript/CSS。

**Tech Stack:** Node.js 18+ CommonJS、原生 `http`、原生前端 JavaScript/CSS、`playwright@1.62.1`、`sharp@0.35.3`、`fflate@0.8.3`、Node 内置测试运行器 `node:test`。

## Global Constraints

- 第一阶段只实现淘宝/天猫一个默认账号、天猫与淘宝详情长图；不实现多店库存、价格、订单或其他平台连接。
- 原素材质检内部模块 ID 保持 `materialcheck`，现有词库、OCR、历史记录、权限与数据格式不得迁移或破坏。
- 浏览器用户目录、任务、临时文件和结果只写入 `DATA_DIR`，不得进入 Git、日志或前端 JSON。
- 普通用户可以查看账号状态和管理自己的详情任务；只有管理员能登录、验证、重新登录或清除平台会话。
- 任何必需素材失败时整项任务失败，不生成 PNG，不绘制红字错误占位。
- 图片全部以 `x = 0`、`drawWidth = outputWidth` 满宽等比绘制，不裁切、不拉伸、不增加左右白边。
- 只接受受支持的 HTTPS 商品 URL，并在每次主文档导航和重定向时重新执行域名与路径验证。
- 验证码和风控只报告状态，不尝试绕过。
- 生产部署不在本计划内；实现完成后提交功能分支、合并 `main` 并推送 `origin`。

---

## File Map

**Create**

- `package.json`, `package-lock.json` — 固定后端运行依赖与统一测试命令。
- `detail-url.js` — 商品 URL 规范化、导航白名单和图片域名校验。
- `platform-session-store.js` — 非敏感平台账号状态持久化。
- `detail-task-store.js` — 任务状态、所有权、保留期和结果路径管理。
- `detail-worker-client.js` — 主进程 fork、IPC 请求/响应、超时和崩溃恢复。
- `detail-worker.js` — Worker 入口和命令路由。
- `taobao-session.js` — Playwright 持久上下文、扫码登录、状态验证和账号互斥。
- `taobao-detail-adapter.js` — 天猫/淘宝详情根识别、稳定等待和素材候选抽取。
- `detail-image-resolver.js` — 候选图片下载、重试、限制与 Sharp 解码预检。
- `detail-png-composer.js` — 满宽布局、条带绘制和流式 PNG 编码。
- `png-stream-writer.js` — IHDR/IDAT/IEND 与有界 IDAT 分片。
- `detail-job-runner.js` — 页面识别、预检、合成、进度和清理编排。
- `detail-api.js` — 已认证 HTTP API 路由处理器。
- `public/platform-accounts.js` — 平台账号页面交互。
- `public/detail-long-image.js` — 详情任务创建、轮询、取消和下载 UI。
- `detail-url.test.js`, `platform-session-store.test.js`, `detail-task-store.test.js`, `detail-worker-client.test.js`, `taobao-detail-adapter.test.js`, `detail-image-resolver.test.js`, `detail-png-composer.test.js`, `detail-api.test.js`, `material-center-ui.test.js`, `install-detail.test.js` — Node 测试。

**Modify**

- `server.js` — 初始化详情模块并在现有鉴权之后分派 `/api/platform-accounts/*`、`/api/detail-jobs/*` 与结果下载。
- `public/index.html` — 素材中心抽屉、详情长图视图、平台账号视图和脚本引用。
- `public/core.js` — 新模块 ID、导航、初始化与状态显示。
- `public/styles.css` — 可访问抽屉、账号卡片和任务页面样式。
- `install.sh` — npm 生产依赖、Chromium、Worker 文件和运行目录安装。
- `workbench.service` — 浏览器缓存/临时目录环境和 systemd Chromium 所需限制。
- `.gitignore` — 本地 `data/platform-sessions`、详情结果与浏览器缓存防护。
- `README.md`, `CLAUDE.md` — 新依赖、功能、登录、测试和故障排查说明。

---

### Task 1: 安全 URL 边界与运行依赖

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `detail-url.js`
- Create: `detail-url.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `normalizeProductUrl(input) -> { platform, productId, url }`
- Produces: `assertAllowedNavigation(input) -> URL`
- Produces: `assertAllowedImageUrl(input) -> URL`
- Consumes: no feature modules.

- [ ] **Step 1: Write failing URL security tests**

Create table-driven `node:test` cases that accept the two canonical forms, remove tracking parameters, retain `id` and optional `skuId`, and reject HTTP, credentials, ports, IP literals, lookalike suffixes, non-item paths and encoded redirect URLs. Add image tests accepting `https://img.alicdn.com/...` and protocol-relative `//img.alicdn.com/...`, while rejecting `data:`, private IPs and `img.alicdn.com.evil.test`.

```js
assert.deepEqual(normalizeProductUrl('https://detail.tmall.com/item.htm?id=550555337975&spm=x&skuId=6111878169768'), {
  platform: 'taobao', productId: '550555337975',
  url: 'https://detail.tmall.com/item.htm?id=550555337975&skuId=6111878169768'
});
assert.throws(() => normalizeProductUrl('https://detail.tmall.com.evil.test/item.htm?id=1'), /不支持/);
```

- [ ] **Step 2: Run the URL tests and verify RED**

Run: `node --test detail-url.test.js`
Expected: FAIL because `detail-url.js` does not exist.

- [ ] **Step 3: Implement exact allowlists and package metadata**

Implement URL parsing with `new URL()`, exact hostname comparison, decimal positive item IDs, and reconstructed canonical URLs. Allow main navigation only for `detail.tmall.com/item.htm`, `item.taobao.com/item.htm`, `login.taobao.com`, `login.tmall.com` and explicitly tested Alibaba login redirects. Allow image hosts only when hostname equals `alicdn.com` or ends with `.alicdn.com`; force HTTPS and default port. Create scripts:

```json
{
  "scripts": { "test": "node --test *.test.js" },
  "dependencies": { "fflate": "0.8.3", "playwright": "1.62.1", "sharp": "0.35.3" }
}
```

Run `npm install --package-lock-only` and add `data/platform-sessions/`, `data/detail-jobs/`, `data/browser-cache/` to `.gitignore` without changing existing rules.

- [ ] **Step 4: Verify GREEN and regression tests**

Run: `node --test detail-url.test.js && node merge.test.js && node materialcheck.test.js`
Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json detail-url.js detail-url.test.js .gitignore
git commit -m "feat: add secure commerce URL validation"
```

---

### Task 2: 平台账号状态与详情任务存储

**Files:**
- Create: `platform-session-store.js`
- Create: `platform-session-store.test.js`
- Create: `detail-task-store.js`
- Create: `detail-task-store.test.js`

**Interfaces:**
- Produces: `new PlatformSessionStore(rootDir, { now })`, with `load()`, `get(platform, accountId)`, `setStatus(platform, accountId, status, patch)`.
- Produces: `new DetailTaskStore(rootDir, { now, retentionMs })`, with `load()`, `create(userId, input)`, `transition(id, phase, patch)`, `listFor(user)`, `getAuthorized(id, user)`, `cancel(id, user)`, `cleanupExpired()`.
- Task phases: `queued | opening | detecting | resolving | composing | completed | failed | cancelled`.

- [ ] **Step 1: Write failing store tests**

Use `fs.mkdtemp` fixtures. Assert allowed session states only, no cookie/token fields survive serialization, atomic JSON replacement, legal task transitions, owner/admin access, result path containment, cancellation and deletion of files older than 24 hours.

```js
await assert.rejects(() => sessions.setStatus('taobao', 'default', 'ready', { cookie: 'secret' }), /敏感/);
assert.throws(() => tasks.getAuthorized(task.id, { id: 'other', admin: false }), /无权/);
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test platform-session-store.test.js detail-task-store.test.js`
Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement stores with atomic writes**

Use one `sessions.json` and one `tasks.json` under their supplied roots; write to a sibling `.tmp`, `fsync`, then rename. Persist only whitelisted fields. Validate all IDs before joining paths and resolve paths back under the configured root. Default task retention is `86_400_000` ms.

- [ ] **Step 4: Run store tests**

Run: `node --test platform-session-store.test.js detail-task-store.test.js`
Expected: PASS with no open-handle warning.

- [ ] **Step 5: Commit**

```bash
git add platform-session-store.js platform-session-store.test.js detail-task-store.js detail-task-store.test.js
git commit -m "feat: persist platform sessions and detail jobs"
```

---

### Task 3: Worker IPC and 淘宝持久会话

**Files:**
- Create: `detail-worker-client.js`
- Create: `detail-worker-client.test.js`
- Create: `detail-worker.js`
- Create: `taobao-session.js`
- Create: `taobao-session.test.js`

**Interfaces:**
- Produces: `new DetailWorkerClient({ fork, timeoutMs })` with `start()`, `request(type, payload, { timeoutMs })`, `close()` and `on('event', listener)`.
- Produces Worker commands: `session.status`, `session.beginLogin`, `session.qr`, `session.verify`, `session.clear`, `detail.run`, `detail.cancel`.
- Produces: `new TaobaoSession({ dataDir, chromium, statusStore, emit })` with matching session methods and `runExclusive(accountId, fn)`.

- [ ] **Step 1: Write failing IPC tests**

Use a fake child process EventEmitter. Assert request IDs correlate out-of-order responses, timeout removes pending requests, child exit rejects every request, events do not resolve requests, and restart creates a fresh child.

- [ ] **Step 2: Run IPC tests and verify RED**

Run: `node --test detail-worker-client.test.js`
Expected: FAIL because client module is missing.

- [ ] **Step 3: Implement Worker client and command envelope**

Use envelopes `{ kind:'request', id, type, payload }`, `{ kind:'response', id, ok, result|error }`, and `{ kind:'event', type, payload }`. Serialize errors to `{ code, message }`; never include stack traces in messages returned to the browser.

- [ ] **Step 4: Write failing session tests with fake Playwright**

Assert one persistent context per account directory, one operation at a time, QR screenshot bytes are held only in memory, `ready` requires a successful protected-page probe, login/challenge selectors map to distinct states, clearing closes context and removes only the exact account directory.

- [ ] **Step 5: Run session tests and verify RED**

Run: `node --test taobao-session.test.js`
Expected: FAIL because `taobao-session.js` is missing.

- [ ] **Step 6: Implement session lifecycle and Worker routing**

Launch Chromium headless with `chromium.launchPersistentContext(accountDir, { headless: true, viewport: { width: 1440, height: 1000 } })`. Detect login/challenge using URL host plus stable semantic text/selectors. `beginLogin` opens the official login flow, captures only the QR element, and emits state events. `runExclusive` uses a per-account promise mutex and always releases in `finally`.

- [ ] **Step 7: Run Worker and session tests**

Run: `node --test detail-worker-client.test.js taobao-session.test.js`
Expected: PASS and all fake contexts/pages are closed.

- [ ] **Step 8: Commit**

```bash
git add detail-worker-client.js detail-worker-client.test.js detail-worker.js taobao-session.js taobao-session.test.js
git commit -m "feat: add isolated taobao browser sessions"
```

---

### Task 4: 天猫与淘宝详情适配器

**Files:**
- Create: `taobao-detail-adapter.js`
- Create: `taobao-detail-adapter.test.js`

**Interfaces:**
- Consumes: `assertAllowedImageUrl` from `detail-url.js`.
- Produces: `extractDetail(page, { timeoutMs, emit }) -> { title, productId, blocks }`.
- Image block shape: `{ kind:'image', candidates:string[], domIndex:number }`; text/table/video blocks use serialized values only.

- [ ] **Step 1: Write failing adapter fixture tests**

Use a fake Page implementing `locator`, `evaluate` and controlled mutation counts. Include separate Tmall and Taobao DOM fixtures, recommendation/review decoys, `currentSrc`, mixed `srcset`, stale lazy URLs, placeholder data URIs, protocol-relative CDN URLs, and a fourth-screen lazy image that appears only after the controlled page scroll.

Assert the Worker page scrolls while the user's workbench page is untouched because scrolling exists only inside the fake controlled Page. Assert DOM order and candidate order/deduplication exactly.

- [ ] **Step 2: Run adapter tests and verify RED**

Run: `node --test taobao-detail-adapter.test.js`
Expected: FAIL because adapter module is missing.

- [ ] **Step 3: Implement site-specific roots and shared extraction**

Use explicit root selector arrays per site; reject ambiguous roots rather than selecting the largest image container. Within the controlled browser page, scroll the detail root/page by viewport increments until root height, image count and mutation count remain unchanged for three observations or timeout. Return `DETAIL_INCOMPLETE` on timeout. Sort `srcset` candidates numerically descending and preserve `currentSrc` first.

- [ ] **Step 4: Verify adapter tests**

Run: `node --test taobao-detail-adapter.test.js detail-url.test.js`
Expected: PASS for Tmall, Taobao, exclusions and incomplete-page cases.

- [ ] **Step 5: Commit**

```bash
git add taobao-detail-adapter.js taobao-detail-adapter.test.js
git commit -m "feat: extract tmall and taobao detail assets"
```

---

### Task 5: 候选资源预检与失败原子性

**Files:**
- Create: `detail-image-resolver.js`
- Create: `detail-image-resolver.test.js`

**Interfaces:**
- Consumes: adapter image blocks and `assertAllowedImageUrl`.
- Produces: `resolveAllImages(blocks, { request, sharp, signal, limits, emit }) -> ResolvedBlock[]`.
- Failure: throws `{ code:'ASSET_UNAVAILABLE', assetIndex, candidates, message }` and releases every previous resource.

- [ ] **Step 1: Write failing resolver tests**

Test first-candidate 404 then second success, retry-once network error, invalid content type, empty body, 50 MiB single-resource cap, 500 MiB task cap, Sharp decode error, abort, and all-candidates failure. Assert candidate URLs are length-limited in errors and successful metadata uses decoded width/height rather than DOM attributes.

- [ ] **Step 2: Run resolver tests and verify RED**

Run: `node --test detail-image-resolver.test.js`
Expected: FAIL because resolver is missing.

- [ ] **Step 3: Implement bounded browser-context downloads**

Pass a request function backed by the Playwright context so it shares the authenticated session. Stream response bytes while enforcing limits instead of trusting `Content-Length`. Probe with `sharp(buffer, { animated:false, limitInputPixels:false }).metadata()`. Keep buffers only until composition, zero/drop references on failure and abort, and never create error blocks.

- [ ] **Step 4: Verify resolver tests**

Run: `node --test detail-image-resolver.test.js`
Expected: PASS; tests assert no composer invocation on failure.

- [ ] **Step 5: Commit**

```bash
git add detail-image-resolver.js detail-image-resolver.test.js
git commit -m "feat: preflight all detail image candidates"
```

---

### Task 6: 满宽条带 PNG 合成器

**Files:**
- Create: `png-stream-writer.js`
- Create: `detail-png-composer.js`
- Create: `detail-png-composer.test.js`

**Interfaces:**
- Consumes: resolved image/video blocks `{ buffer, width, height }` plus serialized text/table blocks from the adapter.
- Produces: `composeDetailPng(blocks, { outputPath, stripHeight=512, signal, sharp, emit }) -> { width, height, size, sha256 }`.
- Produces: `PngStreamWriter(width, height, writable)` with `writeRows(rgbaRows)` and `finish()`.

- [ ] **Step 1: Write failing PNG writer tests**

Port the extension writer invariants into `node:test`: valid signature/IHDR/IEND, CRC verification, decompressed scanlines byte equality, IDAT payloads no larger than 64 KiB, incremental writes and abort cleanup.

- [ ] **Step 2: Run writer tests and verify RED**

Run: `node --test detail-png-composer.test.js`
Expected: FAIL because writer/composer modules are missing.

- [ ] **Step 3: Implement streaming writer and full-width layout**

Use `fflate.Zlib` incrementally and split compressed data into maximum 64 KiB IDAT chunks. Set `outputWidth = max(image.width)`. For every image/video poster use `drawWidth=outputWidth`, `drawHeight=Math.round(height*outputWidth/width)`, `x=0`; GIF decoding uses Sharp page 0. Render escaped text and table cells to bounded SVG using the installed `Noto Sans CJK SC` font, rasterize with Sharp, and include them in DOM order without allowing them to enlarge `outputWidth`. Use Sharp to resize/crop the exact source rows intersecting each 512-row strip into RGBA, blend at y-offset, write rows, then release the strip.

- [ ] **Step 4: Add cross-strip and mixed-width assertions**

Use generated solid/checker fixtures at 750×901, 790×1200 and 1200×333 plus Chinese text and a two-column table. Decode the output with Sharp and assert output width 1200, exact calculated total height, edge pixels spanning full width, no white side columns, correct colors immediately before/after every strip boundary, readable text/table regions, video-poster labeling, GIF first-frame behavior, and no red error pixels/text path.

- [ ] **Step 5: Run composer tests**

Run: `node --test detail-png-composer.test.js`
Expected: PASS including mixed widths and multi-strip continuity.

- [ ] **Step 6: Commit**

```bash
git add png-stream-writer.js detail-png-composer.js detail-png-composer.test.js
git commit -m "feat: compose full-width streaming detail pngs"
```

---

### Task 7: 详情任务编排、API 与权限

**Files:**
- Create: `detail-job-runner.js`
- Create: `detail-api.js`
- Create: `detail-api.test.js`
- Modify: `detail-worker.js`
- Modify: `server.js`

**Interfaces:**
- Consumes: stores, worker client, URL validator, session, adapter, resolver and composer.
- Produces authenticated endpoints:
  - `GET /api/platform-accounts`
  - `POST /api/platform-accounts/taobao/default/login`
  - `GET /api/platform-accounts/taobao/default/qr`
  - `POST /api/platform-accounts/taobao/default/verify`
  - `DELETE /api/platform-accounts/taobao/default/session`
  - `GET /api/detail-jobs`
  - `POST /api/detail-jobs`
  - `GET /api/detail-jobs/:id`
  - `POST /api/detail-jobs/:id/cancel`
  - `GET /api/detail-jobs/:id/download`

- [ ] **Step 1: Write failing API tests**

Use injected fake stores/worker and direct handler calls. Assert anonymous 401, ordinary-user account status 200, ordinary-user login/verify/clear 403, QR admin-only and `Cache-Control: no-store`, URL rejection before Worker invocation, task ownership, admin all-task access, cancellation, PNG content headers, containment-safe result files and no download for failed/incomplete jobs.

- [ ] **Step 2: Run API tests and verify RED**

Run: `node --test detail-api.test.js`
Expected: FAIL because API module is missing.

- [ ] **Step 3: Implement job runner and API router**

Make `detail-api.js` return `true` when it handled a route so `server.js` can call it immediately after existing authentication and before legacy API branches. Store task before sending Worker command. Consume Worker progress events to transition tasks and broadcast the existing SSE channel with event `detail-job`. On any error, remove partial output and transition once to structured failure.

- [ ] **Step 4: Wire lifecycle into server startup/shutdown**

Create `DATA_DIR/platform-sessions` and `DATA_DIR/detail-jobs`, load stores, start Worker, run cleanup at startup and every hour. On `SIGTERM` stop accepting new detail jobs, cancel Worker operations, close Worker, then close the HTTP server without changing OCR startup behavior.

- [ ] **Step 5: Run API and existing server tests**

Run: `node --test detail-api.test.js detail-task-store.test.js detail-worker-client.test.js && node merge.test.js && node materialcheck.test.js`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add detail-job-runner.js detail-api.js detail-api.test.js detail-worker.js server.js
git commit -m "feat: expose authenticated detail image jobs"
```

---

### Task 8: 素材中心导航与平台账号页面

**Files:**
- Create: `public/platform-accounts.js`
- Create: `material-center-ui.test.js`
- Modify: `public/index.html`
- Modify: `public/core.js`
- Modify: `public/styles.css`

**Interfaces:**
- Produces global `PlatformAccounts.init(A)` and `PlatformAccounts.onShow()`.
- Adds views `materialcheck`, `detail-long-image`, `platform-accounts`; user preference module key remains `materialcheck`, while the two new views remain visible as specified.

- [ ] **Step 1: Write failing static UI contract tests**

Parse source text/HTML with deterministic assertions: one `素材中心` trigger with `aria-haspopup`, two submenu buttons, standalone `平台账号` tab, corresponding view sections, script order after `core.js` dependencies, Escape handler, focus-in/focus-out handling and no renamed `/api/materialcheck` routes.

- [ ] **Step 2: Run UI test and verify RED**

Run: `node --test material-center-ui.test.js`
Expected: FAIL because the new navigation does not exist.

- [ ] **Step 3: Implement accessible navigation and account cards**

Keep `data-view="materialcheck"` on the default action. Add a parent `素材中心` control plus submenu using `aria-expanded`, `aria-controls` and roving focus. Open on pointer enter/focus/click, close on delayed pointer leave, outside click or Escape. Add account state rendering, admin-only action controls, QR refresh with object URL revocation, and status polling only while the view is active.

- [ ] **Step 4: Verify UI contract and legacy material tests**

Run: `node --test material-center-ui.test.js && node materialcheck.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/core.js public/styles.css public/platform-accounts.js material-center-ui.test.js
git commit -m "feat: add material center and platform accounts navigation"
```

---

### Task 9: 详情长图前端与任务恢复

**Files:**
- Create: `public/detail-long-image.js`
- Create: `detail-long-image-ui.test.js`
- Modify: `public/index.html`
- Modify: `public/core.js`
- Modify: `public/styles.css`

**Interfaces:**
- Produces global `DetailLongImage.init(A)` and `DetailLongImage.onShow()`.
- Consumes Task 7 API and SSE `detail-job` events.

- [ ] **Step 1: Write failing frontend state tests**

Run the module in `vm` with fake DOM/fetch. Assert URL submit, disabled duplicate submit, phase labels, asset counts, distinct login/challenge/resource/timeout errors, cancel ownership, completed download link, expired result handling, page re-entry loading recent tasks, and object URLs/event listeners cleaned on re-render.

- [ ] **Step 2: Run UI tests and verify RED**

Run: `node --test detail-long-image-ui.test.js`
Expected: FAIL because module is missing.

- [ ] **Step 3: Implement detail page markup and controller**

Create a single URL form, account status summary, progress meter, current-item label, retry action, cancel action, recent jobs list and download link. Use the shared `A.guard` and `A.toast`; never inject server text with `innerHTML`. Poll only when there are active jobs and also consume SSE for immediate updates.

- [ ] **Step 4: Integrate view routing**

Extend `core.js` `go()` to call `PlatformAccounts.onShow()` and `DetailLongImage.onShow()` without changing document editing controls. Hashes `#materialcheck`, `#detail-long-image` and `#platform-accounts` must restore correctly. Hiding `materialcheck` in user preferences hides the entire素材中心 group, not the standalone平台账号 entry.

- [ ] **Step 5: Verify frontend tests**

Run: `node --test detail-long-image-ui.test.js material-center-ui.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add public/detail-long-image.js detail-long-image-ui.test.js public/index.html public/core.js public/styles.css
git commit -m "feat: add detail long image workspace"
```

---

### Task 10: 安装、服务约束、文档与端到端验收

**Files:**
- Create: `install-detail.test.js`
- Modify: `install.sh`
- Modify: `workbench.service`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes all earlier modules.
- Produces repeatable Ubuntu installation and documented operator workflow.

- [ ] **Step 1: Write failing install contract tests**

Assert `install.sh` copies every new runtime `.js`, `package.json` and lock file; runs `npm ci --omit=dev`; installs Playwright Chromium and OS dependencies; creates `platform-sessions`, `detail-jobs/results`, `detail-jobs/tmp`, and browser cache directories; gives only `workbench` write access; and does not delete session directories on reinstall. Assert systemd permits required Chromium namespaces/syscalls while keeping `ProtectSystem=strict`, `ProtectHome=true` and `ReadWritePaths=/var/lib/workbench`.

- [ ] **Step 2: Run install tests and verify RED**

Run: `node --test install-detail.test.js`
Expected: FAIL because install script lacks browser support.

- [ ] **Step 3: Implement repeatable installation**

Copy exact module files, run locked production install in `/opt/workbench`, install Chromium plus `fonts-noto-cjk` before applying service-user permissions, set `PLAYWRIGHT_BROWSERS_PATH=/var/lib/workbench/browser-cache`, and create data subdirectories with mode 0750. Adjust systemd only as required by a real Chromium smoke test; document every relaxed directive beside it.

- [ ] **Step 4: Update operator documentation**

Document Material Center navigation, admin QR login, session states, result retention, supported URLs, resource failure behavior, commands `npm test`, browser reinstall, disk paths, journal filters, reset-session procedure, and that production needs outbound HTTPS access.

- [ ] **Step 5: Run full automated verification**

Run:

```bash
npm ci
npm test
node merge.test.js
node materialcheck.test.js
node --check server.js
node --check detail-worker.js
node --check public/platform-accounts.js
node --check public/detail-long-image.js
```

Expected: every command exits 0 with zero failing tests.

- [ ] **Step 6: Run local authenticated smoke test**

Start with an isolated directory:

```bash
DETAIL_TEST_DATA="$(mktemp -d)"
PORT=9090 DATA_DIR="$DETAIL_TEST_DATA" node server.js
```

Verify `/api/health`, login, ordinary-user/admin API boundaries,素材中心 default route,平台账号 view, Worker startup and clean shutdown. Then use the approved real Tmall URL and one user-supplied/verified Taobao URL to perform administrator scan login and end-to-end PNG inspection. Record scroll-independent server execution, recognized asset count, output width/height and absence of red error placeholders.

- [ ] **Step 7: Review diff and commit deployment/docs**

Run `git diff --check`, inspect `git status --short`, and confirm `.claude/`, `.planning/`, runtime data, browser profiles and generated PNGs are not staged.

```bash
git add install.sh workbench.service README.md CLAUDE.md install-detail.test.js
git commit -m "docs: deploy and operate detail image capture"
```

- [ ] **Step 8: Final code review and remediation gate**

Use `superpowers:requesting-code-review` against the feature branch. Resolve every confirmed spec or correctness issue with a failing regression test first. Re-run the full Step 5 verification and the relevant smoke path after fixes.

- [ ] **Step 9: Merge and push**

After explicit verification, update from remote without discarding local changes, merge the feature branch into `main`, rerun `npm test`, `node merge.test.js`, and `node materialcheck.test.js`, then push `main` to `origin`. Do not run `install.sh` or `deploy-to-prod.sh`.

```bash
git switch main
git pull --ff-only origin main
git merge --no-ff feature/material-center-detail-long-image
git push origin main
```
