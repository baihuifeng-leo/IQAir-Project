# 竞品作战台 v2 技术方案

> 本文所有数字来自对你上传的 7 个 Excel（5,623 条初评 + 756 条追评）的实际解析，不是估算。
> 配套代码已写好并跑通：`xlsx-lite.js`、`reviews-nlp.js`、`reviews-ingest.js`、`public/particles.js`。

---

## 零、先说一件会改变方案的事

**你的 Excel 里没有星级/评分列。**

十个列是：`序号 · 旺旺号 · 初评时间 · SKU · 初评 · 晒图/视频 · 有用 · 追评 · 追评时间 · 追评晒图/视频`。七个文件的表头完全一致。

这直接影响需求二里的「好评统计 / 差评统计」。我把数据翻了个底朝天：

| 事实 | 数字 |
|---|---|
| 总记录（初评 + 追评拆行后） | 6,332 |
| 淘宝模板评论（"该用户觉得商品非常好，给出5星好评""该用户未填写评价内容"） | 1,544 条，**24.4%** |
| 有效评论 | 4,788 |
| 算法能识别出的负向分句 | **99 条，占比 2.2%** |

而且我逐条人工核对了这 99 条，**大约四成是误判**——"家里电梯坏了"（说的是电梯）、"不会很占地方"（这是夸）、"刺鼻的味道确实少了"（问题已解决）、"据说是智商税"（转述别人的看法）。

原因很清楚：**这批导出本身就是晒单好评。** 有一条评论的正文里直接写着"好评版（晒单好评，适合电商追评）"。

### 所以

按原计划做「好评数 vs 差评数」的对比看板，结果会是七个品牌清一色 97% 好评的柱状图——**看起来很专业，实际零信息量**，而且那 2% 的"差评"里还混着一半噪声。这种图放进汇报里是有害的，因为它会让人以为竞品都没缺点。

**两条路，建议同时走：**

1. **改导出口径（治本）。** 让运营在生意参谋 / 后台导出时勾上**评分列**，或者直接导「中评+差评」标签页。有了星级，好评差评就是一次 `GROUP BY`，不是 NLP 问题。这是最省事、最准的做法。

2. **换统计口径（治标，且更有价值）。** 不统计"整条评论是好是坏"，而统计**维度 × 极性**：

   > "静音很好，就是滤芯太贵" → `噪音:正向` + `滤芯成本:负向`

   一条评论同时贡献一个优点和一个缺点。这才是竞品分析真正要的东西。我已经实现并跑出了真实结果：

```
=== 品牌 × 维度负向率（样本量 ≥8 才计入）===
IQair_GC_XE    滤芯成本 13%(2/15)   异味处理  6%(1/18)   噪音  3%(1/36)
352Z90         质量做工  6%(5/81)   体积重量  5%(4/77)   滤芯成本 5%(7/144)
DysonBP04      质量做工 50%(4/8)    服务物流  8%(3/40)   噪音  6%(3/49)
```

戴森「质量做工」8 条提及里 4 条负面，这条信息比"戴森好评率 95%"有用一百倍。

**关于"关键词 + 出现次数 + 悬浮看原文"**：这个需求完全可以做，且效果好。因为你要的不是情感判断，而是**词频 + 溯源**。我把每个抽取结果都带上了 `context`（触发它的那个分句）和评论 id，Tooltip 直接展示原文即可。

---

## 一、现有功能的改动点

### 1.1 全局编辑模式（防误触）

顶栏加一个开关，默认 **只读**。

**实现要点**：不要在每个 `input` 上加 `disabled`，那要改几十处且样式难看。用一个根 class + CSS 拦截：

```css
/* 只读态：所有编辑控件不可交互，且视觉上退到背景里 */
body.readonly .chip input,
body.readonly .mx-brand input,
body.readonly .line input,
body.readonly [contenteditable] { pointer-events: none; user-select: text; }
body.readonly [contenteditable] { -webkit-user-modify: read-only; }
body.readonly .kill,
body.readonly .addhere,
body.readonly .addrow,
body.readonly .addline,
body.readonly .chip-tools,
body.readonly .rail .solid,
body.readonly .ghost.wide { display: none !important; }
body.readonly .chip { cursor: default; }
```

