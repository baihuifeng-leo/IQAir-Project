# 个人报告自定义空白页（PPT 式编辑 + 放映模式接入）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「报告管理 → 个人报告」现有两页（生意参谋 / 微盟数据）之后，允许用户新建任意数量的自由画布空白页——可以新建文字、插入图片、拖拽移动、调整大小，并在「放映模式」下跟着原有两页一起顺序翻页展示。

**Architecture:** 复用现有 `switchPage`/方向键翻页机制（不新建同屏平铺展示）；每个自定义页是一块固定 1280×720 逻辑画布，用 `transform: scale()` 整体缩放适配容器；元素（文字/图片）用绝对定位 + 手写 pointer-events 拖拽/缩放（仓库零外部依赖，不能引入 Fabric.js/Konva 等库）；编辑内容按用户私有数据存进 `report-store.js`（新增 `slides` 字段），debounce 自动保存，不走 matrix/compare 那套三方合并。

**Tech Stack:** 原生 JS（无框架）、Node.js 内置 `http`（无 Express）、CSS 自定义属性驱动主题、`report-store.js` 的 JSON 文件存储。

## Global Constraints

- 仓库零外部依赖、零构建（无 CDN、无框架、无 bundler）——所有拖拽/缩放/富文本交互必须手写，不能引入第三方画布库。
- 目标分支：在一个 feature 分支上开发（例如 `feature/report-personal-slides`），验证通过后再合并 `main`；不要直接在 `main` 上提交。
- 没有自动化前端测试套件，UI 改动一律手动验证（`node server.js`，浏览器登录后操作）。后端存储逻辑（`report-store.js`）沿用仓库里 `merge.test.js`/`materialcheck.test.js` 的手写 `✓/✗` 测试风格，`node report-store.test.js` 直接跑。
- 范围只覆盖「个人报告」子页签；「公共报告」不涉及（仍是占位开发中）。
- **两处对已确认需求规格的工程澄清（如与你的理解有出入，请在动手前指出，实现时会照此执行）：**
  1. **默认字号是否跟随主题**：已用 grep 核实 `public/styles.css` 里 `:root` 与 `:root[data-theme="light"]` 两个主题块——现有主题系统只切换颜色类 CSS 变量（`--surface`/`--text`/`--mint` 等），从未有过任何字号类 token，深浅色下所有元素字号完全一致。因此本计划把"默认背景、默认文字色跟随主题"落地为：画布背景/默认文字色直接引用 `var(--surface)`/`var(--text)`（主题切换时 CSS 自定义属性会自动生效，不需要额外 JS 监听 `wb-themechange` 重绘）；"默认字号"按本仓库现有惯例处理为一个固定常量（28px，画布坐标系），不随主题变化——因为"字号跟主题走"这件事在现有设计体系里没有对应的实现基础。
  2. **新建文字的入口**：确认需求时的描述里同时出现了"工具栏新建文字按钮"和"点击画布空白处新建文字框"两种说法。这两者会互相冲突——如果点击空白处直接新建文字框，就没有办法通过点击空白处取消选中，容易误触堆出一堆空文字框。本计划采用更安全、也更符合"简单编辑"定位的方案：**新建文字/插入图片只通过工具栏按钮触发，点击画布空白处的行为是"取消当前选中"，不新建任何内容。**

---

## File Structure

- **Modify** `report-store.js` — 加 `slides` 字段（每用户 JSON 里新增一个数组，跟现有 `daily`/`weimeng` 平级）+ `slidesSave()` 方法 + 内部 `sanitizeSlides()`/`sanitizeElement()` 校验辅助函数。
- **Create** `report-store.test.js` — 沿用 `materialcheck.test.js` 的手写测试风格，覆盖 `slidesSave`/`summary` 的读写和校验逻辑。
- **Modify** `server.js` — 新增 `POST /api/reports/personal/slides/save` 路由。
- **Modify** `public/index.html` — 页签条加"+新建页面"按钮和自定义页页签的动态挂载点；加自定义页宿主容器 `#rpt-page-custom`；加删除页面的二次确认弹层；加 `<script src="/report-slides.js">`。
- **Modify** `public/styles.css` — 页签条新增按钮的样式 + 画布/元素/工具栏/把手的全部样式（随各任务增量添加，跟对应 JS 一起改，方便对照）。
- **Modify** `public/report.js` — 动态分页机制（`switchPage` 支持 N 页而不是硬编码 2）、新建/删除页面 UI 接线、放映模式钩子、键盘翻页边界。
- **Create** `public/report-slides.js` — 自定义空白页的画布编辑器模块：数据模型、渲染（编辑态 + 放映只读态）、拖拽移动/缩放、文字/图片元素、富文本工具栏、层级、自动保存。跟 `report.js` 的关系类比 `preview3d-scene.js` 之于 `preview3d.js`——是被动态调用的子模块，不在 `core.js` 的顶层 tab 列表（`MODULES`）里注册。

---

### Task 1: `report-store.js` — 数据层：`slides` 字段 + 校验 + 保存

**Files:**
- Modify: `report-store.js`
- Test: `report-store.test.js`

**Interfaces:**
- Consumes: 无新依赖，沿用文件已有的 `num()` 辅助函数（`Number(String(v ?? '').replace(/[^\d.\-]/g, ''))`，容错转数字）。
- Produces:
  - `ReportStore.prototype.summary(userId) -> Promise<{ daily: Array, weimeng: Array, slides: Array }>`（在原有基础上多返回一个 `slides` 字段）。
  - `ReportStore.prototype.slidesSave(userId, input) -> Promise<{ total: number }>`——`input` 必须是数组，否则 `throw new Error('slides 必须是数组')`；数组里每个"页"对象必须有非空 `id`，否则 `throw new Error('页面缺少 id')`；页面内的元素数组会被逐个校验，类型/字段不合法的元素直接丢弃（不报错，不影响其它元素），供 Task 2 的路由调用。

- [ ] **Step 1: 改 `_load`/`_save`，加 `slides` 字段**

在 `report-store.js` 的 `class ReportStore` 里，把 `_load` 方法（现在第 95-103 行）改成：

```js
  async _load(userId) {
    try {
      const s = JSON.parse(await fsp.readFile(this.file(userId), 'utf8'));
      return {
        daily: Array.isArray(s.daily) ? s.daily : [],
        weimeng: Array.isArray(s.weimeng) ? s.weimeng : [],
        slides: Array.isArray(s.slides) ? s.slides : []
      };
    } catch { return { daily: [], weimeng: [], slides: [] }; }
  }
```

`_save` 不用改——它本来就是把整个 `data` 对象 `JSON.stringify` 落盘，`slides` 字段会跟着一起写进去。

- [ ] **Step 2: 加校验辅助函数和 `slidesSave` 方法**

在 `report-store.js` 里，`class ReportStore { ... }` 定义**之前**（紧跟在已有的 `const num = ...`、`normDate`、`WEIMENG_METRICS` 等模块级辅助定义之后，`recordsFrom` 函数之后即可）加：

```js
const SLIDE_ELEMENT_TYPES = new Set(['text', 'image']);
const TEXT_ALIGNS = new Set(['left', 'center', 'right']);
const MAX_SLIDE_TEXT_LEN = 4000;

/** 单个元素校验：字段/类型不对就整个丢弃（返回 null），不报错——
 *  一个自定义页里出问题的元素不该拖累同页其它正常元素保存失败。 */
function sanitizeElement(el) {
  if (!el || typeof el !== 'object') return null;
  if (!SLIDE_ELEMENT_TYPES.has(el.type)) return null;
  const id = String(el.id || '').trim();
  if (!id) return null;
  const x = num(el.x), y = num(el.y), w = num(el.w), h = num(el.h), z = num(el.z);
  if (w <= 0 || h <= 0) return null;
  const base = { id, type: el.type, x, y, w, h, z };

  if (el.type === 'text') {
    return {
      ...base,
      text: String(el.text ?? '').slice(0, MAX_SLIDE_TEXT_LEN),
      fontSize: num(el.fontSize) || 28,
      color: el.color ? String(el.color).slice(0, 32) : null,
      bold: !!el.bold,
      italic: !!el.italic,
      align: TEXT_ALIGNS.has(el.align) ? el.align : 'left'
    };
  }
  // image：url 必须是本站 /uploads/ 下的相对路径，不接受外链，
  // 跟 A.uploadImage() 的产出格式对齐，顺手防止拿这个字段塞任意外部 URL。
  const url = String(el.url || '');
  if (!url.startsWith('/uploads/')) return null;
  return { ...base, url, naturalW: num(el.naturalW) || w, naturalH: num(el.naturalH) || h };
}

/** 整份 slides 校验：顶层必须是数组，每页必须有 id，元素级别的问题
 *  见 sanitizeElement——单个元素坏了不影响整页整份数据保存。 */
function sanitizeSlides(input) {
  if (!Array.isArray(input)) throw new Error('slides 必须是数组');
  return input.map((page) => {
    const id = String((page && page.id) || '').trim();
    if (!id) throw new Error('页面缺少 id');
    const elements = Array.isArray(page && page.elements)
      ? page.elements.map(sanitizeElement).filter(Boolean)
      : [];
    return { id, elements };
  });
}
```

