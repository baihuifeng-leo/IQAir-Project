# 进度日志

## 会话：2026-07-21

### 阶段 1：需求与发现（脑暴）
- **状态：** complete
- 执行的操作：
  - 用 `superpowers:brainstorming` 跟用户逐问澄清：OCR方案、产品归属识别机制、关键词规则形态、检测逻辑范围、功能定位、产品数据源、执行模型、OCR引擎选型、结果持久化、匹配严格度、权限划分，共 10+ 轮一问一答
  - 先探索了代码库现状（README.md、ANALYSIS.md、docs/superpowers/specs/ 下已有的两份历史设计文档、git log）确认这是全新功能，没有现成的可复用产品/关键词数据源
  - 完成设计文档自审（占位符扫描、内部一致性、范围检查、歧义检查），当场修了措辞
- 创建/修改的文件：
  - 创建 `docs/superpowers/specs/2026-07-21-material-keyword-check-design.md`（133 行）
  - Git commit `7abf546`

### 阶段 2：规划与结构（写实施计划）
- **状态：** complete
- 执行的操作：
  - 并行派了两个 Explore 子代理分别研究"服务端架构模式"和"前端架构模式"，各自读了 server.js 全文、三个 store 模块全文、reviews.js/core.js/settings.js/admin.js/compare.js 关键片段、install.sh 全文、repack-tarball.sh 全文，拿到精确的行号和代码惯用法
  - 额外读了 `merge.test.js` 确认零框架测试文件的书写风格
  - 拆解成 9 个任务：OCR封装 → 纯匹配逻辑 → store模块（各自 TDD，最终 36 个测试用例）→ 后端路由接入（curl手动验证）→ 前端标签页外壳接入 → 检测台/历史记录/关键词库三个子视图（各自浏览器手动验证，因为本项目没有自动化前端测试）→ 部署脚本接入+重新打包
  - 计划自审：逐项核对设计文档覆盖度、占位符扫描、跨任务的函数签名/数据结构一致性核对（比如 `matchAgainstProduct` 的返回形状在 Task 2 测试、Task 3 实现、Task 6/7 前端消费三处要完全一致）
  - 自审中发现 Task 5/Task 6 之间两处步骤编号引用不一致，用 Edit 工具当场修正
- 创建/修改的文件：
  - 创建 `docs/superpowers/plans/2026-07-21-material-keyword-check.md`（约 1800 行，含完整代码）
  - Git commit `c12bce8`
- 向用户展示了执行方式的选择（Subagent-Driven vs Inline Execution），用户选了 Subagent-Driven

### 阶段 3：实现（subagent-driven-development）
- **状态：** in_progress
- 执行的操作：
  - 初始化 SDD 账本 `.superpowers/sdd/progress.md`（git-ignored，权威进度来源）
  - Task 1（`materialcheck-ocr.js`）：haiku 实现子代理 → commit `17c5d16`，5/5 测试通过 → sonnet 评审子代理 → Approved（1 条 Important 由控制者核实为"计划 Global Constraints 里明确写的 tarball 打包延后到 Task 9"，非真实缺口；1 条 Minor 未处理的死代码，留着以后顺手清）
  - Task 2（`materialcheck-match.js`）：haiku 实现子代理 → 发现实际测试数是 24 而不是计划里写的 23（计划文档算错了）→ 用 Edit 修正计划文档（commit `530a65c`）→ 实现子代理 commit `6a695c9`，24/24 通过 → sonnet 评审 → Approved（2 条 Minor：`resolveProduct` 的 candidates 在 3 个以上产品打平时不够精确，但没有任何后续任务的前端用到这个字段，不用管；一条测试跟邻近测试有点重复）
  - Task 3（`materialcheck-store.js`）：haiku 实现子代理 → commit `75afc5b`，33/33 通过（同步修正了计划里 Task 3 的预期数 36→33）→ sonnet 评审 → Approved 但有 1 条 Important（标了 plan-mandated）：计划里给 Task 3 列的测试用例本身漏了一条覆盖 `ocr_failed` 分支的测试，代码逻辑评审子代理手动验证过是对的，只是没有自动化回归测试。判断这不是"计划要求了错误做法需要人裁决"的情况，只是计划漏列了一个测试用例，直接派修复子代理去补，不升级给用户
  - 补测试的修复子代理第一次派发时 Agent 工具报错「claude-sonnet-5 is temporarily unavailable」，中断在这里；随后 `/compact` 因周额度用尽失败，会话经历上下文压缩问题；用户要求"继续之前中断的任务"后，重新核实 git 状态（HEAD 仍是 `75afc5b`，测试仍是 33/33，SDD 账本仍显示 Task 1/2 complete、Task 3 未登记完成），确认没有任何东西丢失，原样重新派发修复子代理
