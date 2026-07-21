# 任务计划：素材文案关键词检测功能

## 目标
在电商工作台新增第六个标签页：批量上传素材图片，服务端 OCR 识别文字，跟后台配置的产品专属关键词比对，检测出"缺词"（漏了本该出现的关键词）和"串词"（混入了别的产品的关键词），并留存历史记录供回看。

## 当前阶段
阶段 3（实现）— 尚未开始写代码，计划已就绪，等待用户选择执行方式

## 各阶段

### 阶段 1：需求与发现
- [x] 理解用户意图（脑暴会话，`superpowers:brainstorming`）
- [x] 确定约束条件和需求（零依赖离线部署、OCR 方案、产品归属识别、关键词规则、权限划分等）
- [x] 将发现记录到 findings.md
- **状态：** complete
- **产出：** `docs/superpowers/specs/2026-07-21-material-keyword-check-design.md`（已提交，commit `7abf546`）

### 阶段 2：规划与结构
- [x] 确定技术方案（同步请求 + 服务端并发队列，system tesseract-ocr）
- [x] 拆解成 9 个实施任务，每个任务标注 Files/Interfaces/Steps
- [x] 记录决策及理由
- **状态：** complete
- **产出：** `docs/superpowers/plans/2026-07-21-material-keyword-check.md`（已提交，commit `c12bce8`）

### 阶段 3：实现
- [ ] Task 1：`materialcheck-ocr.js`（tesseract child_process 封装，桩函数测试）
- [ ] Task 2：`materialcheck-match.js`（纯函数：产品归属三级识别 + 缺词/串词判定）
- [ ] Task 3：`materialcheck-store.js`（products.json + records.jsonl + pending 缓存）
- [ ] Task 4：`server.js` 接入 5 个 `/api/materialcheck/*` 路由
- [ ] Task 5：`index.html`/`core.js`/`settings.js` 接入第六个标签页外壳
- [ ] Task 6：`materialcheck.js` 检测台（批量上传 + 结果展示 + 人工选择产品）
- [ ] Task 7：`materialcheck.js` 历史记录（过滤 + 详情高亮）
- [ ] Task 8：`materialcheck.js` 关键词库管理面板（管理员专属）
- [ ] Task 9：`install.sh` + `scripts/repack-tarball.sh` 接入部署，重新打包 tarball
- **状态：** pending
- **详细步骤见：** `docs/superpowers/plans/2026-07-21-material-keyword-check.md`（每个任务都有完整代码和验证命令，不要在这里重复内容，照着那份计划一步步做）

### 阶段 4：测试与验证
- [ ] Task 1-3 的自动化测试全部通过（`node materialcheck.test.js`，跑完预期 36 passed, 0 failed）
- [ ] Task 4 的 curl 手动验证（路由鉴权、产品库读写、唯一性冲突拒绝）
- [ ] Task 6-8 的浏览器手动验证（无自动化前端测试，per CLAUDE.md）
- [ ] Task 9 的干净 tarball 解包全链路冒烟测试
- **状态：** pending

### 阶段 5：交付
- [ ] 确认 `competitive-workbench.tar.gz` 与散装文件内容一致
- [ ] 推送分支 `design/deepspace-polish`
- [ ] 按 CLAUDE.md 描述的部署流程走：rsync 到 `EC-Workbench/Product/` → 再到 `/opt/workbench`（**这一步需要用户确认后再做，不要自作主张跑生产部署**）
- **状态：** pending

## 关键问题
1. 执行方式选哪种：Subagent-Driven（每个 task 一个新 subagent）还是 Inline Execution（本会话内批量执行）？— 已经问过用户，等待回复。
2. 当前开发/沙盒环境里有没有装 `tesseract-ocr` + `tesseract-ocr-chi-sim`？没有的话 Task 1 的自动化测试仍能过（用了桩函数），但 Task 6/9 的手动验证里真实 OCR 那部分会退化成 `ocr_failed` 分支——这是预期行为，不是 bug，但需要提前告知用户别误判。

## 已做决策
| 决策 | 理由 |
|------|------|
| OCR 用系统级 tesseract-ocr（apt 安装）而非 tesseract.js/WASM | 识别速度和准确率更好；VM 本来就用 apt 装 Node，加一个系统包一致 |
| OCR 跑在服务端而非浏览器端 | 先验证准确率，用户明确说"后期再看情况迁移" |
| 执行模型：同步请求 + 服务端并发队列（非异步任务+轮询） | 最少新增基础设施，前端 loading 态直接由请求本身驱动 |
| 产品归属识别：文件名 → OCR反查 → 人工兜底，三级 | 用户明确要求"多重机制"，同时兼顾"检查型号有没有填错" |
| 关键词匹配：严格字符串包含，不做模糊容错 | 用户选择"先测准确度"，等真实 OCR 输出出来再决定要不要加容错 |
| 新建独立产品/关键词库，不复用价格带沙盘或3D预览的产品数据 | 数据所有权和覆盖时机对不上，用户明确选择独立建库 |
| 关键词库配置仅管理员，上传检测所有人可用 | 跟现有权限模型（变更日志/备份恢复管理员专属）一致 |
| 检测结果永久保存，支持历史回看 | 用户明确要求，质检工具需要可追溯 |
| tarball 重新打包放在 Task 9 统一做，不是每个 commit 都做 | 8 个 TDD 任务如果每次都重新打包+提交二进制文件，噪音太大；这是对 CLAUDE.md 规则的合理变通，已在计划文档 Global Constraints 里写明理由 |

## 遇到的错误
| 错误 | 尝试次数 | 解决方案 |
|------|---------|---------|
| （尚未开始编码，暂无） | - | - |

## 备注
- 随着进度更新阶段状态：pending → in_progress → complete
- 做重大决策前重新读取此计划（注意力操纵）
- 记录所有错误，避免重复
- **不要把计划文档（`docs/superpowers/plans/...`）的内容复制粘贴进这个文件** —— 这个文件只做进度追踪的索引，详细的代码/命令都在计划文档里，改动以那份文档为准。