```js
// core.js
let editing = false;
function setEditing(on) {
  editing = on;
  document.body.classList.toggle('readonly', !on);
  $('#btn-edit').textContent = on ? '完成编辑' : '开启编辑';
  $('#btn-edit').classList.toggle('is-on', on);
  if (!on) { Matrix.clearSelection(); document.activeElement?.blur?.(); }
}
```

**三个必须处理的细节**（否则会出 bug）：

- **拖拽要跟着关**。`chip.draggable = editing`，否则只读态还能拖。
- **框选要跟着关**。`wireMarquee` 的 `mousedown` 里先 `if (!editing) return;`
- **协同的远端改动照常落地**。只读只挡本地输入，不挡 SSE。否则你会看着别人在改、自己这边不更新。

另外建议：**开启编辑时自动加一条日志**（`audit(me, 'edit.begin')`）。变更日志里就能看出谁在什么时候进过编辑态。

### 1.2 价格沙盘的富文本

现在的 `分类编辑` 用的是 `<input type="text">`，它天然不支持行内样式。

**别引第三方富文本编辑器**（Quill/TipTap 起步 100KB+，这里只要三个按钮）。换成 `contenteditable` + `document.execCommand`：

```js
function richField(obj, key) {
  const el = document.createElement('div');
  el.className = 'rich';
  el.contentEditable = 'plaintext-only';   // 先设 plaintext 防粘贴带样式
  el.contentEditable = 'true';
  el.innerHTML = obj[key] || '';

  el.addEventListener('input', () => { obj[key] = sanitize(el.innerHTML); A.save('matrix'); });
  el.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    const cmd = { b: 'bold', i: 'italic', u: 'underline' }[k];
    if (cmd) { e.preventDefault(); document.execCommand(cmd); }
  });
  // 粘贴强制纯文本，否则从 Word 粘进来一坨样式
  el.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
  return el;
}

/** 白名单：只留 b/i/u/strong/em，其余标签剥掉。存进 db.json 的东西必须干净。 */
function sanitize(html) {
  const ok = /^(B|I|U|STRONG|EM|BR)$/;
  const box = document.createElement('div');
  box.innerHTML = html;
  (function walk(n) {
    [...n.childNodes].forEach((c) => {
      if (c.nodeType === 1) {
        if (!ok.test(c.tagName)) { c.replaceWith(...c.childNodes); }
        else { [...c.attributes].forEach((a) => c.removeAttribute(a.name)); }
        walk(c);
      }
    });
  })(box);
  return box.innerHTML;
}
```

`execCommand` 确实被标记为 deprecated，但**没有任何浏览器计划移除它**，而替代方案（`Selection` + `Range` 手搓）在这个体量下是过度工程。三个按钮，用它。

⚠️ **富文本内容进了 `db.json` 就是 HTML 字符串**。渲染时必须用 `innerHTML`，所以 `sanitize()` 不是可选项——否则任何一个能编辑的同事都能往里塞 `<script>`。上面的白名单是最小实现。

### 1.3 移动端适配

现在的布局在手机上有三个硬伤：**固定宽度侧栏 264px**、**矩阵 `min-width: max-content`**、**顶栏一行塞不下**。

```css
@media (max-width: 760px) {
  :root { --rail-w: 100vw; }

  /* 侧栏改成抽屉，默认收起 */
  .rail { position: fixed; inset: 58px 0 0 0; z-index: 50; transform: translateX(-100%);
          transition: transform 0.32s var(--ease); }
  .view:not(.rail-off) .rail { transform: none; }
  .canvas { margin-left: 0; }

  /* 顶栏折行 + 隐藏次要按钮 */
  .topbar { height: auto; flex-wrap: wrap; padding: 8px 10px; gap: 10px; }
  #btn-undo, #btn-redo, .presence { display: none; }

  /* 沙盘：横向滚动是对的，但要给出滚动提示并收窄列 */
  .matrix { grid-template-columns: 92px repeat(var(--brands), 140px) !important; }
  .matrix-scroll { scroll-snap-type: x proximity; }
  .mx-cell { scroll-snap-align: start; }

  /* 对位表：改成一次看一个品牌的卡片流 */
  .cmp-row { grid-template-columns: 1fr !important; }
  .cmp-label { position: static; border-bottom: 1px solid var(--hair); }
  .cmp-cell { border-bottom: 1px dashed var(--hair); }
  .cmp-cell::before { content: attr(data-brand); font-size: 11px; color: var(--ink-dim); }

  /* 触控目标 ≥ 44px */
  .kill, .markdot, .chip-tools button { min-width: 32px; min-height: 32px; }
  .batchbar { left: 8px; right: 8px; transform: none; flex-wrap: wrap; }
}
```