- 创建/修改的文件：
  - 创建 `materialcheck-ocr.js`、`materialcheck-match.js`、`materialcheck-store.js`、`materialcheck.test.js`
  - 修改 `docs/superpowers/plans/2026-07-21-material-keyword-check.md`（测试数量笔误修正）
  - Git commits：`17c5d16`、`6a695c9`、`530a65c`、`75afc5b`（详见 `.superpowers/sdd/progress.md` 账本）

## 测试结果（阶段1-5，2026-07-21）
| 测试 | 输入 | 预期结果 | 实际结果 | 状态 |
|------|------|---------|---------|------|
| `node materialcheck.test.js`（Task 1 后） | - | 5 passed | 5 passed | ✅ |
| `node materialcheck.test.js`（Task 2 后） | - | 24 passed（计划原写 23，已订正） | 24 passed | ✅ |
| `node materialcheck.test.js`（Task 3 后） | - | 33 passed（计划原写 36，已订正） | 33 passed | ✅ |
| `node materialcheck.test.js`（Task 3-9 全部完成+最终评审修复后） | - | 36 passed | 36 passed | ✅ |

## 错误日志（阶段1-5）
| 时间戳 | 错误 | 尝试次数 | 解决方案 |
|--------|------|---------|---------|
| 2026-07-21 | 计划文档内部两处步骤编号引用不一致（Task 5 提到"Task 6 Step 5"实为 Step 4） | 1 | 用 Edit 工具直接修正两处引用文字，问题已解决 |
| 2026-07-21 | 计划文档 Task 2/3 的"预期测试通过数"算错（23/36，实际应为 24/33） | 1 | 用 Edit 修正，另开 commit `530a65c`，并提前告知后续任务的子代理这是已知文档笔误 |
| 2026-07-21 | 派发 Task 3 补测试的修复子代理时 Agent 工具报 `claude-sonnet-5 is temporarily unavailable`，随后会话又遇到 `/compact` 因周额度耗尽失败 | 1 | 核实 git 状态和 SDD 账本均完好无损（HEAD `75afc5b`，33/33 测试通过，Task 1/2 账本记录都在），原样重新派发修复子代理，无需任何补救性改动 |

## 会话：2026-07-22（阶段 6：OCR 识别精度优化）

功能本体（阶段1-5，9个任务）已在此前会话完成并部署到 8080 测试环境。这次会话是用户拿真实素材图（IQAir GCX Series XE 电商海报）实测后，反馈"识别有不少误差"，全程用 `/grill-me` 一步步确认再动手，做了三轮 OCR 引擎迭代：

### 第一轮：tesseract 参数调优
- 用真实失败样本（用户上传的两张海报截图）对比不同 PSM（页面分割模式）的识别率，发现默认 PSM 3 会把标题文字整段跳过，换成 PSM 11 有明显提升
- 修改 `materialcheck-ocr.js` 默认 PSM 3→11，配套更新 `materialcheck.test.js` — commit `fe442c3`
- 部署到 8080，用户确认"精度好一些，但还不能投产"

### 第二轮：tesseract 多路并集 + 预处理（后来回退）
- 用户明确说"识别速度没有太高要求"，因此放开了延迟约束，验证了 PSM 3+6+11 三路并行取并集（不同 PSM 各有识别盲区，取并集能互补）+ ImageMagick 放大/灰度/锐化/对比度增强预处理，用真实失败样本验证过确实能救回单路方案漏掉的关键词
- 落地：`materialcheck-ocr.js` 重写为多路调用+预处理，新增 ImageMagick 系统依赖，`install.sh`/`repack-tarball.sh` 配套更新 — commit `8aff9de`，部署到 8080
- **用户实测后反馈这版太慢**（单张图 1.5-3 分钟）——直接回退到第一轮的单路 PSM11 版本，不是去优化这版速度 — commit `7eaa0c9`
- 同期还验证过四个思路但全部因为速度问题被放弃，没有一个测出精度收益：反色处理（负50-90秒卡死）、关键词字符白名单限定识别范围（同样卡死，tesseract LSTM 引擎已知短板）、tesseract 官方 tessdata_best 高精度模型（体积是默认5倍，单次识别超90秒未完成）、tesseract 内置 Sauvola 自适应二值化（同样跑不完）

