# 周报归档新闻重置与历史档案迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 归档后清空实时 AI 新闻但保留候选，并把旧 leo 档案安全迁移到 admin/leo 的共享档案。

**Architecture:** 在新闻存储层增加一个仅删除指定周已发布新闻与草稿的操作，由归档 API 在报告快照持久化成功后调用。迁移采用独立、幂等的 Node 脚本，将历史 leo 档案按周次和版本 ID 合并到共享 owner，不接触实时工作区数据。

**Tech Stack:** Node.js CommonJS、内置 `node:assert/strict`、JSON 文件存储、现有 HTTP API。

## Global Constraints

- 不删除任何档案、候选新闻或已存在的正式版本。
- 仅合并 admin/leo 的历史档案；不改变其他账户数据。
- 迁移前必须创建日期命名的生产数据备份。
- 保持现有 Node 直接执行测试的惯例。

---

### Task 1: 归档后清空指定周的实时新闻

**Files:**
- Modify: `report-news-store.js`
- Modify: `server.js:691-699`
- Modify: `report-news-store.test.js`

**Interfaces:**
- Consumes: `ReportNewsStore.load(userId)` 和 `ReportStore.archiveCreate(userId, weekStart, news)`。
- Produces: `ReportNewsStore.clearPublishedWeek(userId, weekStart)`，成功时返回 `{ weekStart }`。

- [ ] **Step 1: Write the failing test**

在 `report-news-store.test.js` 的临时目录 store 中先存入同一周的候选、草稿和发布新闻，再执行：

```js
await store.clearPublishedWeek('u_owner', currentWeek);
const after = await store.load('u_owner');
assert.equal(after.weeks[currentWeek], undefined);
assert.equal(after.drafts[currentWeek], undefined);
assert.ok(after.candidates[currentWeek].length);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node report-news-store.test.js`

Expected: FAIL with `store.clearPublishedWeek is not a function`.

- [ ] **Step 3: Write minimal implementation**

在 `ReportNewsStore` 中加入：

```js
async clearPublishedWeek(userId, weekStart) {
  const data = await this.load(userId);
  delete data.weeks[weekStart];
  delete data.drafts[weekStart];
  await this.save(userId, data);
  return { weekStart };
}
```

在 `server.js` 的归档路由中，在 `reports.archiveCreate(...)` 返回成功后调用：

```js
await reportNews.clearPublishedWeek(me.id, archive.weekStart);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node report-news-store.test.js && node report-store.test.js && node --check server.js`

Expected: 所有命令退出码为 0。

- [ ] **Step 5: Commit**

```bash
git add report-news-store.js report-news-store.test.js server.js
git commit -m "fix(reports): clear live news after archive"
```

### Task 2: 幂等迁移旧 leo 历史档案并验证生产数据

**Files:**
- Create: `scripts/migrate-shared-report-archives.js`
- Create: `report-archive-migration.test.js`

**Interfaces:**
- Consumes: JSON 形态 `{ archives: Array<{ weekStart, officialVersionId, versions }> }`。
- Produces: `mergeArchives(target, source)`，返回新的 target 数据；重复合并不添加同一 `weekStart + version.id`。

- [ ] **Step 1: Write the failing test**

创建 `report-archive-migration.test.js`，导入合并函数并验证：

```js
const merged = mergeArchives(
  { archives: [{ weekStart: '2026-08-03', officialVersionId: 'v2', versions: [{ id: 'v2' }] }] },
  { archives: [{ weekStart: '2026-07-27', officialVersionId: 'v1', versions: [{ id: 'v1' }] }] }
);
assert.deepEqual(merged.archives.map((item) => item.weekStart), ['2026-07-27', '2026-08-03']);
assert.deepEqual(mergeArchives(merged, { archives: [{ weekStart: '2026-07-27', officialVersionId: 'v1', versions: [{ id: 'v1' }] }] }).archives[0].versions, [{ id: 'v1' }]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node report-archive-migration.test.js`

Expected: FAIL because `scripts/migrate-shared-report-archives.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

在脚本中导出 `mergeArchives(target, source)`：深拷贝输入，按 `weekStart` 找目标档案；不存在则复制整项，存在则只追加尚未存在的 `version.id`，保持目标 `officialVersionId` 不变，最后按周次升序排序。

脚本主入口接收 `targetFile` 和 `sourceFile` 两个参数：写入前将 target 复制到 `${targetFile}.YYYY-MM-DD.shared-archive-backup.json`，再用 `mergeArchives` 写回 target。仅当作为主模块运行时执行文件操作。

- [ ] **Step 4: Run test to verify it passes**

Run: `node report-archive-migration.test.js && node --check scripts/migrate-shared-report-archives.js`

Expected: 所有命令退出码为 0。

- [ ] **Step 5: Run production migration and verify**

Run:

```bash
node scripts/migrate-shared-report-archives.js \
  /var/lib/workbench/reports/u_fb623958.json \
  /var/lib/workbench/reports/u_68a3f6f6.json
```

验证共享数据文件及 `GET /api/reports/personal/archives` 都列出 `2026-07-27` 与 `2026-08-03`；确认当前 `slides`、`daily` 与 `weimeng` 未改变。

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-shared-report-archives.js report-archive-migration.test.js
git commit -m "fix(reports): migrate shared report archives"
```

### Task 3: 完整验证与生产部署

**Files:**
- Modify: production `/opt/workbench` only through the approved archive deployment process.

**Interfaces:**
- Consumes: `main` 的两个修复提交及生产共享档案 JSON。
- Produces: 8090 服务运行新代码，历史档案与实时工作区数据均通过 API 可读。

- [ ] **Step 1: Run full regression suite**

Run:

```bash
for test_file in *test.js; do node "$test_file" || exit $?; done
git diff --check
```

Expected: 所有测试通过；已知 PaddleOCR `spawn ENOENT` 警告不应导致测试失败。

- [ ] **Step 2: Deploy main to production**

Run:

```bash
git archive --format=tar HEAD | tar -x -C /opt/workbench
systemctl restart workbench.service
curl -fsS http://127.0.0.1:8090/api/health
systemctl is-active workbench.service
```

Expected: health 返回 `{\"ok\":true}`，服务状态为 `active`。

- [ ] **Step 3: Verify live and archived boundaries**

用 production 数据文件验证当前报告 `slides` 为空、当前周 `weeks` 不含已归档周、`candidates` 仍含当前周候选；并用已登录浏览器或 API 验证两个历史周均可打开。

- [ ] **Step 4: Push main**

```bash
git push origin main
```