**说句实话**：竞品对位表是一个 5 列 × 11 行的二维表，**手机上不可能完全避免横向滚动**。硬把它折成一维卡片流会丢掉"横向对比"这个核心价值。我的建议是——手机端**保留横向滚动但加 scroll-snap**，让每次滑动干净地停在一个品牌列上，而不是假装能塞下。

沙盘同理。真正该在手机上优化的是**侧栏抽屉**和**触控目标尺寸**，这两个改完体验就及格了。

### 1.4 图片：无压缩 + Lightbox + 独立上传入口

**这一条和现有实现冲突最大，要动到服务端。**

现在的链路是：`canvas.toDataURL(0.92)` → base64 → JSON POST。三个问题：

1. `toDataURL` **必然重编码**，无损不可能。
2. base64 让体积 **+33%**，服务端 `MAX_BODY` 是 24MB，一张 15MB 的原图就爆了。
3. 前端 canvas 中心裁剪也是一次重采样。

**改法**：

```js
// 前端：原图直传，不经 canvas
async function uploadOriginal(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('只支持 PNG / JPG / WebP');
  if (file.size > 40 * 1024 * 1024) throw new Error('单张不要超过 40MB');
  const r = await fetch('/api/upload?name=' + encodeURIComponent(file.name), {
    method: 'POST',
    headers: { 'Content-Type': file.type },   // 裸二进制，不 base64
    body: file
  });
  ...
}
```

```js
// 服务端：直接落盘，不解码不重编码
if (p === '/api/upload' && req.method === 'POST') {
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[req.headers['content-type']];
  if (!ext) return json(res, 415, { error: '只支持 PNG / JPG / WebP' });
  const name = crypto.randomBytes(9).toString('hex') + ext;
  const out = fs.createWriteStream(path.join(UPLOAD_DIR, name));
  await pipeline(req, out);            // 流式写，内存不驻留整张图
  return json(res, 200, { url: '/uploads/' + name });
}
```

`MAX_BODY` 对该路由提到 40MB。

**但是**——一张 4000×4000 的原图塞进 118px 的槽位里，浏览器每帧都要缩放解码，页面会卡。所以：

> **存原图，但另生成一张显示用的缩略图。**

这不是"压缩用户的图"，原图一字节没动，只是多存一个 `_thumb.jpg`（宽 480）。品牌卡里 `<img src=thumb>`，点开 Lightbox 时 `<img src=original>`。这是唯一能同时满足"无损"和"不卡"的方案。缩略图可以在服务端用纯 Node 生成吗？不能——没有解码库。**所以缩略图在前端 canvas 生成后单独上传一次**，两个文件，两个 URL：

```js
brand.image      = '/uploads/abc123.png'       // 原图，Lightbox 用
brand.imageThumb = '/uploads/abc123_t.jpg'     // 480px，卡片用
```

**交互重构**：

- 图片区**点击 = 看原图**（Lightbox），不再是上传。
- 悬停时右上角浮出一个「⟳ 更换」图标按钮，点它才走上传。
- 图片下方常驻一行小字入口：`重新上传 · 移除`。

Lightbox 用原生 `<dialog>`，21 行搞定，别引 lib：

```js
function lightbox(src) {
  const d = document.createElement('dialog');
  d.className = 'lightbox';
  d.innerHTML = `<img src="${src}"><button class="lb-close">×</button>`;
  d.onclick = (e) => { if (e.target === d || e.target.classList.contains('lb-close')) d.close(); };
  d.addEventListener('close', () => d.remove());
  document.body.appendChild(d);
  d.showModal();                       // Esc 关闭、焦点陷阱、背景遮罩全都自带
}
```

CSS 里 `.lightbox img { max-width: 92vw; max-height: 88vh; object-fit: contain; }`，**100% 比例查看**加一个 `img.style.maxWidth='none'` 的切换按钮即可。

