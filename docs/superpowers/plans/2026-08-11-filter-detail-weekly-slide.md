# 滤芯详情页重置周报页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将“滤芯详情页重置”写入个人报告第五页，并让放映与编辑状态都能点击素材查看完整原图。

**Architecture:** 复用 `ReportSlides` 的 1280 × 720 自定义页模型，在第五页保存标题、说明文字和五张图像元素。为图片元素增加可选 `fit: 'contain'` 与 `preview: true` 元数据；渲染层将预览型图片绑定到现有 `A.lightbox`，旧长图传入原图模式以开启滚动，其余模块以完整比例居中查看。

**Tech Stack:** 原生 JavaScript、CSS、现有图片上传 API、Node `assert` 回归测试。

## Global Constraints

- 第五页固定使用现有 `pg_wfw6zso`，不改动前三页系统页和第四页自定义页。
- 画布维持 1280 × 720；主画面中所有素材用 `object-fit: contain`，不可裁切。
- 放映和编辑状态中的预览入口都不能改变报告当前页、放映状态或页面顺序。
- 旧版 790 × 13088 长图在浮窗中可垂直滚动；新模块按完整比例展示。
- PDF 仅导出第五页主视觉，不包含预览浮窗。
- 不新增第三方依赖，视觉遵循报告既有深浅主题与 `A.lightbox` 交互。

---

### Task 1: 为自定义页图片提供完整展示与预览语义

**Files:**

- Modify: `public/report-slides.js:124-161`
- Modify: `public/styles.css:1735-1739`
- Test: `report-filter-detail-slide-ui.test.js`

**Interfaces:** 图片元素可包含 `fit: 'contain'`、`preview: true`、`rawPreview: true` 和 `previewTitle`；`buildElementNode(el)` 对 `preview: true` 调用 `A.lightbox(el.url, el.previewTitle, el.rawPreview)`。

- [ ] **Step 1: Write the failing test**

```js
assert.match(slides, /el\.preview\s*&&\s*!readOnly/);
assert.match(slides, /A\.lightbox\(el\.url, el\.previewTitle.*el\.rawPreview/);
assert.match(css, /\.rs-image\.contain[\s\S]*object-fit:\s*contain/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node report-filter-detail-slide-ui.test.js`

Expected: FAIL because custom-slide images have neither preview behavior nor a contain-fit class.

- [ ] **Step 3: Write minimal implementation**

```js
if (el.preview) {
  node.classList.add('rs-previewable');
  node.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    A.lightbox(el.url, el.previewTitle || '查看原图', !!el.rawPreview);
  });
}
img.classList.toggle('contain', el.fit === 'contain');
```

Use a click handler in presentation mode and a double-click handler in editable mode so normal editing selection remains available.

- [ ] **Step 4: Run test to verify it passes**

Run: `node report-filter-detail-slide-ui.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/report-slides.js public/styles.css report-filter-detail-slide-ui.test.js
git commit -m "feat(reports): preview full custom slide images"
```

### Task 2: 导入素材并写入第五页内容

**Files:**

- Modify: `/var/lib/workbench/reports/u_fb623958.json`
- Verify: `/opt/workbench/uploads/` and `/var/lib/workbench/uploads/` as applicable to the existing upload service
- Test: `report-filter-detail-slide-ui.test.js`

**Interfaces:** `pg_wfw6zso.elements` 包含旧页面长图、四张模块预览图和结构说明文本；每个图片元素使用 `/uploads/` URL、`fit: 'contain'` 与 `preview: true`。

- [ ] **Step 1: Write the failing test**

```js
assert.match(slides, /fit === 'contain'/);
assert.match(slides, /previewTitle/);
assert.match(slides, /rawPreview/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node report-filter-detail-slide-ui.test.js`

Expected: FAIL because the new image metadata is absent.

- [ ] **Step 3: Write minimal implementation and content**

Upload these sources through the same `/api/upload` path used by `A.uploadImageFile`, then patch only `pg_wfw6zso`:

```text
temp/滤芯详情页/[Product Page] 20210929 V5-Cell.jpg
deliverables/modules/v5-cell-03-purchase-receipt-notice.png
deliverables/modules/v5-cell-04-compatible-models-v3.png
deliverables/modules/v5-cell-05-service-life-title-v3.png
deliverables/modules/v5-cell-07-parameters-v2.png
```

Create one old-page preview column, four new-module preview cards, and the following text hierarchy:

```text
滤芯详情页重置：让信息从“堆叠”变成“可被理解的模块”
本周完成：文案归类 · 区域分类 · 规范化标准化 · 模块素材输出
新版路径：了解 → 适配 → 使用 → 购买
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node report-filter-detail-slide-ui.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/report-slides.js public/styles.css report-filter-detail-slide-ui.test.js
git commit -m "feat(reports): add filter detail weekly slide"
```

### Task 3: 放映、PDF 与生产验证

**Files:**

- Verify: `public/report-slides.js`, `public/styles.css`, `/var/lib/workbench/reports/u_fb623958.json`
- Test: `report-filter-detail-slide-ui.test.js`, `report-page-order-ui.test.js`, `report-slide-master-ui.test.js`

**Interfaces:** `buildPrintPage()` 继续读取同一组 `elements`，不注入任何预览控件；`A.lightbox` 负责 Esc、遮罩关闭、长图滚动与原图显示。

- [ ] **Step 1: Write the failing test**

```js
assert.match(slides, /function buildPrintPage\(id\)/);
assert.match(slides, /preview.*buildPrintPage/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node report-filter-detail-slide-ui.test.js`

Expected: FAIL until the print path is explicitly checked to omit preview interactions.

- [ ] **Step 3: Write minimal implementation**

Keep `buildPrintPage()` image nodes as non-interactive images and apply their `contain` class so exported PDF preserves the same full-content composition.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node report-filter-detail-slide-ui.test.js
for test_file in *test.js; do node "$test_file" || exit $?; done
node --check public/report-slides.js
git diff --check
node /root/.agents/skills/impeccable/scripts/detect.mjs --json --scope layout public/report-slides.js public/styles.css
```

Expected: all tests pass; only the known local PaddleOCR `spawn ENOENT` warning may appear.

- [ ] **Step 5: Commit and deploy**

```bash
git add public/report-slides.js public/styles.css report-filter-detail-slide-ui.test.js
git commit -m "fix(reports): preserve full images in slide export"
git push origin main
git archive --format=tar HEAD | tar -x -C /opt/workbench
systemctl restart workbench.service
curl -fsS http://127.0.0.1:8090/api/health
```

Verify `/opt/workbench/public/report-slides.js` and `/opt/workbench/public/styles.css` match the committed files, then open the fifth page in normal and presentation mode to check every material opens and closes correctly.

## Plan Review

- Spec coverage: Tasks 1–2 cover complete-ratio visuals and fifth-page content; Task 1 covers presentation and editing preview; Task 3 covers PDF behavior, all tests and production deployment.
- Placeholder scan: no incomplete requirements or deferred implementation markers remain.
- Type consistency: all image metadata names are `fit`, `preview`, `rawPreview` and `previewTitle` across tasks.
