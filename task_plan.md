# 任务计划：素材文案关键词检测功能

## 目标
在电商工作台新增第六个标签页：批量上传素材图片，服务端 OCR 识别文字，跟后台配置的产品专属关键词比对，检测出"缺词"（漏了本该出现的关键词）和"串词"（混入了别的产品的关键词），并留存历史记录供回看。

## 当前阶段
阶段 7（v2：权限/平台/分类/状态/进度条）— complete。仓库已在 2026-07-22 做过一次大重构：`test/` 嵌套仓库 + tarball 打包整体退休，`EC-Workbench/` 本身现在就是 git 仓库根目录、可直接 `node server.js` 运行，不再需要打包/解包。本阶段在 worktree `materialcheck-v2` 里开发。

## 当前阶段
阶段 6（OCR 识别精度优化，用户实测反馈驱动）— complete。功能本体（阶段 1-5）早已上线到 8080 测试环境；这一阶段是用户拿真实素材图实测后，反复反馈"识别有误"，驱动了三轮 OCR 引擎迭代（tesseract 参数调优 → tesseract 多路并集+预处理 → 换成 PaddleOCR），当前落地在 PaddleOCR 常驻子进程方案，已推送 `design/deepspace-polish` 分支并另建 `feature/materialcheck-paddleocr-ocr` 分支保留这条工作线（原因见下方"备注"）。

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
- [x] Task 1：`materialcheck-ocr.js`（tesseract child_process 封装，桩函数测试）—— commit `17c5d16`，评审 Approved
- [x] Task 2：`materialcheck-match.js`（纯函数：产品归属三级识别 + 缺词/串词判定）—— commit `6a695c9`，评审 Approved
- [x] Task 3：`materialcheck-store.js`（products.json + records.jsonl + pending 缓存）—— commit `75afc5b` + 补测试 commit `7f284c8`，复审 Approved
- [x] Task 4：`server.js` 接入 5 个 `/api/materialcheck/*` 路由 —— commit `f071739`，评审 Approved
- [x] Task 5：`index.html`/`core.js`/`settings.js` 接入第六个标签页外壳 —— 与 Task 6 合并提交
- [x] Task 6：`materialcheck.js` 检测台（批量上传 + 结果展示 + 人工选择产品）—— commit `8f41678` + 修复 `0fc9c28`（补了个计划漏掉的 server.js MODULES 白名单缺口），评审 Approved
- [x] Task 7：`materialcheck.js` 历史记录（过滤 + 详情高亮）—— commit `282cd43`，评审 Approved
- [x] Task 8：`materialcheck.js` 关键词库管理面板（管理员专属）—— commit `ac6789e`，评审 Approved，前端六个任务(1-8)全部完成
- [x] Task 9：`install.sh` + `scripts/repack-tarball.sh` 接入部署，重新打包 tarball —— commit `a553ed6`，评审 Approved（零发现）
- **状态：** complete —— 9 个任务全部完成并评审通过，进入全分支最终评审
- **详细步骤见：** `docs/superpowers/plans/2026-07-21-material-keyword-check.md`（每个任务都有完整代码和验证命令，不要在这里重复内容，照着那份计划一步步做）
- **SDD 账本（权威进度来源，跨会话恢复认这个）：** `.superpowers/sdd/progress.md`（git-ignored，本地文件系统里；本文件的勾选状态是给人看的摘要，冲突时以 SDD 账本 + `git log` 为准）

### 阶段 4：测试与验证
- [x] Task 1-3 的自动化测试全部通过（`node materialcheck.test.js`，最终 36 passed, 0 failed —— 巧合地跟当初写错的预期数字撞了，但这次是真的对，多出来的 2 条是最终评审修复里补的并发限流测试+空产品名测试）
- [x] Task 4 的 curl 手动验证（路由鉴权、产品库读写、唯一性冲突拒绝）
- [x] Task 6-8 的浏览器手动验证 —— 受限于沙盒没有真实浏览器，改用 curl 尽力验证（服务器启动、页面标记、完整上传链路走通），视觉/点击交互未验证，已如实记录
- [x] Task 9 的干净 tarball 解包全链路冒烟测试
- [x] **全分支最终评审**（Opus，读完整 15 个提交的 diff）：发现 1 条 Important（设计文档要求的服务端 OCR 并发队列，9 个任务全部漏做——写计划时的疏漏，单任务评审看不出这种跨任务缺口）+ 5 条 Minor。已修复 Important + 3 条低风险 Minor，修复复审 Approved。剩 2 条 Minor 是范围取舍问题，留给用户决定（见下方阶段 5）
- **状态：** complete