然后在 `class ReportStore { ... }` 内部，紧跟在已有的 `weimengSave` 方法（现在第 133-153 行）后面加：

```js
  /** 自定义空白页：单用户私有数据，不需要三方合并，前端 debounce 后
   *  整份数组覆盖保存就够——这里的"整份覆盖"就是删除页面的实现方式，
   *  传一份少了某页的数组进来，那一页就没了。 */
  async slidesSave(userId, input) {
    const slides = sanitizeSlides(input);
    const data = await this._load(userId);
    data.slides = slides;
    await this._save(userId, data);
    return { total: slides.length };
  }
```

- [ ] **Step 3: 写 `report-store.test.js`**

在仓库根目录（`report-store.js` 同级）新建 `report-store.test.js`：

```js
const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { ReportStore } = require('./report-store.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '-', e.message); }
};
const tAsync = async (name, fn) => {
  try { await fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '-', e.message); }
};

async function freshStore() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rs-test-'));
  return new ReportStore(dir);
}

async function run() {
  await tAsync('summary() 在没有任何数据时返回空 slides 数组', async () => {
    const store = await freshStore();
    const s = await store.summary('u1');
    assert.deepStrictEqual(s.slides, []);
  });

  await tAsync('slidesSave() 保存后 summary() 能读回同样的页面', async () => {
    const store = await freshStore();
    const slides = [{
      id: 'pg_1',
      elements: [{ id: 'el_1', type: 'text', x: 10, y: 20, w: 100, h: 30, z: 1, text: '你好', fontSize: 28, color: null, bold: false, italic: false, align: 'left' }]
    }];
    const result = await store.slidesSave('u1', slides);
    assert.strictEqual(result.total, 1);
    const s = await store.summary('u1');
    assert.strictEqual(s.slides.length, 1);
    assert.strictEqual(s.slides[0].elements[0].text, '你好');
  });

  await tAsync('slidesSave() 是整份覆盖——传更短的数组会真的删掉多余的页', async () => {
    const store = await freshStore();
    await store.slidesSave('u1', [{ id: 'pg_1', elements: [] }, { id: 'pg_2', elements: [] }]);
    await store.slidesSave('u1', [{ id: 'pg_1', elements: [] }]);
    const s = await store.summary('u1');
    assert.strictEqual(s.slides.length, 1);
  });

  await tAsync('slidesSave() 输入不是数组时抛出错误', async () => {
    const store = await freshStore();
    await assert.rejects(store.slidesSave('u1', { not: 'an array' }), /数组/);
  });

  await tAsync('slidesSave() 页面缺少 id 时抛出错误', async () => {
    const store = await freshStore();
    await assert.rejects(store.slidesSave('u1', [{ elements: [] }]), /id/);
  });

  await tAsync('slidesSave() 丢弃类型不合法/URL 不合法的元素，不影响其它合法元素', async () => {
    const store = await freshStore();
    const slides = [{
      id: 'pg_1',
      elements: [
        { id: 'el_1', type: 'text', x: 0, y: 0, w: 100, h: 30, z: 1, text: 'ok' },
        { id: 'el_2', type: 'video', x: 0, y: 0, w: 100, h: 30, z: 1 },
        { id: 'el_3', type: 'image', x: 0, y: 0, w: 10, h: 10, z: 1, url: 'https://evil.example/x.png' }
      ]
    }];
    await store.slidesSave('u1', slides);
    const s = await store.summary('u1');
    assert.strictEqual(s.slides[0].elements.length, 1);
    assert.strictEqual(s.slides[0].elements[0].id, 'el_1');
  });

  await tAsync('slidesSave() 文字内容超长时会截断到 4000 字', async () => {
    const store = await freshStore();
    const longText = 'x'.repeat(5000);
    await store.slidesSave('u1', [{ id: 'pg_1', elements: [{ id: 'el_1', type: 'text', x: 0, y: 0, w: 100, h: 30, z: 1, text: longText }] }]);
    const s = await store.summary('u1');
    assert.strictEqual(s.slides[0].elements[0].text.length, 4000);
  });

  await tAsync('slidesSave() 不影响已有的 daily/weimeng 数据', async () => {
    const store = await freshStore();
    await store.weimengSave('u1', {
      weekStart: '2026-07-20', pageviews: 100, visitors: 50, visits: 60, avgDepth: 2,
      clickUsers: 10, clicks: 20, avgStay: 30, bounceRate: 5, channels: {}
    });
    await store.slidesSave('u1', [{ id: 'pg_1', elements: [] }]);
    const s = await store.summary('u1');
    assert.strictEqual(s.weimeng.length, 1);
    assert.strictEqual(s.slides.length, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
```

- [ ] **Step 4: 跑测试确认全部通过**

Run: `cd /root/IQAir-Project/EC-Workbench && node report-store.test.js`
Expected: 8 行 `✓`，最后一行 `8 passed, 0 failed`，进程退出码 0。

- [ ] **Step 5: Commit**

```bash
git add report-store.js report-store.test.js
git commit -m "feat(reports): add slides field and slidesSave to report-store"
```

---

### Task 2: `server.js` — 新增 `POST /api/reports/personal/slides/save` 路由

**Files:**
- Modify: `server.js:651-658`（紧跟在已有的 `weimeng/save` 路由块之后插入）

**Interfaces:**
- Consumes: Task 1 的 `reports.slidesSave(userId, input) -> Promise<{ total: number }>`；已有的 `body(req)`（JSON 解析，默认 `MAX_BODY = 24MB` 上限，足够存文字+图片 URL，不含图片二进制）、`json(res, status, obj)`、`audit(me, action, { detail })`、模块级已存在的 `reports` 实例（`const reports = new ReportStore(REPORTS_DIR);`）。
- Produces: `POST /api/reports/personal/slides/save`，请求体 `{ slides: Array }`，成功返回 `200 { total: number }`，失败（`slides` 不是数组 / 页面缺 id）返回 `400 { error: string }`，供 Task 4（`report-slides.js` 的自动保存引擎）调用。

- [ ] **Step 1: 加路由**

在 `server.js` 里，紧跟在现有 `/api/reports/personal/weimeng/save` 路由块后面插入：

```js
    if (p === '/api/reports/personal/slides/save' && req.method === 'POST') {
      const input = await body(req);
      let result;
      try { result = await reports.slidesSave(me.id, input.slides); }
      catch (e) { return json(res, 400, { error: e.message }); }
      audit(me, 'reports.slides.save', { detail: [`个人报告：自定义页已保存（共 ${result.total} 页）`] });
      return json(res, 200, result);
    }
```

（这个块要放在 `/api/reports/personal/weimeng/save` 的 `if (...) { ... }` 结束 `}` 之后、下一个 `if (p === '/api/materialcheck/libraries' ...)` 之前。）

- [ ] **Step 2: 手动验证**

Run: `cd /root/IQAir-Project/EC-Workbench && node server.js` （另开一个终端）

登录拿到 session cookie 后（浏览器登录后从 devtools 复制 `Cookie` 头），跑：

```bash
curl -i -b "wb_session=<替换成登录后的 cookie 值>" \
  -X POST http://localhost:8080/api/reports/personal/slides/save \
  -H "Content-Type: application/json" \
  -d '{"slides":[{"id":"pg_1","elements":[]}]}'
```

Expected: `HTTP/1.1 200`，响应体 `{"total":1}`。再跑一次 `curl ... -d '{"slides":"not-an-array"}'`，Expected: `HTTP/1.1 400`，响应体里 `error` 包含"数组"。不带 cookie 跑同一个请求应该拿到 `401`（沿用现有 `/api/` 鉴权中间件）。

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(reports): add slides save route"
```

---

### Task 3: `public/index.html` + `public/styles.css` — 静态骨架

**Files:**
- Modify: `public/index.html`（页签条、自定义页宿主容器插入点、删除确认弹层插入点、新脚本标签）
- Modify: `public/styles.css`（在 `.rpt-page-switch` 相关规则附近追加）

**Interfaces:**
- Consumes: 已有的 `.sheet-mask`/`.sheet`/`.sheet-head`/`.sheet-body`/`.kill`/`.ghost`/`.ghost.danger` CSS 类（删除确认弹层直接复用，不需要新样式）。
- Produces: DOM 挂载点 `#rpt-page-tabs-extra`（自定义页页签的动态渲染容器）、`#rpt-page-add`（新建页面按钮）、`#rpt-page-custom`（自定义页画布宿主容器）、`#rpt-page-del-mask`/`#rpt-page-del-close`/`#rpt-page-del-cancel`/`#rpt-page-del-confirm`（删除确认弹层及其按钮）——这些 id 是 Task 5（`report.js`）要接线的目标。

