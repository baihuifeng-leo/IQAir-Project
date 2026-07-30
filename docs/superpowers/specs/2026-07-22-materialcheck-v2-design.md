# 素材质检 v2 — 权限/平台/分类/状态/进度条 设计文档

来源：`/grill-me` 交互式确认会话（2026-07-22），逐题过、每题给推荐项、用户逐一拍板，最后完整方案汇总用户回复"确认"。

## 背景

素材质检功能（阶段 1-6）已上线到测试环境。用户实测后提出 4 个方向的优化需求，逐一梳理成下面的具体设计。

## 1. 词库查看/编辑权限

- 用户对象新增字段 `materialLibraryRole: 'edit' | 'view' | 'none'`。
- `admin: true` 的用户永远隐式视为 `edit`，不单独存这个字段的值（或存了也被忽略）。
- 非 admin 用户默认 `view`。
- 权限只管「关键词库」这个配置页面：
  - `edit`：正常可编辑。
  - `view`：看到同一套 UI，但所有编辑控件（输入框、增删按钮、保存按钮）disabled。
  - `none`：跟现在的非 admin 行为一样，整个 tab 隐藏。
- 上传检测功能（用词库比对图片文字）不受此权限影响，任何登录用户都能用，跟现状一致。
- 该权限是全局的（不按平台拆分），有 `edit` 权限的人天猫、京东两套词库都能改。
- 用户管理页面（`public/users.js`）新增一个下拉框，admin 可以给其他用户设置这个字段。

## 2. 天猫/京东独立词库

- `materialcheck/products.json` 结构从扁平的 `{products, universalKeywords}` 改成按平台命名空间：
  ```json
  {
    "tmall": { "products": [...], "universalKeywords": [...], "machineSharedKeywords": [...], "filterSharedKeywords": [...], "accessorySharedKeywords": [...] },
    "jd": { "products": [...], "universalKeywords": [...], "machineSharedKeywords": [...], "filterSharedKeywords": [...], "accessorySharedKeywords": [...] }
  }
  ```
- 两个平台的产品、关键词、通用词、组内通用词完全独立维护，互不影响。
- 检测 tab 顶部新增平台切换器（天猫/京东），选择记在 `sessionStorage`，当次会话内所有上传/查看都用这个平台，切 tab、刷新页面不丢。
- `records.jsonl` 每条记录新增 `platform` 字段；历史记录页面新增平台筛选下拉框，跟现有产品/状态/上传人筛选并列。
- **旧数据迁移**：现有 `products.json`（扁平结构）里的全部产品/关键词，一次性迁移脚本迁移到 `tmall` 命名空间下；`jd` 命名空间初始为空产品/空关键词。旧的 `records.jsonl` 历史记录**不回填** `platform` 字段（读的时候当作 `null`/未知平台处理，筛选下拉框里可以选"（未知平台）"看到这些旧记录）。

## 3. 关键词分类（管理组织用，不影响检测逻辑）

- 每个关键词从纯字符串变成 `{ text: string, category: string }` 对象。
- 分类枚举：`产品型号` / `产品利益点` / `日常销售利益点` / `大促销售权益` / `附加权益` / `国补` / `价格` / `其它`。
- 纯粹是管理员编辑词库时的组织/筛选维度，**不影响**缺词/串词判定逻辑、不影响严重程度。
- 旧关键词迁移时统一打 `其它` 分类（不强制补全，允许为空/`其它` 兜底）。

## 4. 机器/滤芯/附件分组 + 组内通用词

- 每个产品新增 `type: 'machine' | 'filter' | 'accessory' | ''` 字段，单选，允许为空（迁移过来的旧产品默认空）。
- 新增三套「组内通用词」列表（每个平台各一份，见上面第 2 节的 JSON 结构）：`machineSharedKeywords`、`filterSharedKeywords`、`accessorySharedKeywords`。
- 语义等价于现有的全局 `universalKeywords`，只是作用范围收窄到"同 `type` 的产品之间"：
  - 词出现在 `machineSharedKeywords` 里 → 对所有 `type === 'machine'` 的产品都不算缺词/串词；对 `filter`/`accessory`/空 类型的产品，如果这个词恰好是它们的专属词，出现在别处仍然照常算串词。
  - `filterSharedKeywords`/`accessorySharedKeywords` 同理。
- 唯一性校验（`validateLibrary`）范围扩大：一个词不能同时出现在"某产品专属词 / 全局通用词 / 三套组内通用词"里的两处以上。
- `type` 为空的产品：不参与任何组内通用词的豁免判定（既不享受豁免，也不因为没类型而报错），现有缺词/串词逻辑对它完全不受影响。

## 5. 检测状态三态化

- `status` 取值从 `'pass' | 'fail'` 改成 `'pass' | 'warn' | 'error'`（`'ocr_failed'` 不变，独立于这三态）。
- 固定规则（不做成可配置项）：
  - 有 `crossedKeywords`（串词，别的产品专属词出现在本产品素材里）→ `error`。
  - 没有串词，但有 `missingKeywords`（缺词）→ `warn`。
  - 都没有 → `pass`。
  - 两者都有 → `error`（错误优先），但详情里依然分别列出缺词和串词两部分内容，不因为状态是 error 就不显示缺词列表。
- **历史数据不迁移**：`records.jsonl` 里已经写入的旧 `status: 'fail'` 记录原样保留，不回填成 warn/error。历史筛选下拉框里 `fail`（旧）、`warn`、`error`、`pass`、`ocr_failed` 都可以选。

## 6. 上传后整批进度条

- 在现有的文字摘要（"本次上传 N 张 · 已完成 X · 待选择 Y · 处理中 Z"）旁边/下面加一条可视化进度条（`<progress>` 或等价的 div 填充条），按 `已完成 / 总数` 填充。
- 不做单文件字节级上传进度（fetch 无法拿 upload.onprogress，而且图片本身传输很快，OCR 识别的几秒钟才是耗时大头，字节级进度条会造成"进度条冲到100%但其实还在后台识别"的误导）。

## 不在本次范围内

- 材质检测记录数据本身的迁移/回填（保持"旧数据留旧样子"的最小改动原则）。
- 权限按平台拆分（本次是全局一份 `materialLibraryRole`）。
- 产品 `type` 多选（本次单选，互斥分类）。