### 阶段 5：交付
- [x] 确认 `competitive-workbench.tar.gz` 与散装文件内容一致（Task 9 + 后续 ocrConcurrency 加固各打包验证一次）
- [x] 推送分支 `design/deepspace-polish`（已多次推送，最新见阶段 6）
- [x] 部署到 8080 测试环境（`EC-Workbench/Test/`），供用户自行测试——这一步已做；rsync 到 `EC-Workbench/Product/` → `/opt/workbench` 的生产发布仍未做，**需要用户明确要求才启动**
- **状态：** complete（测试环境部署部分）；生产发布 pending，等用户明确指令
- **待用户决定的两处范围取舍**（不是 bug，是设计文档要求了但计划/实现阶段缩了水，最终评审标为 Minor，截至目前用户还没表态）：
  1. 历史记录视图的过滤维度比设计文档少——现在只有产品/状态两个筛选，设计文档还要求按上传人、日期范围筛选、按批次折叠展示；store 层已经支持 `uploadedBy` 过滤，只是前端没接出来。
  2. 上传的素材图片全程没有在界面上显示出来——存了、也能通过 `/uploads/materialcheck/` 访问到，但检测台、人工选择产品那一步、历史记录详情里都没有 `<img>` 展示，人工选择产品时只能看 OCR 文字，看不到图。设计文档里"人工选择时把图和文字放一起给人看"这个诉求目前打了折扣。

### 阶段 6：OCR 识别精度优化（用户实测反馈驱动，非原计划范围）
用户拿真实素材图（IQAir GCX Series XE 海报）实测 8080 环境后反馈"识别有误"，围绕"怎么提升精度"做了三轮迭代，全程用 `/grill-me` 交互式确认每一步再动手，不是一次性做完：

- [x] **第一轮：tesseract 参数调优**——发现默认 PSM 3（整页版式分析）会把标题文字连同产品图一起误判成图片区域整段跳过；换成 PSM 11（稀疏文本模式）验证有提升 —— commit `fe442c3`
- [x] **第二轮：tesseract 多路 PSM 并集 + ImageMagick 预处理**——用户确认"速度不是硬指标"后，改成 PSM 3+6+11 三路并行取并集 + 放大/灰度/锐化/对比度增强预处理，真机验证过確实能救回单路 PSM 漏掉的关键词 —— commit `8aff9de`；**但用户实测后反馈这版太慢**（单张图 1.5-3 分钟），**已回退** —— commit `7eaa0c9`（回退到第一轮的单路 PSM11 版本）
- [x] **同期尝试过但验证后放弃的思路**（省得以后重复踩坑）：反色处理（负50-90秒卡死不出结果）、关键词字符白名单限定识别范围（同样卡死，tesseract LSTM 引擎的已知短板）、tesseract 官方"高精度"tessdata_best 模型（体积是默认模型5倍，单次识别超过90秒未完成）、tesseract 内置 Sauvola 自适应二值化（同样跑不完）——四个思路全部因为速度问题在实测阶段被否决，没有一个验证出实际精度收益
- [x] **第三轮：换成 PaddleOCR（Python 技术栈）**——用户主动提出"能不能用 PaddleOCR"，验证下来效果远超 tesseract 反复调参的上限（"尊享管家服务""行业63+年深耕""全国可用"等 tesseract 全部方案都认不出的文案基本都识别对了），单图 6-15 秒，比 tesseract 三路并集快一个数量级。落地为：
  - 常驻 Python 子进程（`materialcheck-paddleocr-worker.py`），Node 通过 stdin/stdout 按行 JSON 通信，避免每张图重新加载模型（1-30秒/次）
  - 关掉 MKLDNN（这台机器装的 PaddlePaddle 版本某些算子组合会直接报错 `ConvertPirAttribute2RuntimeAttribute not support`，关掉后正常，没有明显变慢）
  - `runOcr()` 现在返回 `{text, confidence}`：过滤掉单行置信度 <0.5 的噪声（图标常被识别成的乱码），剩余行平均置信度 <0.7 时，跟"文件名/OCR都判断不出产品"一样转人工核对（用户在这一步明确确认了这个处理方式）
  - `install.sh` 换成装 Python3 venv + pip install paddlepaddle/paddleocr，`venv/` 目录本身不进 git/tarball（跟 node_modules 一个道理，已加 `.gitignore`）
  - commit `e6acf8b`