- [ ] **Step 1: 页签条加动态挂载点和"+新建页面"按钮**

把 `public/index.html` 里：

```html
        <div class="rpt-page-switch" id="rpt-page-switch">
          <button data-page="1" class="on">第 1 页 · 生意参谋</button>
          <button data-page="2">第 2 页 · 微盟数据</button>
        </div>
```

改成：

```html
        <div class="rpt-page-switch" id="rpt-page-switch">
          <button data-page="1" class="on">第 1 页 · 生意参谋</button>
          <button data-page="2">第 2 页 · 微盟数据</button>
          <div class="rpt-page-tabs-extra" id="rpt-page-tabs-extra"></div>
          <button class="rpt-page-add" id="rpt-page-add" type="button">+ 新建页面</button>
        </div>
```

- [ ] **Step 2: 加自定义页宿主容器**

在 `#rpt-page-2` 那个 `<div class="rpt-page" id="rpt-page-2" hidden>...</div>` 结束标签之后、`.rv-scroll#rpt-personal-view` 结束标签之前插入：

```html
        <div class="rpt-page rpt-page-custom" id="rpt-page-custom" hidden></div>
```

- [ ] **Step 3: 加删除页面的二次确认弹层**

在 `#rpt-wm-mask` 的结束 `</div>` 之后、`<button class="rpt-exit-present" ...>` 之前插入：

```html
<div class="sheet-mask" id="rpt-page-del-mask" hidden>
  <div class="sheet" style="width:min(380px,100%)">
    <div class="sheet-head">
      <h2>删除页面</h2>
      <button class="kill" id="rpt-page-del-close" aria-label="关闭">✕</button>
    </div>
    <div class="sheet-body">
      <p class="rail-hint">删除后这一页的内容不能恢复，确定要删除吗？</p>
      <div style="display:flex;gap:10px;margin-top:16px;justify-content:flex-end">
        <button class="ghost" id="rpt-page-del-cancel">取消</button>
        <button class="ghost danger" id="rpt-page-del-confirm">删除</button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 4: 加新脚本标签**

`<script src="/report.js"></script>` 之前插入：

```html
<script src="/report-slides.js"></script>
```

（`report-slides.js` 还没建文件，这一步先加标签，Task 4 建文件之前浏览器会 404，不影响其它脚本正常执行——`<script>` 加载失败只报控制台错误，不会阻塞后续脚本；Task 4 结束后这个 404 就没有了。）

- [ ] **Step 5: CSS——页签条新按钮的样式**

在 `public/styles.css` 里找到 `.rpt-page-switch button.on { background: var(--mint-dim); color: var(--mint); }` 附近，紧跟着加：

```css
/* .rpt-page-tabs-extra 用 display:contents 让里面动态插入的自定义页
   按钮在视觉上直接是 .rpt-page-switch 的 flex 子项，不会因为多包了
   一层 div 打乱页签条的 flex 布局。 */
