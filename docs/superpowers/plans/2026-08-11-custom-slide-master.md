# 自定义页幻灯片母版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为个人报告的自定义页提供固定顶部母版与独立可编辑标题区，并迁移已有第四页。

**Architecture:** `report-slides.js` 将母版保存为页面标题字段及固定渲染层，而不是正文 `elements`。编辑、放映和 PDF 都调用同一个母版构造函数；加载时执行幂等迁移。

**Tech Stack:** 原生 JavaScript、CSS、Node 静态源码回归测试。

## Global Constraints

- 画布保持 1280 × 720，复用既有自定义页 API。
- 母版不进入 `elements`，不能被正文工具栏选择、拖动或删除。
- 仅移除旧母版的顶部四元素，既有正文保持不变。
- PDF 与放映模式展示相同母版。
- 视觉样式必须适配现有深浅主题。

---

### Task 1: 母版数据和历史页迁移

**Files:**

- Create: `report-slide-master-ui.test.js`
- Modify: `public/report-slides.js`

**Interfaces:** `migrateSlideMaster(page)` 产出 `{ id, name, title, elements }`；新页面默认 `title: '未命名页面'`。

- [ ] 写入失败测试，断言 `migrateSlideMaster(page)`、`pages.map(migrateSlideMaster)`、默认标题，以及旧顶部文字迁入 `page.title`。
- [ ] 运行 `node report-slide-master-ui.test.js`，确认因功能缺失失败。
- [ ] 实现 `isLegacyMasterElement(el)` 与 `migrateSlideMaster(page)`：识别 `y < 80` 的旧图标、标题文字和横线，迁出标题并从正文元素中移除。
- [ ] 运行聚焦测试，确认通过。
- [ ] 提交：`feat(reports): add custom slide master data`。

### Task 2: 母版渲染与标题编辑

**Files:**

- Modify: `public/report-slides.js`
- Modify: `public/styles.css`
- Test: `report-slide-master-ui.test.js`

**Interfaces:** `buildSlideMaster(page, { editable, print })` 为编辑画布和 PDF 生成一致的左标、右标、CSS 分隔线和标题节点。

- [ ] 写入失败测试，断言 `buildSlideMaster` 被编辑画布与 `buildPrintPage` 调用，标题编辑使用 `contentEditable` 并保存 `page.title`，CSS 含 `.rs-slide-master` 和 `.rs-slide-title`。
- [ ] 运行聚焦测试，确认失败。
- [ ] 实现固定母版层，标题只在可编辑状态下可输入；放映/PDF 不显示编辑态；分隔线用 CSS 绘制而非旧图片。
- [ ] 运行聚焦测试，确认通过。
- [ ] 提交：`feat(reports): render custom slide master`。

### Task 3: 正文安全区与发布前验证

**Files:**

- Modify: `public/report-slides.js`
- Modify: `public/styles.css`
- Test: `report-slide-master-ui.test.js`

**Interfaces:** 新建文字初始 `y=120`；新增图片初始位置 `y >= 100`。

- [ ] 写入失败测试，断言新文字和图片避开母版区域，并断言 PDF 使用 `buildSlideMaster(page, { print: true })`。
- [ ] 运行聚焦测试，确认失败。
- [ ] 调整新文字、图片的初始位置和母版样式，保留正文拖拽与缩放逻辑。
- [ ] 运行 `node report-slide-master-ui.test.js`、全量 `*test.js`、`node --check public/report-slides.js` 和 `git diff --check`。
- [ ] 运行 `node /root/.agents/skills/impeccable/scripts/detect.mjs --json --scope layout public/report-slides.js public/styles.css`。
- [ ] 提交：`fix(reports): reserve content space below slide master`。
