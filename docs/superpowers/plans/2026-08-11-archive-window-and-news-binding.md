# 周报档案独立窗口与新闻周绑定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 历史周报以独立窗口查看或修订，并且归档只关联相同周次的 AI 新闻。

**Architecture:** 主页面保留实时状态；历史窗口从 `archive=1`、`weekStart`、`versionId`、`editable=1` URL 参数初始化。归档路由取消跨周新闻回退；迁移脚本只清除 2026-07-27 快照的错误新闻并备份。

**Tech Stack:** 原生浏览器 JavaScript、Node.js 内置 `assert`、JSON 文件、systemd。

## Global Constraints

- 保持 `main` 直接部署生产。
- 保持历史快照的 `slideMasterVersion` 冻结行为。
- 只修复共享账户 2026-07-27 的错配新闻，并在写入前备份。
- 不增加第三方依赖。

---

### Task 1: 限制归档新闻到相同周

**Files:** Modify `server.js:691-700`; Test `report-store.test.js`, `report-archive-ui.test.js`.

**Interfaces:** 路由传给 `ReportStore.archiveCreate(userId, weekStart, news)` 的值只能是 `newsData.weeks[input.weekStart] || null`。

- [ ] 写失败测试：`report-store.test.js` 建立 `archiveCreate('u1', '2026-07-27', null)` 并断言 `snapshot.news === null`；`report-archive-ui.test.js` 断言 `server.js` 不含 `|| (await reportNews.summary(me.id)).news`。
- [ ] 运行 `node report-archive-ui.test.js`，预期因旧跨周回退表达式失败。
- [ ] 在 `server.js` 用 `const currentNews = newsData.weeks[input.weekStart] || null;` 取代 summary 后备。
- [ ] 运行 `node report-store.test.js && node report-archive-ui.test.js`，预期退出码均为 0。
- [ ] 提交：`git add server.js report-store.test.js report-archive-ui.test.js && git commit -m "fix(reports): bind archive news to its week"`。

### Task 2: 独立窗口加载档案

**Files:** Modify `public/report.js:33-99, 1010-1055, 1100-1175`; Test `report-archive-ui.test.js`.

**Interfaces:** 新函数 `openArchiveWindow(weekStart, versionId, editable)` 创建独立 URL；启动解析 URL 后调用已有 `openArchive(archiveWeek, archiveVersion, archiveEditable)`。

- [ ] 写失败测试：断言 `report.js` 含 `openArchiveWindow`、`new URLSearchParams(window.location.search)`、`window.open(archiveUrl.toString(), '_blank', 'noopener')` 与 URL 驱动的 `openArchive`；断言档案“查看”不再调用主窗口 `openArchive(item.weekStart, version.id, false)`。
- [ ] 运行 `node report-archive-ui.test.js`，预期因新窗口逻辑未实现失败。
- [ ] 实现 `openArchiveWindow`：在当前 URL 写入 `archive=1`、周、版本及可选 editable，执行 `window.open`。启动时若参数齐全则加载档案，隐藏档案入口、归档操作、导入和新闻候选编辑。查看调用 `openArchiveWindow(..., false)`；创建修订后调用 `openArchiveWindow(..., true)`，不覆盖主窗口状态。
- [ ] 运行 `node report-archive-ui.test.js && node report-archive-master-ui.test.js && node report-pdf-ui.test.js`，预期退出码均为 0。
- [ ] 提交：`git add public/report.js report-archive-ui.test.js && git commit -m "fix(reports): open archives in separate windows"`。

### Task 3: 精确修复历史快照

**Files:** Modify `scripts/migrate-shared-report-archives.js`; Test `report-archive-migration.test.js`.

**Interfaces:** 导出 `clearMismatchedArchiveNews(report, weekStart)`，仅将所给周中 `snapshot.news.weekStart !== weekStart` 的新闻置空。CLI 为 `--clear-mismatched-news 2026-07-27 FILE`。

- [ ] 写失败测试：输入 7.27→8.03 和 8.03→8.03 两个快照，断言只前者被置为 null。
- [ ] 运行 `node report-archive-migration.test.js`，预期缺少导出函数而失败。
- [ ] 实现深复制修复函数和 CLI；只在目标周确有错配时按现有日期备份命名写备份与数据，其他版本不变。
- [ ] 运行 `node report-archive-migration.test.js`，预期退出码为 0。
- [ ] 提交：`git add scripts/migrate-shared-report-archives.js report-archive-migration.test.js && git commit -m "fix(reports): repair mismatched archive news"`。

### Task 4: 验证与生产部署

**Files:** Deploy `/opt/workbench`; data mutation `/var/lib/workbench/reports/u_fb623958.json`.

- [ ] 运行 `for test_file in *test.js; do node "$test_file" || exit $?; done` 和 `git diff --check`；所有测试必须通过，已知 PaddleOCR 警告不能导致失败。
- [ ] 用 `git archive --format=tar HEAD | tar -x -C /opt/workbench` 部署，重启 `workbench.service`，检查 `curl -fsS http://127.0.0.1:8090/api/health` 与 `systemctl is-active workbench.service`。
- [ ] 执行 `node scripts/migrate-shared-report-archives.js --clear-mismatched-news 2026-07-27 /var/lib/workbench/reports/u_fb623958.json`。
- [ ] 检查 7.27 新闻为 null、8.03 新闻周仍为 8.03，以及关键生产源码与仓库一致。
- [ ] `git push origin main` 并报告提交、验证及备份路径。
