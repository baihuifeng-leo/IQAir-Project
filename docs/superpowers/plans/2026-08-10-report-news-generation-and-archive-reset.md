# AI 新闻生成与周报归档重置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让生产服务加载现有 AI 配置，并让归档后的当前个人报告保留前两页数据、第三页回到待生成状态且保留候选新闻。

**Architecture:** 新闻生成配置继续由 systemd 的 `/etc/workbench/ai.env` 注入；应用代码不读取或保存密钥。新闻摘要接口只公开当前周已发布内容，历史新闻仍由周报档案快照读取；候选新闻继续按当前周保存。

**Tech Stack:** Node.js、原生 JavaScript、systemd、现有 `ReportNewsStore` 文件存储与 Node `assert` 测试。

## Global Constraints

- 不输出、提交或复制 AI 密钥。
- 不删除历史档案、日报、微盟数据或新闻候选。
- 不新增后台队列；生成请求保持现有同步交互。
- 部署后先确认 AI 环境变量存在性与健康接口，再由用户重新提交两条候选新闻。

---

### Task 1: 让新闻存储测试与实际当前周同步

**Files:**
- Modify: `report-news-store.test.js:26-95`

**Interfaces:**
- Consumes: 已导出的 `mondayOf()`。
- Produces: 既有发布、生成、草稿测试全部使用运行时的当前周，而不依赖固定日历日期。

- [ ] **Step 1: Replace fixed current-week values in the existing flow**

在异步测试函数起始处定义：

```js
const currentWeek = mondayOf();
```

将同一条“保存草稿 → 发布 → 读取摘要 → 生成”的既有测试链路中的 `2026-08-03` 全部替换为 `currentWeek`。保留 RSS 解析的固定日期断言，因为它不依赖 `summary()`。

- [ ] **Step 2: Run baseline test**

Run: `node report-news-store.test.js`

Expected: PASS，证明既有流程测试不会在跨周后误报失败。

- [ ] **Step 3: Commit with the feature change**

该测试稳定化与当前周隔离属于同一行为变更，和 Task 2 一起提交。

### Task 2: 锁定当前周新闻摘要语义

**Files:**
- Modify: `report-news-store.test.js:26-95`
- Modify: `report-news-store.js:164`

**Interfaces:**
- Consumes: `ReportNewsStore.summary(userId)`。
- Produces: `summary()` 在当前周没有发布稿时返回 `{ news: null, candidates: currentWeekCandidates }`，不会回退到上一个发布周。

- [ ] **Step 1: Write the failing test**

在既有测试之外创建独立的 `rolloverStore`，保存一个上一周的发布稿和当前周候选：

```js
const prior = new Date(); prior.setDate(prior.getDate() - 7);
const priorWeek = mondayOf(prior);
const rolloverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-news-rollover-'));
const rolloverStore = new ReportNewsStore(rolloverDir);
await rolloverStore.save('u_owner', {
  weeks: { [priorWeek]: { weekStart: priorWeek, pages: { global: [card(1), card(2)] } } },
  drafts: {}, candidates: { [currentWeek]: [{ id: 'next', ...card(7), tags: ['站长之家优选'] }] }
});
const current = await rolloverStore.summary('u_owner');
assert.equal(current.news, null, '当前周没有发布稿时不能回退显示上周新闻');
assert.equal(current.candidates.length, 1, '当前周候选应保留供重新选择');
fs.rmSync(rolloverDir, { recursive: true, force: true });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node report-news-store.test.js`

Expected: FAIL，断言会读到 2026-08-03 的历史新闻。

- [ ] **Step 3: Write minimal implementation**

将 `report-news-store.js` 中的 `summary` 改为只取当前周：

```js
async summary(userId) {
  const data = await this.load(userId);
  const key = mondayOf();
  return { weekStart: key, news: data.weeks[key] || null, candidates: data.candidates[key] || [], lastAttempt: data.lastAttempt || null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node report-news-store.test.js`

Expected: PASS，既有生成、发布、候选抓取与跨账户隔离断言均保持通过。

- [ ] **Step 5: Commit**