---

## 二、评论风向标：架构与数据设计

### 2.1 存储选型

评论数据和现有的沙盘 / 对位**完全不同**：

| | 沙盘 / 对位 | 评论 |
|---|---|---|
| 数据量 | 几十 KB | 6,332 条，~4MB，还会长 |
| 写入方式 | 多人实时协同编辑 | 批量导入，只追加 |
| 冲突 | 需要三方合并 | 不存在（内容寻址） |

所以**不要**把评论塞进 `db.json`。那会让每次改一个产品价格都要序列化 4MB，协同合并也会变慢。

```
/var/lib/workbench/reviews/
  brands.json        品牌 → 产品映射，人工维护
  reviews.jsonl      一行一条评论，append-only，行内 id 即指纹
  aggregates.json    预计算的看板数据（导入后重建）
```

`reviews.jsonl` 用 JSON Lines：追加就是 `fs.appendFile`，不用读写整个文件。启动时一次性读进内存 `Map<id, record>`（6 千条约 8MB 内存，十万条也不过 130MB，够用很久）。

**什么时候该换 SQLite**：单表超过 ~20 万条，或者需要按时间范围 + 品牌 + 维度做任意组合查询。到那天再迁，别提前上。

等价的 SQLite DDL（备用）：

```sql
CREATE TABLE reviews (
  id           TEXT PRIMARY KEY,        -- sha256(brand|sku|nick|date|type|text)[:32]
  brand_id     TEXT NOT NULL,
  sku          TEXT NOT NULL,           -- 已清洗
  nick         TEXT,                    -- 旺旺号，已脱敏
  type         TEXT NOT NULL,           -- 初评 | 追评
  date         TEXT NOT NULL,           -- YYYY-MM-DD，源数据无时分秒
  text         TEXT NOT NULL,
  text_norm    TEXT NOT NULL,           -- 全角转半角、去表情、压空白
  media        TEXT,                    -- JSON 数组
  useful       INTEGER DEFAULT 0,       -- 「有用」列
  is_template  INTEGER DEFAULT 0,       -- 淘宝默认好评
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_brand_date ON reviews(brand_id, date);
CREATE INDEX idx_template   ON reviews(is_template);

-- 维度抽取结果，一条评论多行
CREATE TABLE review_aspects (
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  aspect    TEXT NOT NULL,              -- 净化效果 / 噪音 / 滤芯成本 …
  polarity  TEXT NOT NULL,              -- pos | neg
  terms     TEXT NOT NULL,              -- 触发词，JSON 数组
  context   TEXT NOT NULL               -- 触发它的那个分句，Tooltip 用
);
CREATE INDEX idx_aspect ON review_aspects(aspect, polarity);
```

### 2.2 去重机制（这里有个坑）

你在需求里写的是「通过评论内容 MD5 摘要」。**我实测了，这个方案会误删数据。**

```
5,623 条初评：
  只对正文取哈希      → 唯一 4,035 条，丢掉 1,588 条
  品牌+SKU+旺旺号+日期+正文 → 唯一 5,580 条，丢掉    43 条
```

丢掉的 1,588 条里：

- **1,544 条是淘宝模板评论**——"该用户觉得商品非常好，给出5星好评"这一句出现了 **904 次，来自 600 个不同买家、483 个不同日期**。它们确实该被压缩，但应该是**标记为模板后排除统计**，而不是在去重阶段悄悄删掉（删了你就永远不知道这个品牌有多少人懒得写评价）。
- **44 条是不同买家写出的相同真实短评**，比如"收到后开机用了一天，完全没闻到异味，很安心。"出现 9 次，来自小米和霍尼韦尔两个品牌的 8 个买家。这些是**真实且独立的评论，绝不能删**。

所以指纹是：

```js
sha256([brandId, sku, nick, date, type, normalize(text)].join('\u0001')).slice(0, 32)
```

- `brandId` — 同一句话出现在两个品牌下，是两条独立数据
- `sku` — 同品牌不同型号要分开
- `nick` — 旺旺号已脱敏（`用**2`），单独不唯一，但能拉开区分度
- `date` — 源数据只到天，没有时分秒，所以不能只靠时间
- `type` — `初评` 和 `追评` 是两条独立记录
- `normalize(text)` — 全角转半角、去表情、压空白后再哈希，避免复制粘贴导致的假差异

