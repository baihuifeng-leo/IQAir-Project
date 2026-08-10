# AI 新闻封面选择 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每条已生成的 AI 新闻选出更适合放映的封面，并提供安全的人工覆盖入口。

**Architecture:** `ReportNewsStore` 负责从原文提取、评分、持久化可换封面；服务端提供账户隔离的换封面接口；报告页在已生成卡片和候选选择浮层中提供换图与原图上传入口。

**Tech Stack:** Node.js、原生 JavaScript、CSS、现有 `/api/upload` 上传接口、Node assert 测试。

## Global Constraints

- 只接受正文或 OG 图中的公开 URL；不抓取搜索引擎或随机图库。
- 自动选择必须偏好可完整呈现的横图，并排除广告、二维码、Logo。
- 用户上传的封面必须保存在本站 `/uploads/`；所有新闻数据保持账户隔离。
- 未配置图像生成服务时，摘要发布必须成功且界面提供手动入口。

---

### Task 1: 原文图片候选与评分

**Files:**
- Modify: `report-news-store.js`
- Test: `report-news-store.test.js`

- [x] 写一个失败测试：语义相关的横版正文图胜过 OG 图与竖版无关图。
- [x] 运行 `node report-news-store.test.js`，确认失败来自缺少候选选择行为。
- [x] 实现图片候选提取、淘汰与评分，并在生成稿保存 `coverOptions`。
- [x] 再次运行 `node report-news-store.test.js`，确认通过。

### Task 2: 已生成新闻的封面覆盖

**Files:**
- Modify: `report-news-store.js`
- Modify: `server.js`
- Test: `report-news-store.test.js`

- [x] 写一个失败测试：只能替换本账户、指定周、指定新闻的候选封面或本站上传图。
- [x] 运行 `node report-news-store.test.js`，确认失败。
- [x] 实现封面替换与输入校验，增加账户受限 API。
- [x] 再次运行 `node report-news-store.test.js`，确认通过。

### Task 3: 报告页换图与上传入口

**Files:**
- Modify: `public/report.js`
- Modify: `public/styles.css`
- Test: `report-news-ui.test.js`

- [x] 写一个失败测试：新闻卡片有换图与上传入口，并仍保留原图预览和原文链接。
- [x] 运行 `node report-news-ui.test.js`，确认失败。
- [x] 实现紧凑操作区、上传处理与失败提示；不改变放映模式布局。
- [x] 运行 UI 测试及 Impeccable 检测器。

### Task 4: 发布校验与部署

**Files:**
- Verify: `report-news-store.test.js`, `report-news-ui.test.js`, `*test.js`

- [x] 执行全量测试。
- [x] 归档、提交、推送 main，并部署至生产。
- [x] 检查健康接口与生产进程配置，验证新闻摘要服务不因封面处理失败而中断。
