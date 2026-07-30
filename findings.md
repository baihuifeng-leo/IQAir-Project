# 发现与决策

## 需求
- 批量上传素材图片，自动 OCR 识别文字，跟后台配置的产品专属关键词比对
- 检测两类问题：**缺词**（本产品该出现的关键词没出现）、**串词**（别的产品的关键词混进来了）
- 通用词（比如"7天无理由退换"）不参与判定，任何产品图上出现都不算问题
- 产品归属识别要有兜底：文件名匹配 → OCR文字反查 → 人工选择，三级降级，同时顺带检查"型号是不是填错了"
- 关键词库仅管理员可改，上传检测所有登录用户都能用
- 检测结果要留档，支持按产品/状态/上传人/日期回看历史

## 研究发现（代码库现状，来自两个并行 Explore agent 的详细报告）

### 服务端模式（server.js 686 行）
- 路由是一整个 `if (p === '/api/...') {...}` 顺序链，没有框架
- 鉴权在链条前段统一做一次闸门检查，之后的 handler 都能直接用闭包里的 `me`
- 管理员校验永远是字面量 `if (!me.admin) return json(res, 403, {...})`，全文 6 处一模一样的写法
- Store 模块（`reviews-store.js`/`report-store.js`/`preview3d-store.js`）都是普通 class，构造时传目录路径，`load()`/持久化方法自己管
- `reviews-store.js` 是 JSONL 追加写的范本（`fsp.appendFile`），`preview3d-store.js` 是整份覆盖写的范本
- `audit(user, action, detail)` 是 server.js 本地函数（不是 `audit.js` 导出的那个 `diffSummary`，两者是完全不同的东西，命名容易搞混）
- `/api/upload` 原图直传不重编码，40MB 上限，`crypto.randomBytes(9).toString('hex')` 做文件名
- `install.sh` 目前只有一处 apt 安装（装 Node），新增 tesseract 步骤要插在 Node 步骤和"专用用户"步骤之间，后续步骤编号要顺延
- `scripts/repack-tarball.sh` 用两个 `cp` 列表做打包清单，一个给服务端文件，一个给 `public/` 前端文件；`merge.js`/`audit.js` 不在任何列表里，因为它们只存在于 tarball 里，靠"先解压旧 tarball 做底再覆盖"这个机制保留

### 前端模式（vanilla JS，无框架无构建）
- 5 个标签页都是一样的接线方式：`index.html` 里的 `<button class="tab" data-view="x">` + `<section class="view" data-view="x" hidden>` + 底部 `<script src="/x.js">`
- `core.js` 的 `go(next)` 靠 `hidden` 属性切换视图，`MODULES` 数组和 `boot()` 里的 hash 白名单都要跟着加新 key
- 每个 tab 模块都是 IIFE，`init(api)` 接收 core.js 传进来的共享对象，模块内部手写一个 `call()` 包装 `A.guard(fetch(...))`，没有全局 `fetchJSON`
- **没有 FormData/multipart，全站上传都是 `body: file` 直接发原始字节**，服务端读原始流
- **没有任何 spinner/进度条组件**——loading 态全靠按钮 disabled + 文字替换（"解析中…"）或 toast，这次新功能的"识别中…"动画是全新写法，不是复用现成组件
- `core.js` 的 `processImage()`（canvas 重编码+压缩）**故意没被 `uploadImage()` 调用**，因为重编码会让文字发糊——这条对 OCR 场景是直接可用的既有教训，材质检测的上传必须走原图直传，不能压缩
- 管理员专属功能是把整个菜单分组从 DOM 里删掉（不是隐藏），后端路由也独立做 403 兜底——双重保险，前端隐藏只是体验，真正的授权在后端
- `admin.js` 的变更日志面板是"整批拉回来，纯前端内存过滤"，没有服务端按关键词查询这一层——这次历史记录视图直接抄了这个简单模式

### merge.test.js 测试风格（零框架）
- `let pass=0, fail=0`，一个 `t(name, ...)` 小函数跑断言、打 ✓/✗，最后 `console.log` 汇总 + `process.exit(fail?1:0)`
- 新写的 `materialcheck.test.js` 沿用同样的极简风格，只是因为多个函数签名不同，用了更通用的 `t(name, fn)` + `assert` 包装，而不是 merge.test.js 那种"固定参数形状"的版本

## 技术决策
| 决策 | 理由 |
|------|------|
| OCR：系统级 tesseract-ocr（apt），Node 侧 child_process 调用 | 见 task_plan.md「已做决策」表，这里不重复 |
| 产品归属识别复用关键词数据本身打分，不单独维护"识别用标识符"字段 | 减少管理员重复维护数据的负担，型号本身通常就在专属关键词列表里 |
| 一个关键词只能属于一处（某产品专属 或 通用词），保存时校验 | 让运行时匹配逻辑不用处理归属歧义，复杂度前移到写入时一次性检查 |
| pending（待人工选择）状态不落历史记录，只在内存缓存 30 分钟 | 避免历史记录堆积"没人处理完"的半成品数据 |
| **【阶段6新增】OCR 引擎换成 PaddleOCR，取代 tesseract** | 用户拿真实素材图实测，tesseract 反复调参（PSM/预处理/白名单/高精度模型）都有明显识别错误；PaddleOCR 真机对比测试效果好一个量级，且更快（6-15秒 vs tesseract 多路并集的1.5-3分钟） |
| **【阶段6新增】PaddleOCR 常驻 Python 子进程，而非每次现起进程** | 模型加载要 1-30 秒，不能像 tesseract 那样每张图重新付一次这个成本；用 stdin/stdout 按行 JSON 协议跟 Node 通信 |
| **【阶段6新增】OCR 结果按行置信度过滤噪声，整体置信度低于阈值转人工核对** | PaddleOCR 自带逐行置信度，图标噪声基本 <0.5，真实文案基本 >0.85；用户明确要求"低置信度跟现有人工选择流程一样处理"，不要新造一套 UI |
| **【阶段6新增】速度不作为硬约束，允许用延迟换精度** | 用户主动说明"识别速度没有太高要求，稍微慢一些也可以"——但后来实测三路并集方案后又反悔，说明这个权衡需要让用户看到实际数字（分钟级）才能做出准确判断，不能只讲"慢一点" |