用 SHA-256 不用 MD5：不是怕碰撞（这个量级 MD5 也够），而是 MD5 在很多公司的安全扫描里会直接报红，换个函数零成本。

**幂等性已验证**：

```
第一次导入 7 个文件 → 新增 6,332 条
第二次导入同样文件 → 新增 0 条，跳过 6,332 条   ✓
模拟增量（3,702 条里有 3 条新的）→ 新增 3，跳过 3,684，文件内自重复 15
```

### 2.3 字段处理

| 源列 | 处理 |
|---|---|
| `序号` | **丢弃**。导出行号，不同批次会变，无业务含义 |
| `旺旺号` | 原样保留（已脱敏），参与指纹 |
| `初评时间` | 只有日期。写死校验 `^\d{4}-\d{2}-\d{2}$`，不匹配的记数上报 |
| `SKU` | **脏**。`Z90空气净化器【店铺热销】`、`深灰色[Z90空气净化器]`、`深灰色` 指的是同一个东西。剥掉 `【】` 和 `[]`，剩下的做人工映射表 |
| `初评` / `追评` | 拆成两条独立记录，`type` 区分 |
| `晒图/视频` | JSON 数组字符串，空值是 `"[]"`。协议相对 URL（`//img.alicdn.com/…`）要补 `https:` |
| `有用` | 整数。**这是个好信号**——「有用」数高的差评权重应该更大 |

`SKU` 那 14 个取值需要你人工确认一次映射（`深灰色` → `Z90`？），代码里我留了 `cleanSku()` 做机械清洗，语义映射得靠你。

### 2.4 接口

```
POST /api/reviews/import      上传 xlsx（multipart 或裸二进制）
  ?brandId=iqair_gc_xe
  → { rows, 初评, 追评, 模板, added, skipped, dupInFile }

GET  /api/reviews/summary     看板聚合数据（读 aggregates.json）
GET  /api/reviews/keyword?term=噪音&polarity=neg&limit=20
  → [{ reviewId, brandName, date, context, text, useful }]   Tooltip 溯源
GET  /api/reviews/brands      品牌与产品映射
```

**权限**：导入和删除只给管理员，查看给所有人。导入动作写进现有的 `audit.log`。

---

## 三、粒子进场动画

代码已写好：`public/particles.js`（约 200 行，零依赖）。

### 3.1 技术选型：Canvas 2D，不用 Three.js

- 这是**屏幕空间的 2D 聚散**，没有三维透视需求。上 WebGL 是杀鸡用牛刀。
- Three r128 打包 ~600KB。而你这套系统的设计原则是**不请求任何外部 CDN**（内网可用），把 600KB 塞进 `public/` 不值当。
- 3,000～4,000 个粒子，Canvas 2D 的 `arc()` + `fill()` 在 2020 年之后的机器上稳 60fps。真到十万粒子级别再考虑 WebGL。

关键性能手段：**8 个 `Float32Array` 存 x/y/目标x/目标y/vx/vy/色相/相位**，而不是 4000 个 `{x, y, vx, vy}` 对象。前者是一块连续内存，GC 完全不介入；后者每帧都在制造垃圾。

### 3.2 三幕结构

```
时间轴 t ∈ [0, 1]，总长 2600ms

[0.00 ─ 0.30]  涌入
   粒子从屏幕四周之外生成，只受涡旋场驱动，
   像默默然那团黑烟一样翻卷。此时对目标点没有吸引力。

[0.30 ─ 0.72]  重组
   每个粒子被指派一个目标点（见下），吸引力随 easeInOutQuad 从 0 涨到 1。
   涡旋权重同步衰减，粒子逐渐"认命"，轮廓浮现。

[0.72 ─ 1.00]  消散
   吸引力保持，但叠加一个反向的扩散力，粒子散开、变淡。
   ★ t = 0.78 时触发 onReveal()：真实 DOM 看板开始淡入，
     canvas 同时 opacity → 0。两者重叠约 500ms，这就是"丝滑"的来源。
```

