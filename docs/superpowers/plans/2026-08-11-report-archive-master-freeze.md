# 周报档案母版冻结 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让归档周报按归档时的母版版本渲染，确保后续母版更新不会覆盖历史内容。

**Architecture:** 报告快照新增 `slideMasterVersion`，当前归档写入版本 `1`。自定义页渲染器仅在版本 `1` 时创建母版 DOM；缺失或 `0` 表示历史无母版。一次性迁移脚本将现有生产档案标记为版本 `0`，不触碰页面元素和实时报告。

**Tech Stack:** Node.js CommonJS、原生 DOM、内置 `node:assert`、JSON 文件存储。

## Global Constraints

- 旧档案完整展示已保存页面元素，不叠加新的母版层。
- 归档快照必须保存母版版本；未来母版升级只能增加版本，不得修改已发布版本的资源与样式。
- 迁移只修改 `archives[*].versions[*].snapshot.report.slideMasterVersion`。
- 迁移前必须创建生产数据备份。

---

### Task 1: 将母版版本纳入快照与渲染输入

**Files:**
- Modify: `report-store.js:231-235`
- Modify: `public/report.js:87-100,1036-1042`
- Modify: `public/report-slides.js:1-122,buildPrintPage`
- Modify: `report-store.test.js`
- Create: `report-archive-master-ui.test.js`

**Interfaces:**
- Produces: `report.slideMasterVersion` with integer value `1` for newly created archives.
- Produces: `ReportSlides.setMasterVersion(version)` where `0` means do not create a master layer and `1` means render the fixed version-one master.

- [ ] **Step 1: Write failing tests**

In `report-store.test.js`, after `archiveCreate`, assert:

```js
assert.equal(archived.version.snapshot.report.slideMasterVersion, 1);
```

Create `report-archive-master-ui.test.js` with source assertions:

```js
assert.match(slides, /let masterVersion = 1/);
assert.match(slides, /function setMasterVersion\(value\)/);
assert.match(slides, /if \(masterVersion > 0\) canvas\.appendChild\(buildSlideMaster/);
assert.match(report, /ReportSlides\.setMasterVersion\(data\?\.slideMasterVersion \?\? 1\)/);
assert.match(report, /ReportSlides\.setMasterVersion\(data\.slideMasterVersion \?\? 0\)/);
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node report-store.test.js && node report-archive-master-ui.test.js`

Expected: FAIL because snapshots and renderer have no master version handling.

- [ ] **Step 3: Write minimal implementation**

Make `archiveSnapshot()` include `slideMasterVersion: 1`. Add `masterVersion` state and `setMasterVersion(value)` to `ReportSlides`; append `buildSlideMaster` in screen and PDF rendering only when the version is greater than zero. In current-report refresh select `data.slideMasterVersion ?? 1`; when opening an archive select `data.slideMasterVersion ?? 0`.

- [ ] **Step 4: Run tests to verify pass**

Run: `node report-store.test.js && node report-archive-master-ui.test.js && node --check public/report.js && node --check public/report-slides.js`

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add report-store.js report-store.test.js public/report.js public/report-slides.js report-archive-master-ui.test.js
git commit -m "fix(reports): freeze archive slide master version"
```

### Task 2: 安全迁移现有档案到无母版版本

**Files:**
- Modify: `scripts/migrate-shared-report-archives.js`
- Modify: `report-archive-migration.test.js`

**Interfaces:**
- Produces: `freezeLegacyMasters(report)` returning a deep-cloned report with every archive version's snapshot report marked `slideMasterVersion: 0` only when missing.

- [ ] **Step 1: Write failing test**

Add to `report-archive-migration.test.js`:

```js
const frozen = freezeLegacyMasters({ archives: [{ versions: [{ snapshot: { report: { slides: [{ id: 'page' }] } } }] }] });
assert.equal(frozen.archives[0].versions[0].snapshot.report.slideMasterVersion, 0);
assert.deepEqual(frozen.archives[0].versions[0].snapshot.report.slides, [{ id: 'page' }]);
```

- [ ] **Step 2: Run test to verify failure**

Run: `node report-archive-migration.test.js`

Expected: FAIL because `freezeLegacyMasters` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add `freezeLegacyMasters(report)`: clone the input, traverse every archive version, and set `snapshot.report.slideMasterVersion = 0` only if it is `undefined`. Extend the migration CLI with `--freeze-legacy-masters`, retaining existing archive merge behavior and target-file backup creation.

- [ ] **Step 4: Run tests to verify pass**

Run: `node report-archive-migration.test.js && node --check scripts/migrate-shared-report-archives.js`

Expected: all commands exit 0.

- [ ] **Step 5: Run production migration and verify**

Run:

```bash
node scripts/migrate-shared-report-archives.js --freeze-legacy-masters /var/lib/workbench/reports/u_fb623958.json
```

Verify the backup exists; both `2026-07-27` and `2026-08-03` snapshots have master version `0`; slide element counts are unchanged.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-shared-report-archives.js report-archive-migration.test.js
git commit -m "fix(reports): preserve legacy archive slide layouts"
```

### Task 3: Full regression and production deployment

**Files:**
- Modify: production `/opt/workbench` only by the approved archive deployment process.

- [ ] **Step 1: Run full suite**

Run: `for test_file in *test.js; do node "$test_file" || exit $?; done && git diff --check`

Expected: all tests pass; known PaddleOCR `spawn ENOENT` warning does not fail tests.

- [ ] **Step 2: Deploy and verify**

Run:

```bash
git push origin main
git archive --format=tar HEAD | tar -x -C /opt/workbench
systemctl restart workbench.service
curl -fsS http://127.0.0.1:8090/api/health
```

Verify deployed files match source and service is `active`.