.rpt-page-tabs-extra { display: contents; }
.rpt-page-add { border-style: dashed; }
.rpt-page-del {
  margin-left: 8px; opacity: 0.6; font-size: 11px; padding: 0 2px;
  transition: opacity var(--fast), color var(--fast);
}
.rpt-page-del:hover { opacity: 1; color: #ff9a9a; }
```

- [ ] **Step 6: 手动验证**

Run: `node server.js`，浏览器打开 `/login.html` 登录，进「报告管理 → 个人报告」。

Expected: 页签条右侧出现一个虚线边框的「+ 新建页面」按钮（点击目前还没有反应，Task 5 才接线）；打开浏览器 devtools Console 应该能看到 `report-slides.js` 的 404（因为文件还没建，Task 4 会解决）；页面其余部分（第 1、2 页数据展示、放映模式）跟改动前完全一样，没有布局错位。

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/styles.css
git commit -m "feat(reports): add static scaffolding for custom slide pages"
```

---

### Task 4: `public/report-slides.js`（新建）— 模块骨架 + 自动保存引擎 + 空白画布渲染

**Files:**
- Create: `public/report-slides.js`
- Modify: `public/styles.css`（画布/工具栏基础样式）

**Interfaces:**
- Consumes: `A`（跟 `Report.init(api)` 拿到的是同一个对象，`report.js` 会把它转手传给 `ReportSlides.init(A)`）里的 `A.uid(prefix) -> string`、`A.clone(obj) -> obj`（JSON 深拷贝）、`A.guard(response) -> response`（401 统一处理）、`A.toast(msg, kind?)`。
- Produces（这个任务先把骨架和"空画布"跑通，元素相关能力见 Task 6-8）：
  - `ReportSlides.init(api)`
  - `ReportSlides.setPages(slidesArray)`——用服务端返回的 `data.slides` 灌入模块内部状态，`report.js` 的 `refresh()` 调用。
  - `ReportSlides.pageCount() -> number`
  - `ReportSlides.addPage() -> number`（新页在数组末尾追加，返回新页的 0-based 下标，同时触发自动保存）
  - `ReportSlides.deletePage(index)`（触发自动保存）
  - `ReportSlides.mountPage(container, index)`（把下标为 `index` 的自定义页渲染进 `container`）
  - `ReportSlides.unmountPage()`（离开当前自定义页前必须调用，清理 ResizeObserver 等）
  - `ReportSlides.setPresenting(bool)`（供放映模式钩子调用，切换只读/可编辑渲染）

- [ ] **Step 1: 建文件，写模块骨架和自动保存引擎**

新建 `public/report-slides.js`：

```js
/* ═══════════════════════════════════════════════════════════
   report-slides.js — 个人报告·自定义空白页（类 PPT 画布编辑器）

   固定 1280×720 逻辑画布，transform: scale() 整体缩放去适配容器；
   元素位置/尺寸都是这个坐标系里的像素值。单用户私有数据，不需要
   matrix/compare 那套三方合并，改动 debounce 后整份 slides 数组
   覆盖保存（report-store.js 的 slidesSave）。

   跟 report.js 的关系类比 preview3d-scene.js 之于 preview3d.js——
   是被 report.js 动态调用的子模块，不在 core.js 的顶层 tab 列表里，
   不需要 preview3d-scene.js 那套 p3dscene-ready 事件桥接（这里两个
   脚本都是经典脚本，document 顺序保证 report.js 执行时
   ReportSlides 已经定义好）。
   ═══════════════════════════════════════════════════════════ */
const ReportSlides = (() => {
  const CANVAS_W = 1280, CANVAS_H = 720;
  const DEFAULT_FONT_SIZE = 28;

  let A;
  let pages = [];               // [{ id, elements: [...] }]
  let hostEl = null;            // report.js 传进来的容器（#rpt-page-custom）
  let mountedIndex = -1;        // 当前挂载的是 pages 里的第几页
  let presenting = false;
  let selectedId = null;
  let editingId = null;         // 正在 contenteditable 编辑中的文字元素 id

  let canvasEl = null, toolbarEl = null, canvasRO = null;
  let saveTimer = null, saveInFlight = false, saveAgainNeeded = false;

  /* ── 自动保存：跟 matrix/compare 的 debounce 节奏一致（700ms），
     但这是单用户私有数据，不需要 rev/base 三方合并，失败重试一次
     就够，不用维护复杂的冲突态。 ── */
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 700);
  }

  async function flushSave() {
    if (saveInFlight) { saveAgainNeeded = true; return; }
    saveInFlight = true;
    const payload = A.clone(pages);
    try {
      const r = A.guard(await fetch('/api/reports/personal/slides/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slides: payload })
      }));
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || '保存失败');
    } catch (e) {
      if (e.expired) return;
      A.toast('自定义页保存失败：' + e.message + '，会自动重试', 'bad');
      saveAgainNeeded = true;
    } finally {
      saveInFlight = false;
      if (saveAgainNeeded) { saveAgainNeeded = false; scheduleSave(); }
    }
  }

  /* ── 页面管理 ───────────────────────────────────────── */
  function currentPage() { return mountedIndex >= 0 ? pages[mountedIndex] : null; }

  function init(api) { A = api; }

  function setPages(arr) { pages = Array.isArray(arr) ? A.clone(arr) : []; }

  function pageCount() { return pages.length; }

  function addPage() {
    pages.push({ id: A.uid('pg_'), elements: [] });
    scheduleSave();
    return pages.length - 1;
  }

  function deletePage(idx) {
    if (idx < 0 || idx >= pages.length) return;
    pages.splice(idx, 1);
    scheduleSave();
  }

  function mountPage(container, idx) {
    hostEl = container;
    mountedIndex = idx;
    selectedId = null;
    editingId = null;
    renderCanvas();
  }

  function unmountPage() {
    if (canvasRO) { canvasRO.disconnect(); canvasRO = null; }
    hostEl = null; mountedIndex = -1; canvasEl = null; toolbarEl = null;
    selectedId = null; editingId = null;
  }

  function setPresenting(bool) {
    presenting = bool;
    if (hostEl && mountedIndex >= 0) renderCanvas();
  }

  /* ── 渲染：画布外壳（工具栏 + 可缩放视口）── 元素渲染见 Task 6-8 ── */
  function renderShell(container) {
    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'rs-wrap';

    if (!presenting) {
      const toolbar = document.createElement('div');
      toolbar.className = 'rs-toolbar';
      wrap.appendChild(toolbar);
      toolbarEl = toolbar;
    } else {
      toolbarEl = null;
    }

    const viewport = document.createElement('div');
    viewport.className = 'rs-viewport';
    const canvas = document.createElement('div');
    canvas.className = 'rs-canvas';
    viewport.appendChild(canvas);
    wrap.appendChild(viewport);
    container.appendChild(wrap);

    const resize = () => {
      const w = viewport.clientWidth;
      if (!w) return;
      const k = w / CANVAS_W;
      viewport.style.height = Math.round(CANVAS_H * k) + 'px';
      canvas.style.transform = `scale(${k})`;
    };
    if (canvasRO) canvasRO.disconnect();
    canvasRO = new ResizeObserver(resize);
    canvasRO.observe(viewport);
    resize();

    canvasEl = canvas;
  }

  function renderCanvas() {
    if (!hostEl) return;
    renderShell(hostEl);
    // renderElements() 在 Task 6 里补上——这个任务先确保空画布能
    // 正确挂载/缩放/卸载，元素渲染是下一步。
  }

  return { init, setPages, pageCount, addPage, deletePage, mountPage, unmountPage, setPresenting };
})();
```

- [ ] **Step 2: CSS——画布外壳基础样式**

在 `public/styles.css` 末尾追加一个新分区：

```css
/* ═══ 报告管理 · 自定义空白页（画布编辑器） ═══════════════════ */
.rpt-page-custom { display: flex; flex-direction: column; }
.rs-wrap { display: flex; flex-direction: column; gap: 12px; }
.rs-viewport {
  position: relative; width: 100%; overflow: hidden;
  border-radius: 12px; border: 1px solid var(--line); background: var(--surface-2);
}
.rs-canvas {
  position: absolute; top: 0; left: 0; width: 1280px; height: 720px;
  transform-origin: top left; background: var(--surface); color: var(--text);
  overflow: hidden;
}
body.rpt-presenting .rs-viewport { border: 0; border-radius: 0; }
.rs-toolbar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 12px;
  background: linear-gradient(180deg, var(--surface), var(--surface-2));
  border: 1px solid var(--line);
}
.rs-toolbar button {
  border: 1px solid var(--line); background: var(--overlay-weak); color: var(--dim);
  padding: 7px 13px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600;
  transition: all var(--fast);
}
.rs-toolbar button:hover:not(:disabled) { color: var(--text); background: var(--overlay-strong); border-color: #33456a; }
.rs-toolbar button:disabled { opacity: 0.4; cursor: not-allowed; }
.rs-toolbar button.on { background: var(--mint-dim); color: var(--mint); border-color: transparent; }
```

- [ ] **Step 3: 手动验证（浏览器 devtools 控制台，UI 还没接线，先验证模块本身）**

Run: `node server.js`，浏览器打开「报告管理 → 个人报告」，打开 devtools Console，依次执行：

```js
ReportSlides.pageCount()          // 期望 0（还没有自定义页）
ReportSlides.addPage()            // 期望返回 0
document.querySelector('#rpt-page-custom').hidden = false
ReportSlides.mountPage(document.querySelector('#rpt-page-custom'), 0)
```

Expected：`#rpt-page-custom` 位置出现一块深色（跟随当前主题）的矩形画布，带圆角和边框，宽度撑满容器、高度按 16:9 自动跟着算，上方有一条空的工具栏（还没有按钮，Task 6 才加）。拖动浏览器窗口改变宽度，画布应该跟着等比缩放，不会变形也不会溢出容器。

再执行 `ReportSlides.unmountPage()`，Expected：画布消失，`#rpt-page-custom` 变回空。刷新页面后重新执行以上步骤，`ReportSlides.pageCount()` 应该还是 `0`——因为这一步只是本地内存操作，没有经过 `report.js` 的 `refresh()`/`setPages()` 流程，Task 5 接上 UI 之后才会有真正的持久化闭环验证。

- [ ] **Step 4: Commit**

```bash
git add public/report-slides.js public/styles.css public/index.html
git commit -m "feat(reports): scaffold ReportSlides module with autosave engine and blank canvas render"
```

---

### Task 5: `public/report.js` — 动态分页、新建/删除页面 UI、放映模式钩子

**Files:**
- Modify: `public/report.js`

**Interfaces:**
- Consumes: Task 4 产出的 `ReportSlides.{init, setPages, pageCount, addPage, deletePage, mountPage, unmountPage, setPresenting}`。
- Produces: `report.js` 内部的 `totalPages()`、`renderPageSwitch()`、`switchPage(n)`（改造为支持 N 页）、删除页面的确认流程——这些是内部实现细节，不对外暴露新接口，但后续 Task 6-8 往 `ReportSlides` 里加元素能力时不需要再碰这个文件。

- [ ] **Step 1: `refresh()` 里灌入 slides 数据 + 渲染页签**

把 `report.js` 里现有的 `refresh()`：

```js
  async function refresh() {
    try { data = await call('/api/reports/personal/summary'); }
    catch { data = null; }
    render();
  }
```

改成：

```js
  async function refresh() {
    try { data = await call('/api/reports/personal/summary'); }
    catch { data = null; }
    ReportSlides.setPages(data ? data.slides : []);
    renderPageSwitch();
    render();
  }
```

- [ ] **Step 2: 加 `totalPages()`/`renderPageSwitch()`/删除页面流程**

在 `report.js` 里，紧跟在现有的 `/* ── 页面切换：报告分两页... ── */` 注释块之前插入：

```js
  /* ── 自定义页页签：动态渲染第 3 页及之后，跟静态的第 1/2 页拼在
     一起，页签的开关状态统一用 [data-page] 描述符管理 ── */
  function totalPages() { return 2 + ReportSlides.pageCount(); }

  function renderPageSwitch() {
    const extra = A.$('#rpt-page-tabs-extra');
    extra.innerHTML = '';
    const n = ReportSlides.pageCount();
    for (let i = 0; i < n; i++) {
      const idx = 3 + i;
      const btn = document.createElement('button');
      btn.dataset.page = String(idx);
      btn.textContent = `第 ${idx} 页`;
      btn.onclick = () => switchPage(idx);
      const del = document.createElement('span');
      del.className = 'rpt-page-del';
      del.title = '删除该页';
      del.textContent = '✕';
      del.onclick = (e) => { e.stopPropagation(); openDeletePage(idx); };
      btn.appendChild(del);
      extra.appendChild(btn);
    }
    A.$$('#rpt-page-switch button[data-page]').forEach((b) => b.classList.toggle('on', Number(b.dataset.page) === page));
  }

  let deleteTarget = null;
  function openDeletePage(n) { deleteTarget = n; A.$('#rpt-page-del-mask').hidden = false; }
  function closeDeletePage() { A.$('#rpt-page-del-mask').hidden = true; deleteTarget = null; }
  /** 删除后统一跳回第 1 页，不试图保留原来的浏览位置——自定义页
   *  不支持重排序，但删除会让后面页面的下标整体前移，与其去算"删的
   *  是不是我正在看的这页、要不要跟着挪一位"，不如固定跳回第 1 页，
   *  简单也不会有算错下标的风险。 */
  function confirmDeletePage() {
    if (deleteTarget == null) return;
    const removedIdx = deleteTarget - 3;
    if (page > 2) ReportSlides.unmountPage();
    ReportSlides.deletePage(removedIdx);
    closeDeletePage();
    renderPageSwitch();
    switchPage(1);
  }
```

- [ ] **Step 3: 改造 `switchPage(n)`**

把现有的 `switchPage` 函数：

```js
  function switchPage(n) {
    page = n;
    A.$$('#rpt-page-switch button').forEach((b) => b.classList.toggle('on', Number(b.dataset.page) === n));
    A.$('#rpt-page-1').hidden = n !== 1;
    A.$('#rpt-page-2').hidden = n !== 2;
    if (n === 1 && chart) requestAnimationFrame(() => chart.resize());
  }
```

改成：

```js
  function switchPage(n) {
    const prev = page;
    if (prev > 2 && prev !== n) ReportSlides.unmountPage();
    page = n;
    A.$$('#rpt-page-switch button[data-page]').forEach((b) => b.classList.toggle('on', Number(b.dataset.page) === n));
    A.$('#rpt-page-1').hidden = n !== 1;
    A.$('#rpt-page-2').hidden = n !== 2;
    A.$('#rpt-page-custom').hidden = n <= 2;
    if (n === 1 && chart) requestAnimationFrame(() => chart.resize());
    if (n > 2 && n !== prev) ReportSlides.mountPage(A.$('#rpt-page-custom'), n - 3);
  }
```

- [ ] **Step 4: 放映模式钩子 + 键盘翻页边界动态化**

把 `enterPresent` 里的 `presenting = true;` 那一行下面加一行 `ReportSlides.setPresenting(true);`；`exitPresent` 里的 `presenting = false;` 下面加一行 `ReportSlides.setPresenting(false);`。改完后两个函数长这样：

```js
  function enterPresent() {
    presenting = true;
    ReportSlides.setPresenting(true);
    document.body.classList.add('rpt-presenting');
    A.$('#rpt-present-btn').textContent = '■ 退出放映';
    A.$('#rpt-exit-present').hidden = false;
    const fs = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
    if (fs) {
      fs.call(document.documentElement)?.catch(() => {
        A.toast('浏览器拒绝了全屏请求，只切到放映排版——按 F11 可以手动全屏', 'bad');
      });
    } else {
      A.toast('这个浏览器不支持全屏 API，只切到放映排版——按 F11 可以手动全屏', 'bad');
    }
    if (chart) requestAnimationFrame(() => chart.resize());
  }

  function exitPresent() {
    presenting = false;
    ReportSlides.setPresenting(false);
    document.body.classList.remove('rpt-presenting');
    A.$('#rpt-present-btn').textContent = '▶ 放映模式';
    A.$('#rpt-exit-present').hidden = true;
    if (document.fullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document).catch?.(() => {});
    if (chart) requestAnimationFrame(() => chart.resize());
  }
```

然后把 `init(api)` 里现有的键盘翻页监听：

```js
    document.addEventListener('keydown', (e) => {
      if (!presenting) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') switchPage(2);
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') switchPage(1);
    });
```

改成：

```js
    document.addEventListener('keydown', (e) => {
      if (!presenting) return;
      const total = totalPages();
      if ((e.key === 'ArrowRight' || e.key === 'PageDown') && page < total) switchPage(page + 1);
      if ((e.key === 'ArrowLeft' || e.key === 'PageUp') && page > 1) switchPage(page - 1);
    });
```

- [ ] **Step 5: 接线新建/删除页面按钮 + 初始化 `ReportSlides`**

在 `init(api)` 里，把现有这行：

```js
    A.$$('#rpt-page-switch button').forEach((b) => (b.onclick = () => switchPage(Number(b.dataset.page))));
```

改成（把选择器改窄到 `[data-page]`，避免以后不小心选到"+新建页面"按钮）：

```js
    A.$$('#rpt-page-switch button[data-page]').forEach((b) => (b.onclick = () => switchPage(Number(b.dataset.page))));
```

再往下几行加（放在 `A.$('#rpt-exit-present').onclick = exitPresent;` 之后即可）：

```js
    ReportSlides.init(A);
    A.$('#rpt-page-add').onclick = () => {
      const idx = ReportSlides.addPage();
      renderPageSwitch();
      switchPage(3 + idx);
    };
    A.$('#rpt-page-del-close').onclick = closeDeletePage;
    A.$('#rpt-page-del-cancel').onclick = closeDeletePage;
    A.$('#rpt-page-del-confirm').onclick = confirmDeletePage;
    A.$('#rpt-page-del-mask').addEventListener('click', (e) => { if (e.target.id === 'rpt-page-del-mask') closeDeletePage(); });
```

- [ ] **Step 6: 手动验证**

Run: `node server.js`，浏览器登录进「报告管理 → 个人报告」。

1. 点「+ 新建页面」——Expected：页签条出现「第 3 页」按钮并自动带 `.on` 高亮，下方出现空白深色画布（画布样式来自 Task 4）。刷新页面——Expected：页签条依然有「第 3 页」（说明自动保存 + `summary` 回读链路通了），会自动落在第 1 页（因为 `page` 变量初始值是 1，刷新后没有记住上次停留页，这是预期行为，不需要额外做"记住页码"）。
2. 再点两次「+ 新建页面」——Expected：出现「第 4 页」「第 5 页」，点击可以互相切换，页签高亮跟着走。
3. 鼠标 hover 到「第 4 页」——Expected：出现一个淡淡的 ✕，点击后弹出"删除页面"确认弹层；点「取消」弹层关闭、页面数不变；点「删除」——Expected：弹层关闭，自动跳回第 1 页，页签条只剩「第 3 页」「第 5 页」但重新编号显示为「第 3 页」「第 4 页」（因为编号是按数组下标动态算的，不是存死的）。
4. 点「▶ 放映模式」进全屏，用左右方向键翻页——Expected：能从第 1 页一路翻到最后一个自定义页，翻到底之后再按右方向键没反应（不会越界报错）；按 Esc 或点右上角退出放映，回到编辑视图。

- [ ] **Step 7: Commit**

```bash
git add public/report.js
git commit -m "feat(reports): wire dynamic paging, add/delete page UI and presenting-mode hook for custom slides"
```

---

### Task 6: `public/report-slides.js` — 通用元素引擎：新建文字 + 选中 + 拖拽移动 + 删除 + 层级

**Files:**
- Modify: `public/report-slides.js`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: Task 4 已有的模块内部状态（`pages`/`mountedIndex`/`canvasEl`/`toolbarEl`/`selectedId`/`scheduleSave`/`currentPage`）。
- Produces: 元素数据结构里 `text` 类型的最小可用版本（`{ id, type:'text', x, y, w, h, z, text, fontSize, color, bold, italic, align }`，字段跟 Task 1 的 `sanitizeElement` 完全对齐）、`renderElements()`（后续 Task 7/8 会在这个函数基础上继续加 image 类型和把手，不用重写）。这个任务先不做双击进入编辑（Task 7 做），文字内容展示为静态只读文本，先把"新建-选中-拖拽-删除-层级"这个通用骨架跑通。

- [ ] **Step 1: 补上 `renderElements()`，`renderCanvas()` 里接上**

把 Task 4 里 `renderCanvas()` 函数体的注释占位替换掉：

```js
  function renderCanvas() {
    if (!hostEl) return;
    renderShell(hostEl);
    renderElements();
  }
```

在 `renderShell` 函数后面加：

```js
  /* ── 元素渲染：清空重建，选中态/层级变化后统一走这里，保证 DOM
     跟内存模型一致；正在打字的输入事件不走这条路径（见 Task 7 的
     autoGrowHeight），避免重建 DOM 打断输入法/光标位置。 ── */
  function renderElements() {
    if (!canvasEl) return;
    canvasEl.querySelectorAll('.rs-el').forEach((n) => n.remove());
    const page = currentPage();
    if (!page) { renderToolbar(); return; }
    page.elements.slice().sort((a, b) => a.z - b.z).forEach((el) => canvasEl.appendChild(buildElementNode(el)));
    renderToolbar();
  }

  function buildElementNode(el) {
    const node = document.createElement('div');
    node.className = 'rs-el rs-el-' + el.type + (el.id === selectedId ? ' sel' : '');
    node.dataset.id = el.id;
    node.style.left = el.x + 'px';
    node.style.top = el.y + 'px';
    node.style.width = el.w + 'px';
    node.style.height = el.h + 'px';
    node.style.zIndex = String(el.z);

    if (el.type === 'text') {
      const box = document.createElement('div');
      box.className = 'rs-text';
      box.style.fontSize = (el.fontSize || DEFAULT_FONT_SIZE) + 'px';
      box.style.fontWeight = el.bold ? '700' : '400';
      box.style.fontStyle = el.italic ? 'italic' : 'normal';
      box.style.textAlign = el.align || 'left';
      if (el.color) box.style.color = el.color;
      box.textContent = el.text || '';
      node.appendChild(box);
    }

    if (!presenting) {
      node.addEventListener('pointerdown', (e) => onElementPointerDown(e, el));
    }
    return node;
  }

  /* ── 选中/取消选中：点空白画布取消选中，不新建任何内容——见计划
     开头 Global Constraints 里对"新建入口"歧义的澄清 ── */
  function onCanvasPointerDown(e) {
    if (e.target !== canvasEl) return;
    if (selectedId) { selectedId = null; editingId = null; renderElements(); }
  }

  function onElementPointerDown(e, el) {
    e.stopPropagation();
    if (editingId === el.id) return;
    if (selectedId !== el.id) { selectedId = el.id; editingId = null; renderElements(); }

    const startX = e.clientX, startY = e.clientY;
    const origX = el.x, origY = el.y;
    let moved = false;
    const k = () => canvasEl.getBoundingClientRect().width / CANVAS_W;
    const onMove = (me) => {
      const dx = (me.clientX - startX) / k(), dy = (me.clientY - startY) / k();
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      el.x = origX + dx; el.y = origY + dy;
      const node = canvasEl.querySelector(`.rs-el[data-id="${el.id}"]`);
      if (node) { node.style.left = el.x + 'px'; node.style.top = el.y + 'px'; }
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (moved) scheduleSave();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  /* ── 元素 CRUD + 层级 ── */
  function nextZ(page) { return page.elements.reduce((m, e) => Math.max(m, e.z), 0) + 1; }

  function addTextElement() {
    const page = currentPage();
    if (!page || presenting) return;
    const el = {
      id: A.uid('el_'), type: 'text',
      x: 340, y: 310, w: 600, h: 60, z: nextZ(page),
      text: '', fontSize: DEFAULT_FONT_SIZE, color: null, bold: false, italic: false, align: 'left'
    };
    page.elements.push(el);
    selectedId = el.id;
    scheduleSave();
    renderElements();
  }

  function deleteSelected() {
    const page = currentPage();
    if (!page || !selectedId) return;
    page.elements = page.elements.filter((e) => e.id !== selectedId);
    selectedId = null; editingId = null;
    scheduleSave();
    renderElements();
  }

  function bringToFront() {
    const page = currentPage();
    const el = page && page.elements.find((e) => e.id === selectedId);
    if (!el) return;
    el.z = nextZ(page);
    scheduleSave(); renderElements();
  }

  function sendToBack() {
    const page = currentPage();
    const el = page && page.elements.find((e) => e.id === selectedId);
    if (!el) return;
    el.z = page.elements.reduce((m, e) => Math.min(m, e.z), 0) - 1;
    scheduleSave(); renderElements();
  }

  /* ── 工具栏：图片按钮先占位禁用，Task 8 补上真实实现 ── */
  function mkBtn(label, fn) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.onclick = fn;
    return b;
  }

  function renderToolbar() {
    if (presenting || !toolbarEl) return;
    const page = currentPage();
    const el = page && page.elements.find((e) => e.id === selectedId);
    toolbarEl.innerHTML = '';

    toolbarEl.appendChild(mkBtn('新建文字', addTextElement));
    const imageBtn = mkBtn('插入图片', () => {});
    imageBtn.disabled = true;
    imageBtn.title = '下一步实现';
    toolbarEl.appendChild(imageBtn);

    [mkBtn('置顶', bringToFront), mkBtn('置底', sendToBack), mkBtn('删除', deleteSelected)]
      .forEach((b) => { b.disabled = !el; toolbarEl.appendChild(b); });
  }
```

同时把 `renderShell` 里 `canvasEl = canvas;` 那一行下面加一行，给画布本身接上"点空白取消选中"的监听：

```js
    canvasEl = canvas;
    if (!presenting) canvas.addEventListener('pointerdown', onCanvasPointerDown);
```

- [ ] **Step 2: CSS——元素基础样式**

在 `public/styles.css` 上一步加的 `.rs-toolbar button.on {...}` 规则后面继续加：

```css
.rs-el { position: absolute; cursor: move; box-sizing: border-box; }
.rs-el.sel { outline: 2px solid var(--mint); outline-offset: 2px; }
.rs-text {
  width: 100%; height: 100%; box-sizing: border-box; outline: none;
  white-space: pre-wrap; overflow-wrap: break-word; padding: 2px;
  cursor: text;
}
```

- [ ] **Step 3: 手动验证**

Run: `node server.js`，浏览器登录进「报告管理 → 个人报告」，进任意一个自定义页（没有就先点「+ 新建页面」）。

1. 工具栏出现「新建文字」「插入图片」（灰掉不可点）「置顶」「置底」「删除」五个按钮，后三个初始是禁用状态（没有选中任何元素）。
2. 点「新建文字」——Expected：画布中央附近出现一个带浅绿色描边的空文字框（因为新建后立即选中），「置顶」「置底」「删除」三个按钮变成可点。
3. 鼠标按住文字框拖动——Expected：跟手移动，松开后位置定住；刷新页面后位置应该还在（自动保存生效）。
4. 点画布空白处——Expected：文字框描边消失（取消选中），三个按钮重新变灰，**不会**新建出新的文字框（对应 Global Constraints 里"点空白不新建"的澄清）。
5. 重新点选文字框，点「删除」——Expected：文字框消失，工具栏三个按钮重新变灰。
6. 新建两个文字框重叠放在一起，选中下面那个点「置顶」——Expected：它盖到另一个上面；点「置底」再验证反过来。

- [ ] **Step 4: Commit**

```bash
git add public/report-slides.js public/styles.css
git commit -m "feat(reports): add generic element engine — create/select/drag/delete text, layering"
```

---

### Task 7: `public/report-slides.js` — 文字框进阶：双击编辑 + 宽度调整（高度自适应）+ 富文本工具栏

**Files:**
- Modify: `public/report-slides.js`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: Task 6 的 `buildElementNode`/`renderToolbar`/`onElementPointerDown`/`renderElements`。
- Produces: 文字框内容可编辑（`el.text` 双向同步）、宽度可拖拽调整且高度自动跟随内容、工具栏新增字号/颜色/加粗/斜体/对齐控件，改完后这些控件的当前值要跟选中元素同步显示。

- [ ] **Step 1: 双击进入编辑态**

在 `buildElementNode` 里，`if (el.type === 'text') { ... }` 块内，把原来简单的：

```js
    if (el.type === 'text') {
      const box = document.createElement('div');
      box.className = 'rs-text';
      box.style.fontSize = (el.fontSize || DEFAULT_FONT_SIZE) + 'px';
      box.style.fontWeight = el.bold ? '700' : '400';
      box.style.fontStyle = el.italic ? 'italic' : 'normal';
      box.style.textAlign = el.align || 'left';
      if (el.color) box.style.color = el.color;
      box.textContent = el.text || '';
      node.appendChild(box);
    }
```

改成：

```js
    if (el.type === 'text') {
      const box = document.createElement('div');
      box.className = 'rs-text';
      box.style.fontSize = (el.fontSize || DEFAULT_FONT_SIZE) + 'px';
      box.style.fontWeight = el.bold ? '700' : '400';
      box.style.fontStyle = el.italic ? 'italic' : 'normal';
      box.style.textAlign = el.align || 'left';
      if (el.color) box.style.color = el.color;
      box.textContent = el.text || '';

      if (!presenting) {
        node.addEventListener('dblclick', (e) => { e.stopPropagation(); enterTextEdit(el); });
        if (el.id === editingId) {
          box.contentEditable = 'true';
          box.addEventListener('input', () => {
            el.text = box.textContent;
            autoGrowHeight(box, el);
            scheduleSave();
          });
          box.addEventListener('blur', () => commitTextEdit(el, box));
          box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); box.blur(); } });
        }
      }
      node.appendChild(box);
    }
```

在 `buildElementNode` 函数后面（`onCanvasPointerDown` 之前）加：

```js
  function enterTextEdit(el) {
    if (presenting) return;
    selectedId = el.id;
    editingId = el.id;
    renderElements();
    const box = canvasEl.querySelector(`.rs-el[data-id="${el.id}"] .rs-text`);
    if (!box) return;
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function commitTextEdit(el, box) {
    el.text = box.textContent;
    box.removeAttribute('contenteditable');
    if (editingId === el.id) editingId = null;
    scheduleSave();
    renderElements();
  }

  /** 高度随内容自适应：改宽度或打字都会调它，画布坐标系里的
   *  scrollHeight 不受 transform: scale() 影响（transform 只改视觉
   *  呈现，不改变元素自身的布局尺寸），所以不需要额外换算。 */
  function autoGrowHeight(box, el) {
    const node = box.closest('.rs-el');
    box.style.height = 'auto';
    const h = Math.max(32, box.scrollHeight);
    el.h = h;
    if (node) node.style.height = h + 'px';
  }
```

- [ ] **Step 2: 宽度拖拽把手（只调宽度，高度自适应）**

在 `renderElements()` 里，`buildElementNode` 调用之后的选中态需要挂把手——把 `buildElementNode` 末尾 `return node;` 之前加一行：

```js
    if (!presenting && el.id === selectedId) attachHandles(node, el);
```

在文件里加 `attachHandles` 和 `startTextResize`（图片用的 `startImageResize` 留给 Task 8）：

```js
  function attachHandles(node, el) {
    if (el.type === 'text') {
      ['l', 'r'].forEach((side) => {
        const h = document.createElement('div');
        h.className = 'rs-handle rs-handle-' + side;
        h.addEventListener('pointerdown', (e) => startTextResize(e, el, side));
        node.appendChild(h);
      });
    }
  }

  function startTextResize(e, el, side) {
    e.stopPropagation();
    const startX = e.clientX;
    const origX = el.x, origW = el.w;
    const k = () => canvasEl.getBoundingClientRect().width / CANVAS_W;
    const node = canvasEl.querySelector(`.rs-el[data-id="${el.id}"]`);
    const box = node && node.querySelector('.rs-text');
    const onMove = (me) => {
      const dx = (me.clientX - startX) / k();
      if (side === 'r') {
        el.w = Math.max(60, origW + dx);
      } else {
        const newW = Math.max(60, origW - dx);
        el.x = origX + (origW - newW);
        el.w = newW;
      }
      if (node) { node.style.left = el.x + 'px'; node.style.width = el.w + 'px'; }
      if (box) autoGrowHeight(box, el);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      scheduleSave();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }
```

- [ ] **Step 3: 工具栏加字号/颜色/加粗/斜体/对齐**

把 `renderToolbar()` 里现有的：

```js
    [mkBtn('置顶', bringToFront), mkBtn('置底', sendToBack), mkBtn('删除', deleteSelected)]
      .forEach((b) => { b.disabled = !el; toolbarEl.appendChild(b); });
```

后面追加（还在同一个函数里）：

```js
    if (el && el.type === 'text') {
      const size = document.createElement('input');
      size.type = 'number'; size.min = '10'; size.max = '160'; size.className = 'rs-toolbar-size';
      size.value = String(el.fontSize || DEFAULT_FONT_SIZE);
      size.onchange = () => { el.fontSize = Number(size.value) || DEFAULT_FONT_SIZE; scheduleSave(); renderElements(); };
      toolbarEl.appendChild(size);

      const color = document.createElement('input');
      color.type = 'color'; color.className = 'rs-toolbar-color';
      color.value = el.color || '#808080';
      color.oninput = () => {
        el.color = color.value;
        scheduleSave();
        const box = canvasEl.querySelector(`.rs-el[data-id="${el.id}"] .rs-text`);
        if (box) box.style.color = el.color;
      };
      toolbarEl.appendChild(color);

      const bold = mkBtn('B', () => { el.bold = !el.bold; scheduleSave(); renderElements(); });
      bold.classList.toggle('on', !!el.bold);
      toolbarEl.appendChild(bold);

      const italic = mkBtn('I', () => { el.italic = !el.italic; scheduleSave(); renderElements(); });
      italic.classList.toggle('on', !!el.italic);
      toolbarEl.appendChild(italic);

      [['left', '⟸'], ['center', '≡'], ['right', '⟹']].forEach(([a, label]) => {
        const b = mkBtn(label, () => { el.align = a; scheduleSave(); renderElements(); });
        b.classList.toggle('on', (el.align || 'left') === a);
        toolbarEl.appendChild(b);
      });
    }
```

- [ ] **Step 4: CSS——把手 + 字号/颜色控件**

在 `public/styles.css` 上一步加的 `.rs-text {...}` 之后继续加：

```css
.rs-handle {
  position: absolute; top: 0; width: 8px; height: 100%; cursor: ew-resize;
  background: transparent;
}
.rs-handle-l { left: -4px; }
.rs-handle-r { right: -4px; }
.rs-el.sel .rs-handle::after {
  content: ''; position: absolute; top: 50%; left: 50%; width: 5px; height: 24px;
  transform: translate(-50%, -50%); border-radius: 3px; background: var(--mint);
}
.rs-toolbar-size {
  width: 56px; background: var(--field-bg); border: 1px solid var(--line); color: var(--text);
  border-radius: 6px; padding: 6px 8px; font-size: 12.5px;
}
.rs-toolbar-color { width: 32px; height: 32px; padding: 2px; border: 1px solid var(--line); border-radius: 6px; background: none; cursor: pointer; }
```

- [ ] **Step 5: 手动验证**

Run: `node server.js`，浏览器登录进自定义页。

1. 新建一个文字框，双击进入编辑——Expected：出现文字光标，能直接打字；打字过程中文字框高度跟着内容自动往下撑（不会溢出裁切，也不会留死板的空白）。点画布空白处或按 Esc——Expected：退出编辑态，内容保留，刷新页面后内容还在。
2. 单击（不是双击）选中文字框——Expected：左右各出现一个窄的拖拽把手，拖动右边把手能改变宽度（文字重新换行），高度跟着内容自动调整，不能拖出比原内容还矮导致文字被裁掉的情况。
3. 工具栏出现字号数字框、颜色选择器、B/I 按钮和三个对齐按钮——改字号、换颜色、点 B/I、切对齐——Expected：画布里文字框实时反映这些变化；刷新页面后这些格式设置都还在（说明这些字段也被自动保存和正确回读了，对应 Task 1 `sanitizeElement` 里的 `fontSize/color/bold/italic/align` 字段）。
4. 用不同颜色/字号/加粗组合验证浅色/深色主题切换（设置里切主题）下画布默认背景色和默认（未显式设过颜色的）文字颜色会跟着主题联动，而显式设置过颜色的文字框颜色保持不变（对应 Global Constraints 里"背景/默认字色随主题、字号是固定常量"的澄清）。

- [ ] **Step 6: Commit**

```bash
git add public/report-slides.js public/styles.css
git commit -m "feat(reports): add text-box inline editing, width resize with auto-height, and rich-text toolbar"
```

---

### Task 8: `public/report-slides.js` — 图片元素：插入 + 四角把手等比缩放

**Files:**
- Modify: `public/report-slides.js`

**Interfaces:**
- Consumes: `A.uploadImage() -> Promise<string|null>`（已有，`public/core.js`，弹文件选择、上传到 `/api/upload`、返回 `/uploads/xxx.ext` 或用户取消时返回 `null`）。
- Produces: 元素数据结构里 `image` 类型的完整实现（`{ id, type:'image', x, y, w, h, z, url, naturalW, naturalH }`，跟 Task 1 的 `sanitizeElement` 完全对齐），工具栏「插入图片」按钮从禁用变成真正可用。

- [ ] **Step 1: `buildElementNode` 加 image 分支**

把 `buildElementNode` 里现有的（Task 6/7 只写了 `if (el.type === 'text') { ... }`），在这个 `if` 块后面加一个 `else` 分支：

```js
    } else {
      const img = document.createElement('img');
      img.className = 'rs-image';
      img.src = el.url;
      img.draggable = false;
      node.appendChild(img);
    }
```

（也就是把原来的 `if (el.type === 'text') { ... }` 改成 `if (el.type === 'text') { ... } else { ...上面这段... }`。）

- [ ] **Step 2: `attachHandles` 加图片的四角把手**

把 Task 7 写的 `attachHandles` 里只有 `if (el.type === 'text') {...}` 一个分支，加上 `else`：

```js
  function attachHandles(node, el) {
    if (el.type === 'text') {
      ['l', 'r'].forEach((side) => {
        const h = document.createElement('div');
        h.className = 'rs-handle rs-handle-' + side;
        h.addEventListener('pointerdown', (e) => startTextResize(e, el, side));
        node.appendChild(h);
      });
    } else {
      ['nw', 'ne', 'sw', 'se'].forEach((corner) => {
        const h = document.createElement('div');
        h.className = 'rs-handle rs-handle-' + corner;
        h.addEventListener('pointerdown', (e) => startImageResize(e, el, corner));
        node.appendChild(h);
      });
    }
  }
```

- [ ] **Step 3: `startImageResize`（锁定宽高比，四角拖拽）**

在 `startTextResize` 函数后面加：

```js
  /** 锁定宽高比：只用水平方向的拖动距离驱动缩放（宽高按原始比例
   *  联动），不做对角线投影那套更精确但更复杂的计算——"简单编辑
   *  功能"这个定位下，横向距离已经够直观、够好用。 */
  function startImageResize(e, el, corner) {
    e.stopPropagation();
    const startX = e.clientX;
    const origX = el.x, origY = el.y, origW = el.w, origH = el.h;
    const ratio = origW / origH;
    const k = () => canvasEl.getBoundingClientRect().width / CANVAS_W;
    const node = canvasEl.querySelector(`.rs-el[data-id="${el.id}"]`);
    const signX = corner.includes('w') ? -1 : 1;
    const onMove = (me) => {
      const dx = (me.clientX - startX) / k() * signX;
      const newW = Math.max(24, origW + dx);
      const newH = newW / ratio;
      el.w = newW; el.h = newH;
      if (corner.includes('w')) el.x = origX + (origW - newW);
      if (corner.includes('n')) el.y = origY + (origH - newH);
      if (node) {
        node.style.left = el.x + 'px'; node.style.top = el.y + 'px';
        node.style.width = el.w + 'px'; node.style.height = el.h + 'px';
      }
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      scheduleSave();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }
```

- [ ] **Step 4: 「插入图片」按钮真正实现**

把 `renderToolbar()` 里现有的占位：

```js
    const imageBtn = mkBtn('插入图片', () => {});
    imageBtn.disabled = true;
    imageBtn.title = '下一步实现';
    toolbarEl.appendChild(imageBtn);
```

改成：

```js
    toolbarEl.appendChild(mkBtn('插入图片', insertImage));
```

在 `addTextElement` 函数后面加 `insertImage`：

```js
  async function insertImage() {
    const page = currentPage();
    if (!page || presenting) return;
    let url;
    try { url = await A.uploadImage(); }
    catch (e) { A.toast('图片上传失败：' + e.message, 'bad'); return; }
    if (!url) return;

    const [nw, nh] = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
      img.onerror = () => resolve([400, 300]);
      img.src = url;
    });
    const maxSide = 640;
    const scale = Math.min(1, maxSide / Math.max(nw, nh));
    const w = Math.round(nw * scale), h = Math.round(nh * scale);
    const el = {
      id: A.uid('el_'), type: 'image',
      x: Math.round((CANVAS_W - w) / 2), y: Math.round((CANVAS_H - h) / 2),
      w, h, z: nextZ(page), url, naturalW: nw, naturalH: nh
    };
    page.elements.push(el);
    selectedId = el.id;
    scheduleSave();
    renderElements();
  }
```

- [ ] **Step 5: CSS——图片元素样式**

在 `public/styles.css` 上一步加的 `.rs-toolbar-color {...}` 后面继续加：

```css
.rs-image { width: 100%; height: 100%; object-fit: fill; display: block; pointer-events: none; }
.rs-handle-nw, .rs-handle-ne, .rs-handle-sw, .rs-handle-se {
  position: absolute; width: 12px; height: 12px; border-radius: 50%;
  background: var(--mint); border: 2px solid var(--surface);
}
.rs-handle-nw { top: -6px; left: -6px; cursor: nwse-resize; }
.rs-handle-se { bottom: -6px; right: -6px; cursor: nwse-resize; }
.rs-handle-ne { top: -6px; right: -6px; cursor: nesw-resize; }
.rs-handle-sw { bottom: -6px; left: -6px; cursor: nesw-resize; }
```

（`.rs-image` 用 `object-fit: fill` 而不是 `contain`——因为 `w`/`h` 本身已经是等比缩放算出来的，容器尺寸和图片比例天然一致，`fill` 能让图片精确填满容器不留缝，且跟 `startImageResize` 的等比缩放逻辑保持"容器比例 == 图片比例"这个不变量一致。）

- [ ] **Step 6: 手动验证**

Run: `node server.js`，浏览器登录进自定义页。

1. 点「插入图片」，选一张本地图片（PNG/JPG/WebP，参考 `A.uploadImage()` 的限制：≤40MB）——Expected：上传中会有 toast 提示（`A.uploadImage()` 自带的），成功后画布中央出现这张图，按原比例缩放到不超过 640px 那条边。
2. 拖动图片——Expected：跟手移动，行为跟文字框拖拽一致。
3. 单击选中图片——Expected：四个角出现小圆点把手（不是文字框那种左右窄条）；拖动任意一个角——Expected：图片等比放大/缩小，不会变形拉伸；缩到很小或放到很大都不应该报错或出现负数尺寸。
4. 刷新页面——Expected：图片位置、大小都保留；再进「放映模式」——Expected：图片正常显示且不再有把手/拖拽反应（只读态）。
5. 选中图片点工具栏「删除」——Expected：图片消失；换一张图再插入，选中后点「置顶」「置底」跟已有文字框互相压盖，验证层级正确。

- [ ] **Step 7: Commit**

```bash
git add public/report-slides.js public/styles.css
git commit -m "feat(reports): add image element — insert via upload and aspect-locked corner resize"
```

---

### Task 9: 端到端手动验证收尾

**Files:** 无代码改动，纯验证；如果验证中发现遗漏，就地补丁后再提交。

- [ ] **Step 1: 完整走一遍功能矩阵**

Run: `cd /root/IQAir-Project/EC-Workbench && node server.js`，浏览器登录（`admin`/`123456` 或对应 `ADMIN_PIN`）。逐项确认：

- [ ] 第 1、2 页（生意参谋/微盟数据）的原有功能没有回归——数据导入、范围筛选、微盟表单保存都跟改动前一样。
- [ ] 新建 3 个自定义页，分别放文字+图片混合内容，页签正确编号为第 3/4/5 页。
- [ ] 方向键在放映模式下能从第 1 页一路翻到最后一页，翻到头/尾不出错；Esc 正常退出放映并恢复顶栏/侧栏。
- [ ] 放映模式下自定义页是纯展示（工具栏隐藏、元素点不动、拖不动），且画布整体缩放铺满全屏没有变形或裁切。
- [ ] 删除中间一个自定义页后，后面的页面编号正确前移，内容没有串页。
- [ ] 主题切换（设置里浅色/深色）后，自定义页的画布背景、未显式设置颜色的文字，颜色都正确跟随；已经手动设过颜色的文字不受主题切换影响。
- [ ] 刷新浏览器（模拟中途关闭再打开）——所有自定义页、页面里的每个元素位置/大小/文字内容/格式/图片，都跟刷新前一致（自动保存链路完整闭环）。
- [ ] 用两个不同账号分别登录（如果环境里有多个用户），确认各自的自定义页互不可见、互不影响（个人报告数据按 `userId` 隔离，见 `report-store.js` 的 `file(userId)`）。

- [ ] **Step 2: 跑一遍现有自动化测试，确认没有破坏其它模块**

Run: `cd /root/IQAir-Project/EC-Workbench && node merge.test.js && node materialcheck.test.js && node report-store.test.js`
Expected: 三个都以 `... passed, 0 failed` 结束，退出码 0。

- [ ] **Step 3: 如果发现问题，就地修复后提交**

```bash
git add -A
git commit -m "fix(reports): <具体修的什么>"
```

（如果第 1、2 步全部通过、没有需要修的，这一步跳过。）

---

## Self-Review

**Spec coverage**（对照已确认需求规格逐条核对）：
1. 整体形态（追加分页、非平铺、页签"+新建"、自动编号、删除二次确认、不支持重排）→ Task 3（静态骨架）+ Task 5（分页逻辑）覆盖。
2. 画布模型（固定 1280×720 + 整体缩放）→ Task 4（`renderShell`）覆盖。
3. 背景/默认字色跟主题、默认字号固定值 → Task 4 CSS（`var(--surface)`/`var(--text)`）+ Global Constraints 里的工程澄清覆盖。
4. 编辑态=非放映态，无独立开关 → Task 5（`setPresenting` 钩子）+ 所有渲染函数里的 `presenting` 判断覆盖。
5. 文字框（新建/富文本/拖拽/宽度调整/高度自适应）→ Task 6 + Task 7 覆盖。
6. 图片（插入/拖拽/等比缩放）→ Task 6（拖拽通用） + Task 8（插入、缩放）覆盖。
7. 删除、层级（置顶/置底）→ Task 6 覆盖，两种元素类型通用。
8. 明确排除项（旋转/多选/页面重排/重命名/撤销）→ 全篇没有任何一个任务实现这些，符合要求。
9. 自动保存（debounce，覆盖式保存）→ Task 1（`slidesSave` 覆盖式）+ Task 4（`scheduleSave`/`flushSave`）覆盖。
10. 范围只到"个人报告"→ 所有改动都在 `#rpt-personal-view`/`rpt-page-custom` 范围内，没有碰 `#rpt-public-view`。

**Placeholder scan**：全篇代码块都是可以直接粘贴运行的完整实现，没有 `TODO`/"后续实现"字样（Task 6 里「插入图片」按钮的禁用占位是刻意的、可运行的中间态，Task 8 Step 4 会替换掉，不是遗留占位）。

**Type consistency**：`ReportSlides` 对外接口在 Task 4-5 定义后没有再变过签名（`init/setPages/pageCount/addPage/deletePage/mountPage/unmountPage/setPresenting`）；元素字段名（`x/y/w/h/z/text/fontSize/color/bold/italic/align/url/naturalW/naturalH`）在 Task 1 的 `sanitizeElement`、Task 6-8 的前端构造/渲染代码里完全一致，没有出现字段改名的情况。

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-28-report-personal-slides.md`. Two execution options:**

**1. Subagent-Driven（推荐）** — 我给每个 Task 派一个全新子代理去做，任务之间互相 review，迭代更快

**2. Inline Execution** — 在当前会话里按 executing-plans 那套走，批量执行、设检查点手动确认

**Which approach？**