**"重组成看板雏形"的形状从哪来**：把标题文字和三个卡片轮廓画到一张**离屏 canvas**，`getImageData` 拿到像素，把 alpha > 128 的点抽稀成目标点池。粒子按索引等距取点，保证分布均匀。

```js
function sampleTargets(w, h, want) {
  const off = document.createElement('canvas');
  const c = off.getContext('2d', { willReadFrequently: true });
  c.fillText('评论风向标', w / 2, h * 0.42);       // 文字
  for (let i = 0; i < 3; i++) c.strokeRect(...);   // 卡片轮廓
  const data = c.getImageData(0, 0, w, h).data;
  const step = Math.max(2, Math.round(Math.sqrt(w * h / (want * 6))));
  const pts = [];
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step)
      if (data[(y * w + x) * 4 + 3] > 128) pts.push(x, y);
  off.width = off.height = 0;    // 主动释放离屏位图
  return pts;
}
```

烟雾拖尾不靠 `clearRect`，而是每帧铺一层 `rgba(8,12,20,0.30)` 的半透明底——旧帧逐渐变暗但不消失，这就是烟的质感。

### 3.3 生命周期（最容易出 bug 的地方）

**必须保证的三件事**：

1. `cancelAnimationFrame` 一定要调。不然切走了动画还在后台烧 CPU。
2. canvas 元素要从 DOM 移除，`Float32Array` 引用要断开。8 个数组 × 4000 × 4B ≈ 130KB，不断引用就一直挂着。
3. `destroy()` **必须幂等**。它会从三个地方被调用：动画自然结束、窗口 resize、用户中途切走标签页。

```js
function destroy() {
  if (dead) return;                 // ← 幂等闸门
  dead = true;
  cancelAnimationFrame(raf);
  removeEventListener('resize', onResize);
  if (!revealed) { revealed = true; onReveal(); }   // 中途退出也要把看板露出来
  canvas.style.opacity = '0';
  setTimeout(() => {
    canvas.remove();
    canvas = null;
    px = py = tx = ty = vx = vy = hue = seed = null;
    onDone && onDone();
  }, 440);
}
```

**resize 处理**：动画进行中改窗口大小，我的选择是**直接收尾**，而不是重算所有粒子的目标点。理由——那 2.6 秒里用户拖窗口的概率极低，为它写一套重排逻辑，代码复杂度翻倍还容易留 bug。收尾是可预测的降级。

**`prefers-reduced-motion`**：直接 `destroy()`，看板立刻显示。有前庭功能障碍的人会因为这种全屏粒子动画头晕，这不是可选项。

### 3.4 接入现有的标签切换

只有这个模块触发，另外两个不受影响：

```js
let introPlayed = false;
function go(next) {
  const wasElsewhere = view !== next;
  view = next;
  // …原有的 tab 切换逻辑…

  if (next === 'reviews' && wasElsewhere && !introPlayed) {
    introPlayed = true;                       // 本次会话只放一次，别每次点都放
    const board = $('#view-reviews .board');
    board.style.opacity = '0';
    const intro = ParticleIntro.create({
      onReveal: () => { board.style.transition = 'opacity 600ms'; board.style.opacity = '1'; },
      onDone:   () => { /* 已自我销毁 */ }
    });
    intro.start();
    // 用户在动画中途切走 → 立刻收尾
    once('.tab', 'click', () => intro.destroy());
  }
}
```

**一个交互建议**：`introPlayed` 让它每次会话只放一次。炫酷的动画第一次是惊艳，第五次是障碍——而你每天要打开这个页面很多次。可以在侧栏留一个「重放进场动画」的小按钮给演示时用。

---

## 四、Excel 解析与增量去重（代码已跑通）

### 4.1 为什么是 Node 不是 Python

你的服务已经是**零依赖 Node**，跑在 systemd 下。为了读 Excel 引入 Python + pandas 意味着：多一个运行时、多一套依赖管理、多一个进程间通信。

而 `.xlsx` 本质就是一个 zip，里面是 XML。我写了 `xlsx-lite.js`——**150 行，零依赖**，用 Node 自带的 `zlib.inflateRawSync` 解压，正则解析 `sharedStrings.xml` 和 `sheet1.xml`。

**已用 pandas 做基准对拍，7 个文件全部一致**：

