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

## 会话：2026-07-22（阶段 7：v2 —— 权限/平台/分类/状态/进度条）

背景：仓库这天早些时候做过一次大重构（`test/`嵌套仓库+tarball 打包退休，`EC-Workbench/` 直接是可运行仓库根），本会话在新结构下、`.claude/worktrees/materialcheck-v2` worktree 里（分支从 `feature/materialcheck-paddleocr-ocr` 分出）继续做。用户用 `/grill-me` 提出 4 点优化需求，逐题梳理（每题给推荐项、用户逐一拍板），完整方案记在 `docs/superpowers/specs/2026-07-22-materialcheck-v2-design.md`，然后动手实现。

### 需求 1+2：词库权限 + 天猫/京东平台隔离 + 关键词分类 + 机器/滤芯/附件组内通用词
- 用户对象新增 `materialLibraryRole: edit/view/none`（全局一份），admin 隐式 edit，非 admin 默认 view；`public/users.js` 给非 admin 用户加了个下拉框，`server.js` 的 `PATCH /api/users/:id` 只有 admin 能改这个字段
- `products.json` 从扁平结构改成 `{tmall:{...}, jd:{...}}` 命名空间隔离；`load()` 检测到旧扁平结构自动一次性迁移到天猫、京东留空，随后立刻落盘
- 关键词从纯字符串变成 `{text, category}` 对象（8 个分类），纯组织元数据，不影响判定逻辑
- 机器/滤芯/附件通过 `type` 字段 + 三套独立的组内通用词列表（`machineSharedKeywords`/`filterSharedKeywords`/`accessorySharedKeywords`）实现——**关键技术发现**：`matchAgainstProduct` 完全不需要知道 `product.type` 或任何通用词列表，"组内共享"效果是 `validateLibrary` 唯一性约束的自然推论（组内通用词永远不会同时是某产品的专属词，所以永远不会被当成"别人的专属词"触发串词），匹配算法一行没改

### 需求 3：检测状态三态化
- `status` 从 `pass/fail` 改成 `pass/warn/error`，固定规则：串词→error，缺词→warn，都没有→pass，两者都有→error 优先（详情仍分列缺词/串词）
- 旧记录 `status:'fail'` 不迁移，历史筛选下拉框里保留这个选项

### 需求 4：上传整批进度条
- `mc-check-view` 加了个 `<div class="mc-progress">` 填充条，按"(已完成+待选择)/总数"算百分比（待人工选择的图算"识别已经跑完"，不算"处理中"）

### 实现规模
- 后端：`materialcheck-match.js`（关键词表示 + 三态状态）、`materialcheck-store.js`（平台命名空间 + 迁移 + platform 贯穿所有方法）、`server.js`（5 个 materialcheck 路由 + users PATCH + pubUser）
- 前端：`public/materialcheck.js`（几乎整个重写：平台切换器、type/分类编辑、三套组内通用词编辑区、三态徽章、平台历史筛选、进度条）、`public/users.js`（权限下拉框）、`public/index.html`（平台切换器 DOM）、`public/styles.css`（新增 `.mc-row-warn`/`.mc-platform-switch`/`.mc-progress`/`.mc-lib-disabled` 等样式）

### 真机验证（本会话的重点改进）
过去几轮受限于沙盒没有真实浏览器，只能靠 curl 验证前端改动。这次在 `$CLAUDE_JOB_DIR/tmp`（不进仓库）临时装了 Playwright，起 headless Chromium 跑通完整交互链路：
- 登录 → 素材质检 tab → 词库管理页（admin 可见）→ 新增产品设 type=机器 + 两个带分类的关键词 → 加机器组内通用词/全局通用词 → 保存成功
- 切京东平台词库为空（验证平台隔离）→ 切回天猫产品还在
- 上传测试图片、进度条正确显示（因沙盒没装 PaddleOCR venv，识别结果如预期是"识别失败"，属已知环境限制不是新 bug）
- 历史记录页平台筛选下拉框存在
- 单独验证用户管理面板：非 admin 用户行有词库权限下拉框、admin 行没有、选 edit 后 PATCH 成功持久化
- 全程 0 个真实 console/page error
- 另外用 curl 单独验证了服务端权限闸门：view 权限 403、admin 授权 edit 后能 PUT 成功、非 admin 不能改别人的角色

### 测试
`node materialcheck.test.js` 从 43 扩到 56 个用例，全部通过（新增用例覆盖：keywordText/keywordCategory 表示兼容性、组内通用词唯一性校验、天猫京东数据隔离、按平台过滤历史记录、旧扁平数据自动迁移、三态 status 的各种组合）。

## 测试结果（阶段 7）
| 测试 | 输入 | 预期结果 | 实际结果 | 状态 |
|------|------|---------|---------|------|
| `node materialcheck.test.js` | - | 全部通过 | 56 passed, 0 failed | ✅ |
| curl：view 权限用户 PUT 词库 | 默认 view 权限的非 admin 用户 | 403 | `{"error":"没有编辑关键词库的权限"}` | ✅ |
| curl：admin 授权后该用户再 PUT | 授权 edit 后同一用户重试 | 200 保存成功 | 保存成功 | ✅ |
| Playwright：平台隔离 | 天猫存 1 个产品后切到京东 | 京东产品数为 0 | 0 | ✅ |
| Playwright：切回天猫 | - | 产品还在 | 1 | ✅ |
| Playwright：上传进度条 | 上传 1 张图 | 进度条可见 | `true` | ✅ |
| Playwright：用户管理权限下拉框 | 非 admin 行 vs admin 行 | 非 admin 有下拉框，admin 没有 | 符合预期 | ✅ |