- **状态：** complete —— 已部署到 8080 测试环境（含真实创建的 venv，非临时符号链接），server.log 确认常驻 worker 进程正常运行；用户尚未反馈这版的实测结果
- **已知局限（如实告知用户过，非隐藏问题）：** "士/十"这类形近字偶尔仍会认错（如"瑞士精工"被认成"瑞十精工"）；这套常驻子进程架构是全新代码，比之前调参数风险更高，用户还没来得及验证长时间运行的稳定性
- **产出**：4 个提交在 `design/deepspace-polish`（`fe442c3`→`8aff9de`→`7eaa0c9`→`e6acf8b`），另建 `feature/materialcheck-paddleocr-ocr` 分支固定在 `e6acf8b`，防止 `design/deepspace-polish`（项目约定里"唯一保留的测试分支，每次覆盖"）未来被其它任务复用时把这条工作线冲掉

### 阶段 7：v2 —— 权限 / 平台隔离 / 分类 / 三态状态 / 进度条
用户实测后提出 4 点优化需求，用 `/grill-me` 逐题梳理确认，完整方案见 `docs/superpowers/specs/2026-07-22-materialcheck-v2-design.md`。任务拆解：

- [x] **Task A：`materialcheck-match.js` 改造** —— 关键词从字符串变 `{text, category}`（`keywordText`/`keywordCategory` 兼容两种写法）；`matchAgainstProduct` 输出三态 `status`（串词优先于缺词，固定规则不可配置）；`validateLibrary` 唯一性校验扩大到三套组内通用词（第三参数 `sharedPools` 可选，不传时行为跟老版本一致）。**关键发现**：机器/滤芯/附件"组内可共享"这个效果不需要 `matchAgainstProduct` 感知 `product.type` 或任何通用词列表——只要 `validateLibrary` 保证组内通用词永远不会同时也是某产品的专属词，"组内共享"就是唯一性约束的自然推论，不用在匹配算法里加特殊分支。
- [x] **Task B：`materialcheck-store.js` 改造** —— `products.json` 改按平台命名空间存储（`{tmall:{...}, jd:{...}}`）；`load()` 检测旧扁平结构自动一次性迁移到天猫命名空间、京东留空，随后立刻落盘；`saveProducts`/`detectFile`/`resolvePending`/`listRecords` 全部加 `platform` 参数（`resolvePending` 从 pending 缓存里记的 platform 读，不用调用方重传）；`records.jsonl` 新记录加 `platform` 字段，旧记录不回填。
- [x] **Task C：`server.js` 路由改造** —— materialcheck 5 个路由全部加 `?platform=` 支持；`PUT /api/materialcheck/products` 权限检查改成 `me.admin || me.materialLibraryRole === 'edit'`；`PATCH /api/users/:id` 新增 `materialLibraryRole` 字段（仅 admin 能改别人的，校验取值只能是 edit/view/none）；`pubUser()` 暴露 `materialLibraryRole`（admin 用户永远显示为 'edit'，非 admin 默认 'view'）。
- [x] **Task D：`public/users.js` 前端** —— 非 admin 用户行里加一个 `materialLibraryRole` 三选一下拉框（仅 admin 可见可操作，admin 自己的行不出这个下拉框）。
- [x] **Task E：`public/materialcheck.js` 前端** —— 平台切换器（`index.html` 头部新增 `#mc-platform-switch`，选择记在 sessionStorage）；词库编辑页加产品 type 单选 + 关键词分类下拉 + 三套组内通用词编辑区（`wireChipList` 抽了个通用小函数，四个 chip 编辑器共用）；`role==='view'` 时整个词库面板套一层 `.mc-lib-disabled`（CSS `pointer-events:none`）；检测结果/历史记录三态徽章（通过/提醒/报错，`STATUS_META` 表驱动，兼容旧 `fail` 值）；历史记录加平台筛选（含"未知平台/旧记录"选项）；上传区加整批进度条（按"已完成+待选择"/总数算百分比，待人工选择的图算"OCR 已经跑完"而非"处理中"）。
- [x] **Task F：真机验证** —— 本地临时装了 Playwright（装在 `$CLAUDE_JOB_DIR/tmp` 下，不进仓库，装完即弃），起真实 headless Chromium 跑通了完整链路：登录 → 开素材质检 tab → 建词库管理页可见 → 新增产品设 type=机器 + 两个带分类的专属关键词 → 加机器组内通用词/全局通用词 → 保存成功 → 切到京东平台词库为空（验证平台隔离）→ 切回天猫产品还在 → 上传测试图片、进度条正确显示 → 历史记录页平台筛选下拉框存在。另外单独验证了用户管理面板：非 admin 用户行出现词库权限下拉框、admin 行不出现、下拉选 edit 后 PATCH 成功持久化。全程 0 个真实的 console/page error（唯一出现的 `ERR_ABORTED` 是页面跳转打断了在途请求的正常现象，不是 bug）。也用 curl 单独验证过服务端权限闸门（view 权限 403、admin 授权后 edit 权限可以 PUT 成功、非 admin 用户不能改别人的角色）。
- [x] **Task G：`node materialcheck.test.js` 全绿** —— 从 43 扩到 56 个用例全部通过（新增：keywordText/keywordCategory 兼容性、组内通用词唯一性校验、平台隔离、平台过滤、旧数据自动迁移、三态 status 等）+ 更新 findings.md/progress.md + 提交。