```
✓ 352Z90.xlsx            行 3223/3223  表头一致  抽样一致
✓ AirproceAI-700.xlsx    行  643/643   表头一致  抽样一致
✓ DysonBP04.xlsx         行  617/617   表头一致  抽样一致
✓ IQair_GC_XE.xlsx       行  390/390   表头一致  抽样一致
✓ 小米6max.xlsx           行  175/175   表头一致  抽样一致
✓ 美的U8.xlsx             行  335/335   表头一致  抽样一致
✓ 霍尼韦尔H-Mate.xlsx      行  240/240   表头一致  抽样一致
```

它兼容了 `inlineStr`、布尔值和 Excel 序列号日期，换个导出工具也不至于当场崩。

### 4.2 核心去重代码

```js
function fingerprint({ brandId, sku, nick, date, type, text }) {
  const payload = [brandId, sku || '', nick || '', date || '', type, normalize(text)].join('\u0001');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function mergeIncremental(store, incoming) {
  const report = { incoming: incoming.length, added: 0, skipped: 0, dupInFile: 0 };
  const seenThisFile = new Set();
  for (const rec of incoming) {
    if (seenThisFile.has(rec.id)) { report.dupInFile++; continue; }  // 文件内自重复
    seenThisFile.add(rec.id);
    if (store.has(rec.id)) { report.skipped++; continue; }           // 库里已有
    store.set(rec.id, rec);
    report.added++;
  }
  return report;
}
```

`dupInFile` 单独计数很重要——它告诉你**这次导出本身**有多少重复行（实测 352 那份有 15 行）。混进 `skipped` 里你就分不清是"上次传过"还是"这份文件自己有问题"。

### 4.3 维度抽取：中文关键词匹配的三个坑

`reviews-nlp.js` 里每条规则都带前后界约束。这不是过度设计，是我踩出来的：

| 坑 | 例子 | 后果 |
|---|---|---|
| 否定词藏在别的词里 | **特别**满意 → "别"被当否定词 | 好评判成差评 |
| 子串越界匹配 | 噪音**大**小整体还可以 | 命中"噪音大" |
| 维度归错 | 空气**质量**差 | 归到"质量做工"，其实说的是室外空气 |

还有更隐蔽的一个：我一开始写 `negatedAt()` 时先 `slice` 出前 4 个字再跑正则，**把 lookbehind 的左侧上下文切掉了**，于是 `(?<![特识分])别` 又失效了。正确做法是在整句上定位所有否定词位置，再判断距离。

另外加了三道语境守卫：

- **传闻引用** `据说是智商税` / `一直害怕是智商税` → 这是别人的看法，不是本人差评
- **问题已解决** `刺鼻的味道确实少了` → 负面词描述的是被消除的对象
- **主语不是产品** `家里电梯坏了` / `北方冬天不方便开窗` → 跟产品无关

修完之后误判明显下降，但**我不会告诉你它准确率 95%**。中文规则引擎在这类文本上的负向精确率大概六到七成，而负向样本本来就只有 2%。这就是为什么第零节说：**先把评分列拿到手。**

---

## 交付清单

| 文件 | 状态 |
|---|---|
| `xlsx-lite.js` | ✅ 已跑通，与 pandas 对拍一致 |
| `reviews-nlp.js` | ✅ 已跑通，含 16 条边界用例 |
| `reviews-ingest.js` | ✅ 已跑通，幂等性已验证 |
| `public/particles.js` | ✅ 已写完，浏览器端运行 |
| 编辑模式 / 富文本 / 移动端 / Lightbox | 📋 改动点与代码片段见上，未接入现有代码库 |
| 看板 UI + 词云 + Tooltip | 📋 待实现 |
| `/api/reviews/*` 路由 | 📋 待实现 |

**建议的落地顺序**：

1. **先改导出口径，把评分列拿到。** 这一步不做，第 2 步做出来的看板就是个花瓶。
2. 编辑模式 + 图片无压缩 + Lightbox —— 独立、低风险、当天见效。
3. 评论入库链路（`/api/reviews/import` + JSONL 存储），先跑通数据，看板可以先用一张朴素的表。
4. 最后做粒子动画和词云。它们很好看，但没有数据的时候好看也没用。

第 2、3 步我可以直接接进现有代码库并打包发你。要不要现在就做？