### 第三轮：换成 PaddleOCR（当前落地版本）
- 用户主动提出试试百度开源的 PaddleOCR，用真实失败样本对比测试，效果远超 tesseract 反复调参的上限（"尊享管家服务""行业63+年深耕""全国可用"这些 tesseract 全部方案都认错的文案基本都识别对了），单图 6-15 秒，比 tesseract 三路并集快一个数量级
- 期间踩了一个坑：PaddleOCR 默认配置在这台机器上报 `NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support`（MKLDNN 加速跟某些算子组合不兼容），显式关掉 MKLDNN 解决，没有明显变慢
- 用 `AskUserQuestion` 明确跟用户确认了两件事再动手：(1) 值不值得为了这个效果引入一整套新的 Python 技术栈（1.3GB+依赖、需要常驻进程）——用户选择"值得，按这个方向做"；(2) 识别置信度低的素材怎么处理——用户选择"跟现有人工选择产品流程一样，标记为待人工核对"
- 落地：新增常驻 Python 子进程 `materialcheck-paddleocr-worker.py`（stdin/stdout 按行 JSON 协议，避免每张图重新加载模型），`materialcheck-ocr.js` 重写为管理这个子进程，`materialcheck-store.js` 新增整体置信度阈值判断（<0.7 转人工核对），`install.sh` 换成装 Python venv + paddlepaddle/paddleocr，新增 `.gitignore` 排除 `venv/` 目录 — commit `e6acf8b`
- 43/43 单元测试通过；在 Test 环境手动搭建了真实的 venv（不是临时符号链接）并完成模型预热，重启 8080 后确认常驻 worker 进程正常运行、`server.log` 无报错
- 用户尚未反馈这版实测结果

## 测试结果（阶段 6）
| 测试 | 输入 | 预期结果 | 实际结果 | 状态 |
|------|------|---------|---------|------|
| `node materialcheck.test.js`（PaddleOCR 集成后） | - | 43 passed | 43 passed | ✅ |
| 真实图片端到端（Node→Python子进程→PaddleOCR） | 4张真实失败样本图 | 关键词命中率明显高于 tesseract 各方案 | "尊享管家服务""全国可用""GCX Series XE"等全部命中，仅剩个别形近字（士/十）偶尔认错 | ✅ |
| 8080 部署后 server.log 检查 | - | 常驻 worker 进程正常启动，无报错 | 确认 PID 存在，`checkAvailable()` 无警告 | ✅ |

## 错误日志（阶段 6）
| 时间戳 | 错误 | 尝试次数 | 解决方案 |
|--------|------|---------|---------|
| 2026-07-22 | tesseract 多路并集+预处理方案上线后，用户反馈实测太慢 | 1 | 直接回退到单路 PSM11 版本（commit `7eaa0c9`），换方向验证 PaddleOCR，而不是继续优化这版速度 |
| 2026-07-22 | 反色/字符白名单/tessdata_best/Sauvola 二值化四个新思路依次实测，全部 50-90 秒跑不完 | 每个思路 1-2 次 | 判断是 tesseract 在这几种用法下的已知性能短板，放弃这个方向 |
| 2026-07-22 | PaddleOCR 默认配置报 `ConvertPirAttribute2RuntimeAttribute not support` | 2（先试换模型版本，同样报错；再试降级 paddlepaddle 到 2.6.2，结果 paddleocr 3.x 需要新 API，报另一个错） | 显式 `enable_mkldnn=False` 关闭 MKLDNN 加速解决 |

## 五问重启检查（截至 2026-07-22 会话结束）
| 问题 | 答案 |
|------|------|
| 我在哪里？ | 阶段 6（OCR精度优化）complete；PaddleOCR 方案已部署 8080，等用户反馈 |
| 我要去哪里？ | 等用户测完这版效果和稳定性；如果满意，下一步是阶段5遗留的生产发布（需用户明确指令）和两处待决策的范围取舍项（历史筛选维度、图片展示） |
| 目标是什么？ | 素材文案关键词检测标签页：批量上传→OCR→关键词比对→缺词/串词提示→历史留档；当前子目标是把 OCR 精度做到用户认可"能投产" |
| 我学到了什么？ | 见 findings.md「阶段6新增」部分：PaddleOCR 明显优于 tesseract 在这类装饰性电商海报上的表现；速度/精度取舍必须让用户看到具体数字（"慢一点"和"1.5-3分钟"是两回事）；新方向落地前先用真实失败样本做免费脚本实验，比直接写正式代码省成本 |
| 我做了什么？ | 见上方「阶段6」三轮记录；4个提交 `fe442c3`→`8aff9de`→`7eaa0c9`→`e6acf8b` 都在 `design/deepspace-polish`，另建 `feature/materialcheck-paddleocr-ocr` 分支固定保留这条工作线 |

---
*每个阶段完成后或遇到错误时更新此文件*