## 【阶段7新增】v2 设计决策
| 决策 | 理由 |
|------|------|
| 词库权限 `materialLibraryRole: edit/view/none`，全局一份、不按平台拆分 | admin 隐式 edit；`/grill-me` 逐题确认，用户明确选了"全局一份"而非按平台拆分，先按最简单的来 |
| 天猫/京东按命名空间隔离数据（`{tmall:{...}, jd:{...}}`），不是给产品加 platform 字段 | 用户明确选择"完全独立的两套"，命名空间隔离比"扁平数组+字段过滤"更不容易漏加过滤条件而串平台 |
| 关键词分类纯粹是组织元数据，不影响缺词/串词的严重程度判定 | 用户明确要求两个维度分开，"类别只是管理组织用，严重程度单独配" |
| 机器/滤芯/附件"组内可共享"通过三套独立的通用词列表实现，且不需要 matchAgainstProduct 感知 type | 关键技术发现：只要 validateLibrary 保证组内通用词和任何产品专属词不重叠，"组内共享"就是唯一性约束的自然结果，匹配算法本身不用改一行 |
| 三态 status（pass/warn/error）用固定规则（串词>缺词>通过），不做成逐关键词可配置 | 用户明确选"固定规则"选项，理由是没有需要区分"这个词串了但影响小"的场景 |
| 旧记录 `status:'fail'` 不迁移，历史筛选下拉框里保留这个选项 | 用户明确选择"不迁移"，最小改动原则 |
| 上传进度条按"整批百分比"做，不做单文件字节级进度 | 用户明确选择，理由是 OCR 识别耗时远大于图片传输耗时，字节级进度条会造成"条已经满了但其实还在后台识别"的误导 |

## 遇到的问题
| 问题 | 解决方案 |
|------|---------|
| 写计划时发现 Task 5 提到"Task 6 Step 5"但 Task 6 实际commit是Step 4 | 已用 Edit 工具修正两处引用，现在计划文档内部一致 |
| 【阶段6】tesseract 的 tessedit_char_whitelist 白名单机制在 LSTM 引擎下会导致单次识别耗时暴涨到 60-90 秒以上，不管换哪个 PSM 值都一样 | 判断是 tesseract 该功能在新版引擎下的已知性能短板，放弃这条路，没有继续深挖底层原因 |
| 【阶段6】PaddleOCR 默认配置在这台机器上跑不起来，报 `NotImplementedError: ConvertPirAttribute2RuntimeAttribute not support`（oneDNN 加速与 PIR 执行器某些算子组合的兼容性 bug） | 显式传 `enable_mkldnn=False` 关掉 oneDNN 加速，问题解决，且没有观察到明显变慢 |
| 【阶段6】测试环境（EC-Workbench/Test）不是 install.sh 管理的部署，PaddleOCR 需要的 Python venv 得手动搭建，跟生产环境未来走 install.sh 自动搭建的路径不完全一致 | 手动在 Test 目录下 `python3 -m venv venv` + pip 装包 + 跑一次 `--warmup` 触发模型下载，操作跟 install.sh 里写的步骤保持一致，只是手动执行而非脚本自动跑 |
| 【阶段7】沙盒里没有真实浏览器，之前几轮只能靠 curl 验证前端改动，视觉/交互没法验证 | 本次在 `$CLAUDE_JOB_DIR/tmp` 临时装了 Playwright（`npm install playwright`，不进仓库、验证完即弃），起 headless Chromium 跑通了完整登录→上传→词库编辑→平台切换→用户管理的真实浏览器交互链路，比过去几轮的 curl-only 验证更接近真实使用 |
| 【阶段7】重复用同一个 DATA_DIR 跑两次浏览器测试脚本，第二次报"关键词「X」重复出现在「Y」和「Y」" | 一开始以为是 validateLibrary 的 bug，排查发现是测试方法论问题：第一次脚本运行已经把"GC-Multi"产品存进了那个 DATA_DIR，第二次脚本又新建了一个同名产品，两个不同 id 但同名产品各自都有相同关键词，触发的是唯一性校验的正确行为，不是应用层 bug——每次跑浏览器验证脚本前应该清空 DATA_DIR |

## 资源
- 设计文档：`docs/superpowers/specs/2026-07-21-material-keyword-check-design.md`
- 实施计划：`docs/superpowers/plans/2026-07-21-material-keyword-check.md`
- 项目背景：`/root/IQAir-Project/CLAUDE.md`（仓库分层结构、部署流程、零依赖约束）

## 视觉/浏览器发现
（本项目脑暴+规划阶段没有用到浏览器/截图工具，暂无记录；进入 Task 6-8 的手动验证阶段后如果用浏览器工具查看效果，要在这里补记关键截图发现）

---
*每执行2次查看/浏览器/搜索操作后更新此文件*
*防止视觉信息丢失*