## 错误日志（阶段 7）
| 时间戳 | 错误 | 尝试次数 | 解决方案 |
|--------|------|---------|---------|
| 2026-07-22 | worktree 首次创建时分支从错误的 base 分出（`origin/HEAD` 指向不相关的 `redesign/preview3d-deepspace`，不是 `main`） | 1 | 工作区还没做任何真实改动，直接 `git reset --hard origin/feature/materialcheck-paddleocr-ocr` 纠正到正确的起点，不是破坏性操作（没有丢失任何工作） |
| 2026-07-22 | Playwright 浏览器测试脚本重复用同一个 DATA_DIR 跑第二次，报关键词唯一性冲突 | 1 | 排查后发现是测试方法论问题（同名产品被脚本创建了两次），不是应用 bug；改为每次测试前清空 DATA_DIR |

## 五问重启检查（截至 2026-07-22 会话结束，阶段 7）
| 问题 | 答案 |
|------|------|
| 我在哪里？ | 阶段 7（v2：权限/平台/分类/状态/进度条）complete；本地 worktree 里已实现+真机验证，尚未部署到任何测试/生产环境 |
| 我要去哪里？ | 提交后按项目约定推送分支、开 PR；等用户在实际环境里测试这批新功能（词库权限、天猫/京东切换、三态状态、进度条），根据反馈决定下一步（部署到 8080/8090 需要用户明确指令） |
| 目标是什么？ | 素材文案关键词检测标签页的持续打磨；这一阶段的子目标是用户提出的 4 点具体优化（权限管理、平台隔离、关键词分类、三态状态）+ 附带的进度条小需求 |
| 我学到了什么？ | "组内可共享关键词"这类看似需要感知产品分组的逻辑，很多时候可以通过唯一性约束自然获得，不需要在匹配算法里加分支——设计时先想清楚"这个效果是不是别的约束的推论"能省很多代码；沙盒里能装 Playwright 做真实浏览器验证时应该优先用，比只靠 curl 猜前端行为可靠得多；浏览器测试脚本要注意每次清空测试数据目录，否则会把测试残留误判成应用 bug |
| 我做了什么？ | 见上方「阶段 7」记录；改了 8 个文件（match/store/server 三个核心模块 + users.js/materialcheck.js/index.html/styles.css 前端 + task_plan/findings/progress 三个规划文件）+ 新增 1 份设计文档，`node materialcheck.test.js` 56/56 通过，真机 Playwright 验证通过 |

## 会话：2026-07-23（阶段 7 收尾：部署到 8080 供用户实测）

### 状态：complete
- 会话开始时先确认：commit `6151ca1` 已推送到 `origin/feature/materialcheck-v2-permissions-platform`，PR #2（draft，base=`feature/materialcheck-paddleocr-ocr`）已开好；工作区 `git status` 干净，**这次没有新代码改动可提交**，只是把已完成的 v2 分支部署上 8080 供用户手动验证
- 用户要求"推 8080 端口我来自行测试"，执行步骤：
  1. 排查发现 8080 原本跑着 `/root/IQAir-Project/EC-Workbench`（主 checkout，非本 worktree）上的旧代码（分支 `feature/materialcheck-paddleocr-ocr`，commit `b4da77a`，即 v2 之前的版本），PID 753940，`PPID=1`（后台常驻）
  2. 因为 v2 分支已经被本 worktree 占用（git 不允许同一分支在两个 worktree 同时签出），不能直接切换主 checkout 的分支；改为**直接在本 worktree 目录里起服务**，`DATA_DIR` 指向主 checkout 现有的 `data/` 目录（复用用户已经积累的真实测试数据：矩阵/对位看板、6332 条评论、18 款 3D 预览产品、2 个素材质检产品+9 条历史记录），避免数据割裂成两份
  3. `venv/` 本 worktree 没有（PaddleOCR 依赖装在主 checkout 那份），软链 `ln -s /root/IQAir-Project/EC-Workbench/venv venv` 复用，不重复装一遍
  4. 优雅停掉旧进程（`SIGTERM`，确认退出）→ 在 worktree 里 `DATA_DIR=.../EC-Workbench/data PORT=8080 nohup node server.js >> server.log 2>&1 &` 起新进程（PID 794708）
  5. 验证：`server.log` 里看到 `[materialcheck] 已把旧的扁平词库数据一次性迁移到「天猫」命名空间下`（证明 v2 的自动迁移逻辑真实跑在用户的存量数据上，不是空库）；`curl /login.html` 200；`curl /materialcheck.js` 302 跳登录（静态资源鉴权正常）；`ss -ltnp` 确认 8080 上监听的是新 PID
- 创建/修改的文件：无代码改动，仅运维操作（起停进程、建软链）
- **五问重启检查更新**：「我在哪里」→ v2 分支已实际跑在 8080，用户可以直接用浏览器测；「我要去哪里」→ 等用户实测反馈，反馈后再决定是否需要改代码/合并到 `feature/materialcheck-paddleocr-ocr`/进而合并 `main`；生产发布（8090/`/opt/workbench`）依然需要用户明确指令，本次未触碰

---
*每个阶段完成后或遇到错误时更新此文件*