```bash
git add report-news-store.js report-news-store.test.js
git commit -m "fix(reports): keep current news week isolated"
```

### Task 3: 更新生产 systemd 服务配置并验证 AI 可用性

**Files:**
- Deploy: `/opt/workbench/workbench.service` → `/etc/systemd/system/workbench.service`
- Read: `/etc/workbench/ai.env`

**Interfaces:**
- Consumes: 已存在且权限受限的 `/etc/workbench/ai.env`。
- Produces: `workbench.service` 通过 `EnvironmentFile=-/etc/workbench/ai.env` 将 `AI_API_KEY` 与 `AI_MODEL` 注入 Node 进程。

- [ ] **Step 1: Verify deployment unit contains the configuration hook**

Run:

```bash
rg -n '^EnvironmentFile=-/etc/workbench/ai\.env$' /opt/workbench/workbench.service
```

Expected: 返回唯一的 `EnvironmentFile` 行。

- [ ] **Step 2: Install and reload the service definition**

Run:

```bash
install -m 0644 /opt/workbench/workbench.service /etc/systemd/system/workbench.service
systemctl daemon-reload
systemctl restart workbench.service
```

Expected: 服务重启成功；不打印环境文件内容。

- [ ] **Step 3: Verify environment presence and health**

Run:

```bash
systemctl is-active workbench.service
systemctl show workbench.service -p EnvironmentFiles
curl -fsS http://127.0.0.1:8090/api/health
```

Expected: `active`、`EnvironmentFiles` 指向 `/etc/workbench/ai.env`、健康接口返回 `{"ok":true}`。

- [ ] **Step 4: Verify runtime receives only presence markers**

Run a root-only inspection that prints `AI_API_KEY=SET` and `AI_MODEL=SET` without displaying values.

Expected: 两个变量均为 `SET`。

- [ ] **Step 5: Commit application source deployment state**

No repository change is expected from the unit installation. Keep this task’s deployment evidence in the release handoff; do not commit `/etc/workbench/ai.env`.

### Task 4: 完整回归、发布与用户验证

**Files:**
- Modify: `report-news-store.test.js`（Task 1）
- Read: `report-store.test.js`, `report-archive-ui.test.js`

**Interfaces:**
- Consumes: 当前周新闻摘要语义与 systemd AI 配置。
- Produces: 可部署的 `main` 与清晰的重新生成操作指引。

- [ ] **Step 1: Run focused regression checks**

Run:

```bash
node report-news-store.test.js
node report-store.test.js
node report-archive-ui.test.js
node --check report-news-store.js
git diff --check
```

Expected: 全部通过，且无 diff 空白错误。

- [ ] **Step 2: Push application change**

Run:

```bash
git push origin main
git archive --format=tar HEAD | tar -x -C /opt/workbench
```

Expected: `main` 推送成功；应用代码更新但 `/var/lib/workbench` 数据保持不变。

- [ ] **Step 3: Restart and health-check after code deployment**

Run:

```bash
systemctl restart workbench.service
curl -fsS http://127.0.0.1:8090/api/health
```

Expected: 服务为 `active` 且健康接口返回 `{"ok":true}`。

- [ ] **Step 4: User validation**

由用户在当前周候选中重新勾选两条，点击“确认两条并生成”。验证生成后第三页展示新的两条新闻，并出现当周 `reports.news.generate` 审计记录；归档后确认仅保留第一页、第二页的数据内容，第三页显示待选择状态且候选仍在。

- [ ] **Step 5: Commit**

```bash
git add report-news-store.js report-news-store.test.js
git commit -m "fix(reports): keep current news week isolated"
```

## Self-Review

- Spec coverage: Task 1 让跨周测试稳定；Task 2 完成第三页当前周隔离并保留候选；Task 3 修复生产 AI 注入；Task 4 覆盖回归、部署和用户重新生成功能。
- Placeholder scan: 计划不含未完成占位符或未定义的实施步骤；生产环境变量仅检查存在性。
- Type consistency: `summary(userId)` 的返回字段保持 `weekStart`、`news`、`candidates`、`lastAttempt`，不影响既有前端调用。