**状态：** complete

## 关键问题
1. ~~执行方式选哪种~~ — 用户已选 1（Subagent-Driven），正在按这个方式执行。
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
| 计划文档 Task 2/3 的"预期测试通过数"算错（写的 23/36，实际应为 24/33） | 1 | 写计划时手算漏项。发现于 Task 2 实现子代理跑出 24 而非 23 时。用 Edit 直接修正计划文档两处，另开 commit `530a65c`，并在后续任务派发时提前告知子代理这是已知文档笔误，不用当成自己的错 |
| Task 3 评审后派"补 ocr_failed 测试"的修复子代理时，Agent 工具报 `claude-sonnet-5 is temporarily unavailable`（分类器暂时不可用） | 1 | 等待后原样重新派发即可，不是任务本身的问题 |
| tesseract 多路 PSM 并集 + 预处理方案，用户实测后反馈"速度慢太多" | 1 | 直接回退到上一版单路 PSM11（commit `7eaa0c9`），不是去优化这版的速度，改走 PaddleOCR 这个完全不同的方向 |
| 反色处理 / 关键词字符白名单 / tessdata_best 高精度模型 / tesseract 内置 Sauvola 二值化，四个新思路依次实测，全部在 50-90 秒内跑不完 | 每个思路各试 1-2 次（换 PSM 模式重试过） | 判断是 tesseract LSTM 引擎在这几种用法下的已知性能短板，不是参数没调对，直接放弃这个方向，转向验证 PaddleOCR |
| PaddleOCR 默认配置在这台机器上报 `NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support`（MKLDNN 加速与某些算子不兼容） | 2（先试换模型版本 PP-OCRv4 替代默认的 PP-OCRv6，同样报错；再试降级 paddlepaddle 到 2.6.2，结果 paddleocr 3.x 需要 3.x 的新 API 报另一个错） | 显式关闭 `enable_mkldnn=False` 解决，换回 paddlepaddle 3.3.1，验证下来没有明显变慢 |

## 五问重启检查（阶段 6 结束时更新）
| 问题 | 答案 |
|------|------|
| 我在哪里？ | 阶段 6（OCR 精度优化）complete；PaddleOCR 方案已部署到 8080 测试环境并确认常驻进程正常运行，等用户下一轮实测反馈 |
| 我要去哪里？ | 等用户测完 PaddleOCR 版本的效果和稳定性；如果满意，下一步是阶段 5 遗留的生产发布流程（rsync 到 Product → /opt/workbench，需用户明确指令）和两处待决策的范围取舍项 |
| 目标是什么？ | 原始目标不变（素材文案关键词检测）；阶段 6 的子目标是把 OCR 识别精度提升到用户觉得"能投产"的水平 |
| 我学到了什么？ | tesseract 在电商海报这类拼贴版式+装饰字体上的天花板明显低于 PaddleOCR；速度和精度的取舍必须让用户明确拍板而不是自己猜（多路并集方案就是没跟用户对齐清楚，做完才发现用户嫌慢）；新技术方向落地前先用真实失败样本做免费实验（改参数、跑脚本）比直接写正式代码更省成本 |
| 我做了什么？ | 见上方"阶段 6"记录；4 个提交 `fe442c3`→`8aff9de`→`7eaa0c9`→`e6acf8b`，均已推送 `design/deepspace-polish`，另建 `feature/materialcheck-paddleocr-ocr` 分支固定保留 |

## 备注
- 随着进度更新阶段状态：pending → in_progress → complete
- 做重大决策前重新读取此计划（注意力操纵）
- 记录所有错误，避免重复
- **不要把计划文档（`docs/superpowers/plans/...`）的内容复制粘贴进这个文件** —— 这个文件只做进度追踪的索引，详细的代码/命令都在计划文档里，改动以那份文档为准。
