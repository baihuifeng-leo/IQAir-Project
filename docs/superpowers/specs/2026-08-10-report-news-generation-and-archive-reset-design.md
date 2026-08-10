# AI 新闻生成与周报归档重置设计

## 目标

恢复生产环境的 AI 新闻生成功能，并让每次归档后当前个人报告只保留第一、第二页数据，第三页回到待编辑状态；新闻候选继续保留。

## 根因

生产环境 `/etc/workbench/ai.env` 已包含 AI 协议、服务地址、密钥和模型，但运行中的 `/etc/systemd/system/workbench.service` 未声明 `EnvironmentFile=-/etc/workbench/ai.env`。因此 `ReportNewsAi.configured()` 为假，`POST /api/reports/news/generate` 返回配置缺失错误，无法保存新的新闻页。

## 方案

### 生产配置

将已随应用发布的 `workbench.service` 安装到 `/etc/systemd/system/workbench.service`，执行 `systemctl daemon-reload` 并重启服务。重启后仅验证 AI 环境变量是否存在，不输出密钥内容。

AI 生成仍采用同步请求：用户点击“确认两条并生成”后，服务抓取两条正文、调用兼容服务、生成成功后立刻覆盖该周的 `weeks[weekStart]`。没有后台任务队列。先前失败的浏览器勾选不持久化，用户需在修复后重新勾选两条候选并提交。

### 归档后的当前报告

- 第一、第二页：保持已有日报与微盟数据，继续用于趋势和周度对比。
- 第三页：不再将最新历史周的新闻回退显示在当前周；当前周尚未生成时显示待选择/待生成状态。
- 候选新闻：保留当前周 `candidates`，便于继续筛选。
- 自定义页与自定义排序：归档时清空，编辑区恢复三个系统页。
- 历史周：归档快照内的新闻和自定义页不变；打开档案时仍使用该周快照，而不依赖当前周新闻摘要。

## 数据流

1. 归档以“上周周一”为 key 创建报告与新闻快照。
2. `ReportStore.archiveCreate()` 清空实时 `slides` 与 `pageOrder`。
3. `ReportNewsStore.summary()` 只返回当前周已发布新闻，不再回退到上一个已发布周。
4. 现有 `candidates[currentWeek]` 原样保留；第三页在 `news === null` 时展示空状态。

## 验证

- 单元测试覆盖：归档后实时自定义页/排序清空；新闻摘要不会回退到前一周；当前周候选保持可读取。
- UI 静态测试覆盖第三页使用当前周新闻状态。
- 部署后确认服务加载了 `AI_API_KEY` 与 `AI_MODEL`（仅存在性），健康接口正常。
- 用户重新选择两条候选并点击生成后，审计记录与本周 `weeks[weekStart]` 均出现两条新闻。
