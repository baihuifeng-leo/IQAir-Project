# 素材文案关键词检测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sixth top-level tab that batch-uploads marketing material images, OCRs them server-side, and flags copy that's missing a product's required keywords (缺词) or leaked in another product's keywords (串词), against an admin-managed keyword library.

**Architecture:** Three new server-side modules (`materialcheck-ocr.js` wraps the system `tesseract` binary via `child_process`; `materialcheck-match.js` is pure product-resolution/keyword-matching logic; `materialcheck-store.js` ties them together with JSON/JSONL persistence) wired into `server.js`'s existing flat route-chain pattern. One new frontend module (`materialcheck.js`) follows the existing IIFE-tab-module convention (like `reviews.js`), wired into `index.html`/`core.js`/`settings.js` exactly like the five existing tabs.

**Tech Stack:** Node.js `http` (no framework), system `tesseract-ocr` binary via `child_process.execFile`, vanilla JS/CSS frontend, zero npm dependencies, zero build step.

## Global Constraints

- **Zero external dependencies, no npm, no build step, no bundler.** All new files are plain `.js`/`.css`, loaded via `<script>` tags. (CLAUDE.md)
- **No automated frontend test suite exists in this project.** ("There is no automated frontend test suite - UI changes must be verified by hand." — CLAUDE.md Commands section). Frontend tasks in this plan therefore use concrete manual-browser-verification steps instead of automated test code — this is a deliberate adaptation of TDD to match the project's actual testing reality, not a shortcut.
- **This is a flattened checkout.** New server-side `.js` files go loose in `competitive-workbench/` root (not under `public/`). New frontend `.js`/`.css` changes also go loose in `competitive-workbench/` root (mirrors `reviews.js` sitting next to `server.js`, even though it ships under `public/` in the tarball).
- **Tarball sync is deferred to the final task (Task 9).** CLAUDE.md requires `competitive-workbench.tar.gz` to be rebuilt in the same commit as any loose-file change; across 8 preceding TDD tasks that would mean repacking (and re-committing a multi-MB binary) after every single commit. Instead, `scripts/repack-tarball.sh`'s manifest is updated once new files exist, and the repack + commit happens once at the end of the sequence (Task 9), matching how this repo's actual history sometimes bundles a repack as its own trailing commit (e.g. `6282d68 重新打包 competitive-workbench.tar.gz`).
- **OCR engine is the system `tesseract-ocr` binary (apt-installed, with `tesseract-ocr-chi-sim`), invoked via `child_process`.** Not `tesseract.js`/WASM. It will not be present in a fresh dev sandbox — `materialcheck-ocr.js`'s automated tests inject a stub exec function so they pass without the real binary; real-OCR accuracy is a manual verification step (per the design spec's own stated test plan) once the binary is actually installed.
- **Raw binary image uploads only — no re-encoding.** `core.js`'s `processImage()` (canvas re-encode + downscale) must NOT be used for material-check uploads — it exists for other features and is explicitly known to degrade text sharpness, which would hurt OCR accuracy. Use raw `fetch(..., {body: file})`, same discipline as `core.js`'s `uploadImage()` and the existing `/api/upload` route.
- **Keyword matching is strict substring containment** (whitespace-normalized), not fuzzy — no edit-distance/typo tolerance in this version.
- **A keyword belongs to exactly one place** — one product's list, or the universal list — never both, never duplicated across products. Enforced at save time in `materialcheck-store.js`, not at match time.
- New product/keyword data is **fully independent** of the price-band matrix, competitor-comparison, or 3D-preview product data — no cross-reuse.

---

## File Structure

**New server-side files** (loose in `competitive-workbench/` root):
- `materialcheck-ocr.js` — `child_process` wrapper around the `tesseract` binary.
- `materialcheck-match.js` — pure functions: keyword-hit detection, product resolution (filename/OCR tiers), missing/crossed keyword computation, library-uniqueness validation.
- `materialcheck-store.js` — `MaterialCheckStore` class: loads/saves `materialcheck/products.json` (keyword library) and `materialcheck/records.jsonl` (append-only detection history), manages the in-memory pending-manual-pick cache, orchestrates the per-upload pipeline using the two modules above.
- `materialcheck.test.js` — zero-framework test file (same style as `merge.test.js`), built up incrementally across Tasks 1–3.

**New frontend file** (loose in `competitive-workbench/` root, ships under `public/`):
- `materialcheck.js` — the tab's IIFE module, built up incrementally across Tasks 6–8 (检测台 upload workbench → 历史记录 history view → 关键词库 admin panel).

**Modified files:**
- `server.js` — new routes, store instantiation, boot-time OCR availability check.
- `index.html` — new tab button, new `<section class="view">`, new hidden multi-file `<input>`, new `<script>` tag.
- `core.js` — `MODULES` array, hash-routing whitelist in `boot()`.
- `settings.js` — `MODULES` array (per-user visibility toggle).
- `styles.css` — new `.mc-*` section, appended after the existing 报告管理 (`.rpt-*`) section.
- `install.sh` — new apt step for `tesseract-ocr`/`tesseract-ocr-chi-sim`, new files in the copy-list, new data directories.
- `scripts/repack-tarball.sh` — new files added to both `cp` manifests.

---

### Task 1: OCR wrapper (`materialcheck-ocr.js`)

**Files:**
- Create: `competitive-workbench/materialcheck-ocr.js`
- Create: `competitive-workbench/materialcheck.test.js`

**Interfaces:**
- Produces: `runOcr(imagePath, { exec, lang } = {})` → `Promise<string>` (trimmed OCR text). `checkAvailable({ exec } = {})` → `Promise<boolean>`. Both accept an injectable `exec` function matching `child_process.execFile`'s callback signature `(cmd, args, opts, cb)`, defaulting to the real `child_process.execFile` — this is the seam that lets tests run without a real `tesseract` binary.

- [ ] **Step 1: Write the failing tests**

Create `competitive-workbench/materialcheck.test.js`:

```js
const assert = require('assert');
const { runOcr, checkAvailable } = require('./materialcheck-ocr.js');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '-', e.message); }
};
const tAsync = async (name, fn) => {
  try { await fn(); pass++; console.log('✓', name); }
  catch (e) { fail++; console.log('✗', name, '-', e.message); }
};

async function run() {
  // ── materialcheck-ocr.js ──────────────────────────────
  await tAsync('runOcr 用正确的命令调用 tesseract', async () => {
    let calledWith = null;
    const stubExec = (cmd, args, opts, cb) => { calledWith = { cmd, args, opts }; cb(null, '识别出的文字\n', ''); };
    const text = await runOcr('/tmp/x.jpg', { exec: stubExec });
    assert.strictEqual(calledWith.cmd, 'tesseract');
    assert.deepStrictEqual(calledWith.args, ['/tmp/x.jpg', 'stdout', '-l', 'chi_sim+eng']);
    assert.strictEqual(text, '识别出的文字');
  });

  await tAsync('runOcr 支持自定义语言参数', async () => {
    let calledWith = null;
    const stubExec = (cmd, args, opts, cb) => { calledWith = { cmd, args }; cb(null, 'text', ''); };
    await runOcr('/tmp/x.jpg', { exec: stubExec, lang: 'eng' });
    assert.deepStrictEqual(calledWith.args, ['/tmp/x.jpg', 'stdout', '-l', 'eng']);
  });

  await tAsync('runOcr 命令失败时 reject 出有意义的错误', async () => {
    const stubExec = (cmd, args, opts, cb) => cb(new Error('spawn failed'), '', '图片格式不支持');
    await assert.rejects(runOcr('/tmp/bad.jpg', { exec: stubExec }), /OCR 识别失败.*图片格式不支持/);
  });

  await tAsync('checkAvailable 二进制存在时返回 true', async () => {
    const stubExec = (cmd, args, opts, cb) => cb(null, 'tesseract 5.3.0', '');
    assert.strictEqual(await checkAvailable({ exec: stubExec }), true);
  });

  await tAsync('checkAvailable 二进制缺失时返回 false（不抛出）', async () => {
    const stubExec = (cmd, args, opts, cb) => cb(new Error('command not found'));
    assert.strictEqual(await checkAvailable({ exec: stubExec }), false);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd competitive-workbench && node materialcheck.test.js`
Expected: FAIL immediately with `Cannot find module './materialcheck-ocr.js'`

- [ ] **Step 3: Write the implementation**

Create `competitive-workbench/materialcheck-ocr.js`:

```js
'use strict';

const { execFile } = require('child_process');

/**
 * 调用系统级 tesseract 二进制识别图片文字。
 * exec 可注入桩函数用于测试，默认用真实的 child_process.execFile。
 */
function runOcr(imagePath, { exec = execFile, lang = 'chi_sim+eng' } = {}) {
  return new Promise((resolve, reject) => {
    exec('tesseract', [imagePath, 'stdout', '-l', lang], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('OCR 识别失败：' + (stderr || err.message || '未知错误')));
      resolve(String(stdout || '').trim());
    });
  });
}

/**
 * 服务启动时探测 tesseract 是否可用，不可用只打日志警告，不阻断服务启动。
 */
function checkAvailable({ exec = execFile } = {}) {
  return new Promise((resolve) => {
    exec('tesseract', ['--version'], { maxBuffer: 1024 * 1024 }, (err) => {
      if (err) {
        console.warn('[materialcheck] 没有检测到 tesseract 二进制，素材检测功能会失败。跑一遍 install.sh，或手动 apt-get install tesseract-ocr tesseract-ocr-chi-sim');
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

module.exports = { runOcr, checkAvailable };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd competitive-workbench && node materialcheck.test.js`
Expected: `5 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
cd competitive-workbench
git add materialcheck-ocr.js materialcheck.test.js
git commit -m "$(cat <<'EOF'
feat: 素材质检 OCR 封装（tesseract child_process，可注入桩函数测试）
EOF
)"
```

---

### Task 2: Pure keyword-matching logic (`materialcheck-match.js`)

**Files:**
- Create: `competitive-workbench/materialcheck-match.js`
- Modify: `competitive-workbench/materialcheck.test.js` (append tests before the `console.log`/`process.exit` tail)

**Interfaces:**
- Consumes: nothing (pure module, no dependency on Task 1).
- Produces:
  - `normalize(s)` → `string` (strips whitespace)
  - `findKeywordHits(text, keywords)` → `string[]` (subset of `keywords` found in `text`)
  - `validateLibrary(products, universalKeywords)` → `Array<{keyword, first, second}>` (empty if no conflicts). `products` shape: `[{id, name, keywords: string[]}]`.
  - `resolveByFilename(filename, products)` → `product | null`
  - `resolveProduct(text, products)` → `{ resolved: product|null, ambiguous: boolean, candidates?: product[] }`
  - `resolveProductForUpload(filename, ocrText, products)` → `{ method: 'filename'|'ocr'|null, product: product|null, ambiguous: boolean, candidates: product[] }`
  - `crossCheckWarning(resolvedProduct, ocrText, products)` → `string | null`
  - `matchAgainstProduct(text, product, allProducts)` → `{ missingKeywords: string[], crossedKeywords: Array<{keyword, fromProductId, fromProductName}>, status: 'pass'|'fail' }`

- [ ] **Step 1: Write the failing tests**

Insert into `competitive-workbench/materialcheck.test.js`, **before** the `console.log(\`\n${pass} passed...` tail line, right after the existing OCR test block inside `run()`:

```js
  // ── materialcheck-match.js ────────────────────────────
  const M = require('./materialcheck-match.js');

  const productA = { id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi', '抗菌滤网认证号XXX'] };
  const productB = { id: 'pb', name: 'GCX XE', keywords: ['GCX XE', '静音悬浮马达'] };
  const products = [productA, productB];
  const universal = ['7天无理由退换', '包邮'];

  t('findKeywordHits 找出命中的关键词，忽略空白', () => {
    const hits = M.findKeywordHits('这款 GC-Multi 带 抗菌滤网认证号XXX 效果好', ['GC-Multi', '抗菌滤网认证号XXX', 'GCX XE']);
    assert.deepStrictEqual(hits, ['GC-Multi', '抗菌滤网认证号XXX']);
  });

  t('findKeywordHits 忽略文本中的换行空格', () => {
    const hits = M.findKeywordHits('这款 GC\n-Multi 不错', ['GC-Multi']);
    assert.deepStrictEqual(hits, ['GC-Multi']);
  });

  t('validateLibrary 无冲突时返回空数组', () => {
    assert.deepStrictEqual(M.validateLibrary(products, universal), []);
  });

  t('validateLibrary 检出跨产品重复关键词', () => {
    const dup = [productA, { id: 'pc', name: 'C', keywords: ['GC-Multi'] }];
    const conflicts = M.validateLibrary(dup, []);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].keyword, 'GC-Multi');
  });

  t('validateLibrary 检出产品词和通用词重复', () => {
    const conflicts = M.validateLibrary(products, ['GC-Multi']);
    assert.strictEqual(conflicts.length, 1);
    assert.strictEqual(conflicts[0].keyword, 'GC-Multi');
  });

  t('resolveByFilename 文件名唯一命中一个产品', () => {
    const p = M.resolveByFilename('GC-Multi_主图_v2.jpg', products);
    assert.strictEqual(p.id, 'pa');
  });

  t('resolveByFilename 文件名没有命中返回 null', () => {
    assert.strictEqual(M.resolveByFilename('random_image_01.jpg', products), null);
  });

  t('resolveProduct 按关键词命中数最多的产品判定', () => {
    const r = M.resolveProduct('这款 GC-Multi 带 抗菌滤网认证号XXX', products);
    assert.strictEqual(r.resolved.id, 'pa');
    assert.strictEqual(r.ambiguous, false);
  });

  t('resolveProduct 零命中时不确定', () => {
    const r = M.resolveProduct('完全不相关的文字', products);
    assert.strictEqual(r.resolved, null);
    assert.strictEqual(r.ambiguous, false);
  });

  t('resolveProduct 命中数并列时判定为歧义', () => {
    const r = M.resolveProduct('GC-Multi 和 GCX XE 都出现了', products);
    assert.strictEqual(r.resolved, null);
    assert.strictEqual(r.ambiguous, true);
    assert.strictEqual(r.candidates.length, 2);
  });

  t('resolveProductForUpload 文件名优先于 OCR', () => {
    const r = M.resolveProductForUpload('GC-Multi_主图.jpg', 'GCX XE 静音悬浮马达', products);
    assert.strictEqual(r.method, 'filename');
    assert.strictEqual(r.product.id, 'pa');
  });

  t('resolveProductForUpload 文件名不确定时退到 OCR 反查', () => {
    const r = M.resolveProductForUpload('IMG_0001.jpg', 'GCX XE 静音悬浮马达', products);
    assert.strictEqual(r.method, 'ocr');
    assert.strictEqual(r.product.id, 'pb');
  });

  t('resolveProductForUpload 两级都无法判定时标记待人工选择', () => {
    const r = M.resolveProductForUpload('IMG_0001.jpg', '无关文字', products);
    assert.strictEqual(r.method, null);
    assert.strictEqual(r.product, null);
    assert.strictEqual(r.ambiguous, true);
  });

  t('crossCheckWarning 文件名判定和 OCR 倾向一致时无提示', () => {
    const w = M.crossCheckWarning(productA, 'GC-Multi 抗菌滤网认证号XXX', products);
    assert.strictEqual(w, null);
  });

  t('crossCheckWarning OCR 明显倾向另一个产品时给出提示', () => {
    const w = M.crossCheckWarning(productA, 'GCX XE 静音悬浮马达', products);
    assert.ok(w && w.includes('GCX XE'));
  });

  t('matchAgainstProduct 全部命中且无串词时通过', () => {
    const r = M.matchAgainstProduct('GC-Multi 抗菌滤网认证号XXX 7天无理由退换', productA, products);
    assert.deepStrictEqual(r.missingKeywords, []);
    assert.deepStrictEqual(r.crossedKeywords, []);
    assert.strictEqual(r.status, 'pass');
  });

  t('matchAgainstProduct 缺词判定', () => {
    const r = M.matchAgainstProduct('GC-Multi', productA, products);
    assert.deepStrictEqual(r.missingKeywords, ['抗菌滤网认证号XXX']);
    assert.strictEqual(r.status, 'fail');
  });

  t('matchAgainstProduct 串词判定，标注来源产品', () => {
    const r = M.matchAgainstProduct('GC-Multi 抗菌滤网认证号XXX GCX XE', productA, products);
    assert.deepStrictEqual(r.missingKeywords, []);
    assert.strictEqual(r.crossedKeywords.length, 1);
    assert.strictEqual(r.crossedKeywords[0].keyword, 'GCX XE');
    assert.strictEqual(r.crossedKeywords[0].fromProductId, 'pb');
    assert.strictEqual(r.status, 'fail');
  });

  t('matchAgainstProduct 通用词不参与缺词也不参与串词', () => {
    const r = M.matchAgainstProduct('GC-Multi 抗菌滤网认证号XXX', productA, products);
    assert.deepStrictEqual(r.missingKeywords, []);
    assert.deepStrictEqual(r.crossedKeywords, []);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd competitive-workbench && node materialcheck.test.js`
Expected: FAIL with `Cannot find module './materialcheck-match.js'` (the 5 OCR tests from Task 1 still pass first, then this require throws)

- [ ] **Step 3: Write the implementation**

Create `competitive-workbench/materialcheck-match.js`:

```js
'use strict';

function normalize(s) {
  return String(s || '').replace(/\s+/g, '');
}

function findKeywordHits(text, keywords) {
  const norm = normalize(text);
  return keywords.filter((k) => norm.includes(normalize(k)));
}

/** 校验关键词库唯一性：同一个词不能出现在两处（不管是两个产品之间，还是产品词和通用词之间）。 */
function validateLibrary(products, universalKeywords) {
  const seen = new Map();
  const conflicts = [];
  const record = (kw, where) => {
    if (seen.has(kw)) conflicts.push({ keyword: kw, first: seen.get(kw), second: where });
    else seen.set(kw, where);
  };
  products.forEach((p) => (p.keywords || []).forEach((kw) => record(kw, p.name)));
  (universalKeywords || []).forEach((kw) => record(kw, '通用词'));
  return conflicts;
}

function resolveByFilename(filename, products) {
  const norm = normalize(filename).toLowerCase();
  const matches = products.filter((p) => norm.includes(normalize(p.name).toLowerCase()));
  return matches.length === 1 ? matches[0] : null;
}

/** 按每个产品自己的专属关键词在文本里命中的数量打分，只有明显领先（不并列）才算确定。 */
function resolveProduct(text, products) {
  const scored = products
    .map((p) => ({ product: p, hits: findKeywordHits(text, p.keywords || []) }))
    .filter((s) => s.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length);

  if (scored.length === 0) return { resolved: null, ambiguous: false };
  if (scored.length === 1) return { resolved: scored[0].product, ambiguous: false };
  if (scored[0].hits.length > scored[1].hits.length) return { resolved: scored[0].product, ambiguous: false };
  return { resolved: null, ambiguous: true, candidates: scored.map((s) => s.product) };
}

/** 三级产品归属识别的编排：文件名 → OCR 反查 → 都不确定则交给人工。 */
function resolveProductForUpload(filename, ocrText, products) {
  const byFilename = resolveByFilename(filename, products);
  if (byFilename) return { method: 'filename', product: byFilename, ambiguous: false, candidates: [] };

  const byOcr = resolveProduct(ocrText, products);
  if (byOcr.resolved) return { method: 'ocr', product: byOcr.resolved, ambiguous: false, candidates: [] };

  return { method: null, product: null, ambiguous: true, candidates: byOcr.candidates || [] };
}

/** 即便文件名已经判定了产品，如果 OCR 文字更像属于另一个产品，给一条软提示。 */
function crossCheckWarning(resolvedProduct, ocrText, products) {
  const byOcr = resolveProduct(ocrText, products);
  if (byOcr.resolved && byOcr.resolved.id !== resolvedProduct.id) {
    return `型号可能填错了：素材文字更像属于「${byOcr.resolved.name}」`;
  }
  return null;
}

/** 缺词 = 本产品专属关键词里没在文本中出现的；串词 = 其它产品专属关键词出现在了本文本里。通用词两边都不参与。 */
function matchAgainstProduct(text, product, allProducts) {
  const missingKeywords = (product.keywords || []).filter((kw) => findKeywordHits(text, [kw]).length === 0);
  const crossedKeywords = [];
  allProducts.forEach((other) => {
    if (other.id === product.id) return;
    findKeywordHits(text, other.keywords || []).forEach((keyword) => {
      crossedKeywords.push({ keyword, fromProductId: other.id, fromProductName: other.name });
    });
  });
  const status = missingKeywords.length === 0 && crossedKeywords.length === 0 ? 'pass' : 'fail';
  return { missingKeywords, crossedKeywords, status };
}

module.exports = {
  normalize, findKeywordHits, validateLibrary, resolveByFilename,
  resolveProduct, resolveProductForUpload, crossCheckWarning, matchAgainstProduct
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd competitive-workbench && node materialcheck.test.js`
Expected: `24 passed, 0 failed` (corrected from an original miscount of 23 — the task actually specifies 19 new test cases, not 18, so 5 prior + 19 = 24; confirmed by running the suite after Task 2 completed)

- [ ] **Step 5: Commit**

```bash
cd competitive-workbench
git add materialcheck-match.js materialcheck.test.js
git commit -m "$(cat <<'EOF'
feat: 素材质检关键词匹配纯逻辑（产品归属三级识别 + 缺词/串词判定）
EOF
)"
```

---

### Task 3: Store module (`materialcheck-store.js`)

**Files:**
- Create: `competitive-workbench/materialcheck-store.js`
- Modify: `competitive-workbench/materialcheck.test.js` (append tests)

**Interfaces:**
- Consumes: `materialcheck-match.js`'s full exported API (Task 2), `materialcheck-ocr.js`'s `runOcr` (Task 1, as the default `ocr` param — tests inject a stub).
- Produces: `class MaterialCheckStore`:
  - `constructor(dir, uploadDir)`
  - `async load()` — reads `products.json`/`records.jsonl` from `dir`, creates `dir`/`uploadDir` if missing.
  - `async saveProducts(products, universalKeywords)` → `{products, universalKeywords}`, throws on uniqueness conflict.
  - `async append(record)` — appends one record to `records.jsonl` and `this.records`.
  - `listRecords({productId, status, uploadedBy, limit} = {})` → `record[]` (newest first).
  - `async detectFile({buf, ext, filename, batchId, uploadedBy, ocr})` → either a finished `record` object, or `{needsManualPick: true, pendingId, ocrText, filename, candidates}`.
  - `async resolvePending(pendingId, productId, uploadedBy)` → finished `record` object, throws if `pendingId` unknown/expired.
  - Public fields read by `server.js`: `this.products`, `this.universalKeywords`.

- [ ] **Step 1: Write the failing tests**

Insert into `competitive-workbench/materialcheck.test.js`, replacing the tail (`console.log(\`\n${pass} passed...`/`process.exit`/closing `run();`) — insert this **before** that tail, and add the two new `require`s at the top of the file alongside the existing ones:

At the top of the file, alongside `const { runOcr, checkAvailable } = require('./materialcheck-ocr.js');`, add:
```js
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
```

Then insert into `run()`, after the `materialcheck-match.js` block and before the `console.log(\`\n${pass}...` tail:

```js
  // ── materialcheck-store.js ────────────────────────────
  const { MaterialCheckStore } = require('./materialcheck-store.js');
  const stubOcr = (text) => async () => text;

  async function freshStore() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const store = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store.load();
    await store.saveProducts(
      [
        { id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi', '抗菌滤网认证号XXX'] },
        { id: 'pb', name: 'GCX XE', keywords: ['GCX XE', '静音悬浮马达'] }
      ],
      ['7天无理由退换']
    );
    return store;
  }

  await tAsync('saveProducts 拒绝重复关键词并保留原有数据', async () => {
    const store = await freshStore();
    await assert.rejects(
      store.saveProducts([{ id: 'pa', name: 'A', keywords: ['同一个词'] }, { id: 'pb', name: 'B', keywords: ['同一个词'] }], []),
      /同一个词/
    );
    assert.strictEqual(store.products.length, 2); // 拒绝后没有把坏数据写进去
  });

  await tAsync('detectFile 文件名可判定时直接产出通过结果', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('fake-image-bytes'), ext: '.jpg', filename: 'GC-Multi_主图.jpg',
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX 7天无理由退换')
    });
    assert.strictEqual(result.status, 'pass');
    assert.strictEqual(result.productId, 'pa');
    assert.strictEqual(result.matchMethod, 'filename');
    assert.strictEqual(store.records.length, 1);
  });

  await tAsync('detectFile 缺词时判定不通过', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg',
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi')
    });
    assert.strictEqual(result.status, 'fail');
    assert.deepStrictEqual(result.missingKeywords, ['抗菌滤网认证号XXX']);
  });

  await tAsync('detectFile 文件名和 OCR 都无法判定时返回待人工选择，不写入历史记录', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0001.jpg',
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('无关文字')
    });
    assert.strictEqual(result.needsManualPick, true);
    assert.ok(result.pendingId);
    assert.strictEqual(store.records.length, 0);
  });

  await tAsync('resolvePending 用人工选择的产品完成判定并写入历史', async () => {
    const store = await freshStore();
    const pending = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0001.jpg',
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX')
    });
    // 用一段两个产品都不命中的文字，强迫走人工选择路径
    const ambiguousPending = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'IMG_0002.jpg',
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('完全无关的文字')
    });
    const resolved = await store.resolvePending(ambiguousPending.pendingId, 'pa', 'li');
    assert.strictEqual(resolved.matchMethod, 'manual');
    assert.strictEqual(resolved.productId, 'pa');
    assert.strictEqual(store.records.length, 2); // pending 本身没落库，resolvePending 后 + 上面那条 filename 判定的
  });

  await tAsync('resolvePending 对不存在的 pendingId 抛出错误', async () => {
    const store = await freshStore();
    await assert.rejects(store.resolvePending('mcp_不存在', 'pa', 'li'), /过期|不存在/);
  });

  await tAsync('detectFile 串词时标注来源产品，判定不通过', async () => {
    const store = await freshStore();
    const result = await store.detectFile({
      buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi_主图.jpg',
      batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX GCX XE')
    });
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.crossedKeywords[0].fromProductName, 'GCX XE');
  });

  await tAsync('listRecords 按产品和状态过滤，最新的排最前', async () => {
    const store = await freshStore();
    await store.detectFile({ buf: Buffer.from('1'), ext: '.jpg', filename: 'GC-Multi_a.jpg', batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi 抗菌滤网认证号XXX') });
    await store.detectFile({ buf: Buffer.from('2'), ext: '.jpg', filename: 'GC-Multi_b.jpg', batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi') });
    const passOnly = store.listRecords({ productId: 'pa', status: 'pass' });
    assert.strictEqual(passOnly.length, 1);
    assert.strictEqual(passOnly[0].filename, 'GC-Multi_a.jpg');
  });

  await tAsync('load() 能重新读回持久化的数据', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-test-'));
    const store1 = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store1.load();
    await store1.saveProducts([{ id: 'pa', name: 'GC-Multi', keywords: ['GC-Multi'] }], []);
    await store1.detectFile({ buf: Buffer.from('x'), ext: '.jpg', filename: 'GC-Multi.jpg', batchId: 'b1', uploadedBy: 'li', ocr: stubOcr('GC-Multi') });

    const store2 = new MaterialCheckStore(path.join(dir, 'materialcheck'), path.join(dir, 'uploads'));
    await store2.load();
    assert.strictEqual(store2.products.length, 1);
    assert.strictEqual(store2.records.length, 1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd competitive-workbench && node materialcheck.test.js`
Expected: FAIL with `Cannot find module './materialcheck-store.js'` (28 prior tests still pass first)

- [ ] **Step 3: Write the implementation**

Create `competitive-workbench/materialcheck-store.js`:

```js
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const match = require('./materialcheck-match.js');
const { runOcr } = require('./materialcheck-ocr.js');

const PENDING_TTL_MS = 30 * 60 * 1000;

class MaterialCheckStore {
  constructor(dir, uploadDir) {
    this.dir = dir;
    this.uploadDir = uploadDir;
    this.productsFile = path.join(dir, 'products.json');
    this.recordsFile = path.join(dir, 'records.jsonl');
    this.products = [];
    this.universalKeywords = [];
    this.records = [];
    this.pending = new Map();
  }

  async load() {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.mkdir(this.uploadDir, { recursive: true });

    try {
      const s = JSON.parse(await fsp.readFile(this.productsFile, 'utf8'));
      this.products = Array.isArray(s.products) ? s.products : [];
      this.universalKeywords = Array.isArray(s.universalKeywords) ? s.universalKeywords : [];
    } catch { /* 首次运行，没有文件 */ }

    try {
      const text = await fsp.readFile(this.recordsFile, 'utf8');
      let broken = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { this.records.push(JSON.parse(line)); }
        catch { broken++; }
      }
      if (broken) console.warn(`[materialcheck] 跳过 ${broken} 行损坏的记录`);
    } catch { /* 首次运行，没有文件 */ }

    console.log(`[materialcheck] 载入 ${this.products.length} 个产品，${this.records.length} 条历史记录`);
  }

  async saveProducts(products, universalKeywords) {
    const conflicts = match.validateLibrary(products, universalKeywords);
    if (conflicts.length) {
      const c = conflicts[0];
      throw new Error(`关键词「${c.keyword}」重复出现在「${c.first}」和「${c.second}」，一个词只能属于一处`);
    }
    const clean = {
      products: products.map((p) => ({
        id: p.id, name: String(p.name || '').trim(),
        keywords: (p.keywords || []).map((k) => String(k).trim()).filter(Boolean)
      })),
      universalKeywords: (universalKeywords || []).map((k) => String(k).trim()).filter(Boolean)
    };
    await fsp.writeFile(this.productsFile, JSON.stringify(clean, null, 1));
    this.products = clean.products;
    this.universalKeywords = clean.universalKeywords;
    return clean;
  }

  async append(record) {
    await fsp.appendFile(this.recordsFile, JSON.stringify(record) + '\n');
    this.records.push(record);
  }

  listRecords({ productId, status, uploadedBy, limit = 500 } = {}) {
    let rows = this.records;
    if (productId) rows = rows.filter((r) => r.productId === productId);
    if (status) rows = rows.filter((r) => r.status === status);
    if (uploadedBy) rows = rows.filter((r) => r.uploadedBy === uploadedBy);
    return rows.slice(-limit).reverse();
  }

  _cleanupPending() {
    const now = Date.now();
    for (const [id, p] of this.pending) {
      if (p.expiresAt < now) this.pending.delete(id);
    }
  }

  async detectFile({ buf, ext, filename, batchId, uploadedBy, ocr = runOcr }) {
    if (!this.products.length) throw new Error('还没有配置任何产品的关键词，先去「关键词库」里加一个产品');

    const name = crypto.randomBytes(9).toString('hex') + ext;
    const imagePath = path.join(this.uploadDir, name);
    await fsp.writeFile(imagePath, buf);
    const url = '/uploads/materialcheck/' + name;

    let ocrText;
    try {
      ocrText = await ocr(imagePath);
    } catch (e) {
      const record = {
        id: 'mc_' + crypto.randomBytes(6).toString('hex'), batchId, timestamp: new Date().toISOString(), uploadedBy,
        filename, imagePath: url, productId: null, productName: null, matchMethod: null,
        ocrText: '', missingKeywords: [], crossedKeywords: [], status: 'ocr_failed', warning: e.message
      };
      await this.append(record);
      return record;
    }

    const resolution = match.resolveProductForUpload(filename, ocrText, this.products);
    if (!resolution.product) {
      this._cleanupPending();
      const pendingId = 'mcp_' + crypto.randomBytes(6).toString('hex');
      this.pending.set(pendingId, {
        imagePath: url, filename, ocrText, batchId, uploadedBy, expiresAt: Date.now() + PENDING_TTL_MS
      });
      return { needsManualPick: true, pendingId, ocrText, filename, candidates: resolution.candidates };
    }

    const warning = resolution.method === 'filename'
      ? match.crossCheckWarning(resolution.product, ocrText, this.products)
      : null;

    return this._finish({ product: resolution.product, method: resolution.method, ocrText, imagePath: url, filename, batchId, uploadedBy, warning });
  }

  async resolvePending(pendingId, productId, uploadedBy) {
    this._cleanupPending();
    const p = this.pending.get(pendingId);
    if (!p) throw new Error('这次待选择已经过期了，重新上传这张图');
    const product = this.products.find((x) => x.id === productId);
    if (!product) throw new Error('选的这个产品不存在');
    this.pending.delete(pendingId);
    return this._finish({
      product, method: 'manual', ocrText: p.ocrText, imagePath: p.imagePath,
      filename: p.filename, batchId: p.batchId, uploadedBy: p.uploadedBy || uploadedBy, warning: null
    });
  }

  async _finish({ product, method, ocrText, imagePath, filename, batchId, uploadedBy, warning }) {
    const { missingKeywords, crossedKeywords, status } = match.matchAgainstProduct(ocrText, product, this.products);
    const record = {
      id: 'mc_' + crypto.randomBytes(6).toString('hex'), batchId, timestamp: new Date().toISOString(), uploadedBy,
      filename, imagePath, productId: product.id, productName: product.name, matchMethod: method,
      ocrText, missingKeywords, crossedKeywords, status, warning
    };
    await this.append(record);
    return record;
  }
}

module.exports = { MaterialCheckStore };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd competitive-workbench && node materialcheck.test.js`
Expected: `33 passed, 0 failed` (corrected: 24 after Task 2 + 9 new store tests in this task)

- [ ] **Step 5: Commit**

```bash
cd competitive-workbench
git add materialcheck-store.js materialcheck.test.js
git commit -m "$(cat <<'EOF'
feat: 素材质检 store 模块（关键词库持久化 + 检测流水线 + 历史记录）
EOF
)"
```

---

### Task 4: Wire routes into `server.js`

**Files:**
- Modify: `competitive-workbench/server.js`

**Interfaces:**
- Consumes: `MaterialCheckStore` (Task 3), `materialcheck-ocr.js`'s `checkAvailable` (Task 1).
- Produces: five new HTTP routes under `/api/materialcheck/*` for later tasks (server wiring + frontend) to call.

- [ ] **Step 1: Add requires**

Find the require block near the top of `server.js` (around line 11, alongside `const { diffSummary } = require('./audit.js');`) and add:

```js
const { MaterialCheckStore } = require('./materialcheck-store.js');
const materialcheckOcr = require('./materialcheck-ocr.js');
```

- [ ] **Step 2: Add directory constants**

Find where `UPLOAD_DIR` is defined (around line 19, `const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');`) and add immediately after it:

```js
const MATERIALCHECK_DIR = path.join(DATA_DIR, 'materialcheck');
const MATERIALCHECK_UPLOAD_DIR = path.join(UPLOAD_DIR, 'materialcheck');
```

- [ ] **Step 3: Instantiate and load the store at boot**

Find where the other stores are instantiated (around lines 672-674, e.g. `const reviews = new ReviewStore(REVIEWS_DIR);`) and add:

```js
const materialcheck = new MaterialCheckStore(MATERIALCHECK_DIR, MATERIALCHECK_UPLOAD_DIR);
```

Find where the other stores are `.load()`ed at boot (around lines 682-683, e.g. `await reviews.load();`) and add:

```js
await materialcheck.load();
await materialcheckOcr.checkAvailable();
```

- [ ] **Step 4: Add the five routes**

Find the `/uploads/` static-file route (around line 660: `if (p.startsWith('/uploads/')) return serveStatic(res, UPLOAD_DIR, p.slice('/uploads/'.length), true);`) and insert the following block **immediately before it**:

```js
if (p === '/api/materialcheck/products' && req.method === 'GET') {
  return json(res, 200, { products: materialcheck.products, universalKeywords: materialcheck.universalKeywords });
}

if (p === '/api/materialcheck/products' && req.method === 'PUT') {
  if (!me.admin) return json(res, 403, { error: '只有管理员能改关键词库' });
  const { products, universalKeywords } = await body(req, 1024 * 1024);
  if (!Array.isArray(products) || !Array.isArray(universalKeywords)) return json(res, 400, { error: '数据格式不对' });
  let saved;
  try { saved = await materialcheck.saveProducts(products, universalKeywords); }
  catch (e) { return json(res, 400, { error: e.message }); }
  audit(me, 'materialcheck.products.update', { detail: [`关键词库已更新：${saved.products.length} 个产品，${saved.universalKeywords.length} 个通用词`] });
  return json(res, 200, saved);
}

if (p === '/api/materialcheck/upload' && req.method === 'POST') {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim();
  const ext = IMAGE_EXT[ct];
  if (!ext) return json(res, 415, { error: '只支持 PNG、JPG、WebP 三种格式' });
  const filename = decodeURIComponent(url.searchParams.get('filename') || ('upload' + ext));
  const batchId = url.searchParams.get('batchId') || ('b_' + crypto.randomBytes(6).toString('hex'));
  const buf = await readBinary(req, MAX_IMAGE);
  if (!buf.length) return json(res, 400, { error: '收到的是空文件' });
  let result;
  try { result = await materialcheck.detectFile({ buf, ext, filename, batchId, uploadedBy: me.name }); }
  catch (e) { return json(res, 400, { error: e.message }); }
  if (!result.needsManualPick) {
    const label = result.status === 'pass' ? '通过' : result.status === 'ocr_failed' ? '识别失败' : '不通过';
    audit(me, 'materialcheck.detect', { detail: [`${filename} · ${result.productName || ''} · ${label}`] });
  }
  return json(res, 200, result);
}

if (p === '/api/materialcheck/resolve' && req.method === 'POST') {
  const { pendingId, productId } = await body(req, 4096);
  if (!pendingId || !productId) return json(res, 400, { error: '缺少必要参数' });
  let result;
  try { result = await materialcheck.resolvePending(pendingId, productId, me.name); }
  catch (e) { return json(res, 400, { error: e.message }); }
  audit(me, 'materialcheck.detect', { detail: [`${result.filename} · ${result.productName} · 人工选择 · ${result.status === 'pass' ? '通过' : '不通过'}`] });
  return json(res, 200, result);
}

if (p === '/api/materialcheck/records' && req.method === 'GET') {
  const productId = url.searchParams.get('productId') || undefined;
  const status = url.searchParams.get('status') || undefined;
  const uploadedBy = url.searchParams.get('uploadedBy') || undefined;
  const limit = Math.min(2000, Number(url.searchParams.get('limit')) || 500);
  return json(res, 200, { records: materialcheck.listRecords({ productId, status, uploadedBy, limit }) });
}
```

- [ ] **Step 5: Manual verification — start the server and exercise the routes**

This codebase has no supertest-style HTTP test harness, and `server.js` cannot run standalone from the loose checkout (per CLAUDE.md — it needs `public/`, `merge.js`, `audit.js` alongside it). Extract the tarball to a scratch directory, overlay the loose files just changed, and run against that:

```bash
cd competitive-workbench
rm -rf /tmp/mc-smoke && mkdir -p /tmp/mc-smoke
tar xzf competitive-workbench.tar.gz -C /tmp/mc-smoke
cp server.js materialcheck-ocr.js materialcheck-match.js materialcheck-store.js /tmp/mc-smoke/competitive-workbench/
cd /tmp/mc-smoke/competitive-workbench
DATA_DIR=/tmp/mc-smoke/data ADMIN_USER=admin ADMIN_PIN=123456 PORT=8099 node server.js
```

Expected startup log includes either `[materialcheck] 载入 0 个产品，0 条历史记录` (store loaded) and, if `tesseract` isn't installed in this environment, the warning from `checkAvailable()` — both are expected and non-fatal.

In a second terminal, log in and exercise the new routes:

```bash
curl -s -c /tmp/mc-cookie -X POST http://localhost:8099/api/login -H 'Content-Type: application/json' -d '{"name":"admin","pin":"123456"}'

curl -s -b /tmp/mc-cookie http://localhost:8099/api/materialcheck/products
# Expected: {"products":[],"universalKeywords":[]}

curl -s -b /tmp/mc-cookie -X PUT http://localhost:8099/api/materialcheck/products -H 'Content-Type: application/json' \
  -d '{"products":[{"id":"pa","name":"GC-Multi","keywords":["GC-Multi","抗菌滤网认证号XXX"]}],"universalKeywords":["7天无理由退换"]}'
# Expected: 200 with the saved library echoed back

curl -s -b /tmp/mc-cookie -X PUT http://localhost:8099/api/materialcheck/products -H 'Content-Type: application/json' \
  -d '{"products":[{"id":"pa","name":"GC-Multi","keywords":["重复词"]},{"id":"pb","name":"B","keywords":["重复词"]}],"universalKeywords":[]}'
# Expected: 400 {"error":"关键词「重复词」重复出现在..."}

curl -s -b /tmp/mc-cookie http://localhost:8099/api/materialcheck/records
# Expected: {"records":[]}
```

Stop the server (`Ctrl+C`) once all four checks match. This confirms the route wiring, auth gate, and admin gate all work — image-upload-specific behavior (which needs a real image file and, ideally, a real `tesseract` binary) gets exercised end-to-end visually in Task 6's browser verification instead, once the frontend can drive it.

- [ ] **Step 6: Commit**

```bash
cd competitive-workbench
git add server.js
git commit -m "$(cat <<'EOF'
feat: 接入素材质检的后端路由（关键词库读写 + 上传检测 + 人工选择 + 历史查询）
EOF
)"
```

---

### Task 5: Wire the new tab shell into `index.html` / `core.js` / `settings.js`

**Files:**
- Modify: `competitive-workbench/index.html`
- Modify: `competitive-workbench/core.js`
- Modify: `competitive-workbench/settings.js`

**Interfaces:**
- Produces: a clickable, empty sixth tab (`data-view="materialcheck"`) that shows/hides correctly, has a working per-user visibility toggle, and calls `MaterialCheck.init(api)` once `materialcheck.js` exists (Task 6 fills in real content — this task's tab will show an empty view until then, which is fine to verify in isolation).

- [ ] **Step 1: Add the tab button**

In `index.html`, find the tab nav block (around line 30-37):

```html
    <button class="tab" role="tab" data-view="reports">报告管理</button>
    <i class="tab-ink" aria-hidden="true"></i>
```

Replace with:

```html
    <button class="tab" role="tab" data-view="reports">报告管理</button>
    <button class="tab" role="tab" data-view="materialcheck">素材质检</button>
    <i class="tab-ink" aria-hidden="true"></i>
```

- [ ] **Step 2: Add the view section**

In `index.html`, find the end of the 报告管理 view section (search for `data-view="reports"`, its closing `</section>` will be immediately followed by the next major HTML block — likely the hidden `<input>` elements or a comment banner for another section). Insert this new section immediately after that `</section>`:

```html
<!-- ══════════════ 视图六：素材质检 ══════════════ -->
<section class="view view-mc" id="view-materialcheck" data-view="materialcheck" data-theme-ready="true" hidden>
  <div class="canvas rv-canvas">
    <div class="rv-head rpt-head">
      <div>
        <h1>素材质检</h1>
        <p>Material Keyword Check · 文案关键词合规检测</p>
      </div>
      <div class="rv-head-tools">
        <div class="mc-subview-switch" id="mc-subview-switch">
          <button class="mc-subtab is-active" data-sub="check">检测台</button>
          <button class="mc-subtab" data-sub="history">历史记录</button>
          <button class="mc-subtab" data-sub="library" id="mc-tab-library" hidden>关键词库</button>
        </div>
      </div>
    </div>
    <div class="rv-scroll" id="mc-scroll">
      <div id="mc-check-view"></div>
      <div id="mc-history-view" hidden></div>
      <div id="mc-library-view" hidden></div>
    </div>
  </div>
</section>
```

- [ ] **Step 3: Add the hidden batch file input**

In `index.html`, find the hidden `<input type="file">` block (around lines 339-343):

```html
<input type="file" id="rpt-import-file" accept=".xlsx" hidden>
```

Add immediately after it:

```html
<input type="file" id="mc-file" accept="image/png,image/jpeg,image/webp" multiple hidden>
```

- [ ] **Step 4: Add the script tag**

In `index.html`, find the script block (around lines 390-404):

```html
<script src="/report.js"></script>
<script>App.boot();</script>
```

Replace with:

```html
<script src="/report.js"></script>
<script src="/materialcheck.js"></script>
<script>App.boot();</script>
```

- [ ] **Step 5: Update `core.js`'s `MODULES` array and hash-routing whitelist**

In `core.js`, find (line 6):

```js
const MODULES = ['matrix', 'compare', 'reviews', 'preview3d', 'reports'];
```

Replace with:

```js
const MODULES = ['matrix', 'compare', 'reviews', 'preview3d', 'reports', 'materialcheck'];
```

In `core.js`'s `boot()`, find (around line 613):

```js
let target = ['compare', 'reviews', 'preview3d', 'reports'].includes(hash) ? hash : 'matrix';
```

Replace with:

```js
let target = ['compare', 'reviews', 'preview3d', 'reports', 'materialcheck'].includes(hash) ? hash : 'matrix';
```

- [ ] **Step 6: Call `MaterialCheck.init(api)` in `boot()`**

In `core.js`'s `boot()`, find where other modules get initialized (e.g. `Reviews.init(api);` — grep for `.init(api)` calls to find the exact block) and add:

```js
MaterialCheck.init(api);
```

Add this line **after** `Reviews.init(api);`/`Report.init(api);` in whatever order those already appear — it must come after `core.js` has finished setting up `api` but the exact position relative to the other four `.init(api)` calls doesn't matter functionally, since each module only touches its own DOM subtree.

Note: this line will make `App.boot()` throw (`MaterialCheck is not defined`) until Task 6 creates `materialcheck.js`. There is no standalone verification pass for Task 5 — proceed directly to Task 6, and its Step 3 manual verification covers both tasks' wiring together (tab visibility, settings toggle, and actual tab content all get checked in one pass).

- [ ] **Step 7: Add the settings toggle**

In `settings.js`, find (around lines 12-18):

```js
const MODULES = [
  { key: 'matrix', label: '价格带沙盘' },
  { key: 'compare', label: '竞品对位' },
  { key: 'reviews', label: '评论风向标' },
  { key: 'preview3d', label: '竞品3D预览' },
  { key: 'reports', label: '报告管理' }
];
```

Replace with:

```js
const MODULES = [
  { key: 'matrix', label: '价格带沙盘' },
  { key: 'compare', label: '竞品对位' },
  { key: 'reviews', label: '评论风向标' },
  { key: 'preview3d', label: '竞品3D预览' },
  { key: 'reports', label: '报告管理' },
  { key: 'materialcheck', label: '素材质检' }
];
```

- [ ] **Step 8: Commit**

Since Step 6 references `MaterialCheck` which doesn't exist until Task 6, commit Tasks 5 and 6 together — **do not run this commit step now; skip straight to Task 6 and let its Step 4 commit cover both tasks' files.**

---

### Task 6: `materialcheck.js` — module skeleton + 检测台 (detection workbench)

**Files:**
- Create: `competitive-workbench/materialcheck.js`
- Modify: `competitive-workbench/styles.css`

**Interfaces:**
- Consumes: `A` (the shared `api` object from `core.js`, per Task 5's `MaterialCheck.init(api)` call) — specifically `A.$`, `A.$$`, `A.guard`, `A.toast`, `A.me`. Backend routes from Task 4 (`GET/PUT /api/materialcheck/products`, `POST /api/materialcheck/upload`, `POST /api/materialcheck/resolve`).
- Produces: `const MaterialCheck = { init(api) }` — the global module Task 5's `core.js` edit calls. Also produces the module-internal `products`/`universalKeywords` variables and `renderHistory()`/`renderLibrary()` function names (currently empty stubs) that Tasks 7/8 will fill in.

- [ ] **Step 1: Write `materialcheck.js`**

Create `competitive-workbench/materialcheck.js`:

```js
const MaterialCheck = (() => {
  let A, subView = 'check', products = [], universalKeywords = [];

  async function call(url, opts) {
    const r = A.guard(await fetch(url, opts));
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '请求失败');
    return j;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadProducts() {
    const j = await call('/api/materialcheck/products');
    products = j.products;
    universalKeywords = j.universalKeywords;
  }

  function switchSub(name) {
    subView = name;
    A.$$('#mc-subview-switch .mc-subtab').forEach((b) => b.classList.toggle('is-active', b.dataset.sub === name));
    A.$('#mc-check-view').hidden = name !== 'check';
    A.$('#mc-history-view').hidden = name !== 'history';
    A.$('#mc-library-view').hidden = name !== 'library';
    if (name === 'history') renderHistory();
    if (name === 'library') renderLibrary();
  }

  // ── 检测台 ──────────────────────────────────────────
  function renderCheckView() {
    const el = A.$('#mc-check-view');
    el.innerHTML = `
      <div class="mc-upload-zone" id="mc-upload-zone">点击选择图片，或把图片拖进这个区域（支持多选批量上传）</div>
      <div class="mc-batch-summary" id="mc-batch-summary"></div>
      <div id="mc-result-list"></div>`;
    A.$('#mc-upload-zone').onclick = () => A.$('#mc-file').click();
  }

  async function uploadFiles(fileList) {
    if (!products.length) return A.toast('先去「关键词库」配置至少一个产品', 'bad');
    const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const list = A.$('#mc-result-list');
    const summary = A.$('#mc-batch-summary');

    const rows = fileList.map((file) => {
      const row = document.createElement('div');
      row.className = 'mc-row mc-row-pending';
      row.innerHTML = `<span class="mc-row-name">${escapeHtml(file.name)}</span><span class="mc-row-status"><i class="mc-spin"></i> 识别中…</span>`;
      list.prepend(row);
      return { file, row };
    });

    let done = 0;
    const updateSummary = () => { summary.textContent = `本次上传 ${rows.length} 张 · 已完成 ${done} · 处理中 ${rows.length - done}`; };
    updateSummary();

    const CONCURRENCY = 3;
    let cursor = 0;
    async function worker() {
      while (cursor < rows.length) {
        const idx = cursor++;
        const { file, row } = rows[idx];
        try {
          const result = await call(`/api/materialcheck/upload?filename=${encodeURIComponent(file.name)}&batchId=${encodeURIComponent(batchId)}`, {
            method: 'POST',
            headers: { 'Content-Type': file.type },
            body: file
          });
          renderResult(row, result);
        } catch (e) {
          row.className = 'mc-row mc-row-error';
          row.querySelector('.mc-row-status').textContent = '上传失败：' + e.message;
        }
        done++; updateSummary();
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  }

  function renderResult(row, result) {
    if (result.needsManualPick) {
      row.className = 'mc-row mc-row-pick';
      const options = products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
      row.innerHTML = `
        <span class="mc-row-name">${escapeHtml(result.filename)}</span>
        <span class="mc-row-status">需要选择产品：
          <select class="mc-pick-select"><option value="">— 选择产品 —</option>${options}</select>
          <button class="mc-btn mc-btn-primary mc-pick-confirm">确定</button>
        </span>
        <details class="mc-row-ocr"><summary>查看识别文字</summary><pre>${escapeHtml(result.ocrText)}</pre></details>`;
      row.querySelector('.mc-pick-confirm').onclick = async () => {
        const productId = row.querySelector('.mc-pick-select').value;
        if (!productId) return A.toast('先选一个产品', 'bad');
        try {
          const resolved = await call('/api/materialcheck/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pendingId: result.pendingId, productId })
          });
          renderResult(row, resolved);
        } catch (e) { A.toast(e.message, 'bad'); }
      };
      return;
    }

    const ok = result.status === 'pass';
    const failed = result.status === 'ocr_failed';
    row.className = 'mc-row ' + (failed ? 'mc-row-error' : ok ? 'mc-row-ok' : 'mc-row-bad');
    const badge = failed ? '⚠ 识别失败' : ok ? '✓ 通过' : '✕ 不通过';
    const methodLabel = { filename: '文件名', ocr: 'OCR文字', manual: '人工选择' }[result.matchMethod] || '';

    let detail = '';
    if (result.missingKeywords?.length) {
      detail += `<div class="mc-chip-row">缺词：${result.missingKeywords.map((k) => `<span class="mc-chip mc-chip-bad">${escapeHtml(k)}</span>`).join('')}</div>`;
    }
    if (result.crossedKeywords?.length) {
      detail += `<div class="mc-chip-row">串词：${result.crossedKeywords.map((c) => `<span class="mc-chip mc-chip-bad">${escapeHtml(c.keyword)} · 属于「${escapeHtml(c.fromProductName)}」</span>`).join('')}</div>`;
    }
    if (result.warning) detail += `<div class="mc-warning">⚠ ${escapeHtml(result.warning)}</div>`;

    row.innerHTML = `
      <span class="mc-row-name">${escapeHtml(result.filename)}</span>
      <span class="mc-row-status">${badge} · ${escapeHtml(result.productName || '')}${methodLabel ? ' · 匹配方式：' + methodLabel : ''}</span>
      ${detail}`;
  }

  // ── 历史记录（Task 7 填充） ────────────────────────────
  async function renderHistory() {
    A.$('#mc-history-view').innerHTML = '<p class="rv-empty">开发中…</p>';
  }

  // ── 关键词库（Task 8 填充） ────────────────────────────
  async function renderLibrary() {
    A.$('#mc-library-view').innerHTML = '<p class="rv-empty">开发中…</p>';
  }

  function init(api) {
    A = api;
    A.$('#mc-tab-library').hidden = !A.me.admin;
    A.$$('#mc-subview-switch .mc-subtab').forEach((b) => (b.onclick = () => switchSub(b.dataset.sub)));
    A.$('#mc-file').onchange = (e) => { const files = [...e.target.files]; e.target.value = ''; if (files.length) uploadFiles(files); };

    renderCheckView();
    loadProducts().catch((e) => A.toast(e.message, 'bad'));

    const scroll = A.$('#mc-scroll');
    ['dragenter', 'dragover'].forEach((ev) => scroll.addEventListener(ev, (e) => { e.preventDefault(); scroll.classList.add('drop-hot'); }));
    ['dragleave', 'drop'].forEach((ev) => scroll.addEventListener(ev, () => scroll.classList.remove('drop-hot')));
    scroll.addEventListener('drop', (e) => {
      e.preventDefault();
      if (subView !== 'check') return;
      const files = [...e.dataTransfer.files].filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
      if (files.length) uploadFiles(files);
    });
  }

  return { init };
})();
```

- [ ] **Step 2: Add supporting CSS**

In `styles.css`, find the end of the 报告管理 section (search for the `/* ═══ ... ═══ */` banner comment before "移动端" around line 1909) and insert a new banner section immediately before it:

```css
/* ═══ 素材质检 (materialcheck) ═══ */
.mc-subview-switch { display: flex; gap: 6px; }
.mc-subtab { padding: 6px 14px; border-radius: 999px; border: 1px solid var(--line-soft); background: transparent; color: var(--dim); font-size: 12.5px; cursor: pointer; transition: background var(--fast), color var(--fast); }
.mc-subtab.is-active { background: var(--mint-dim); color: var(--mint); border-color: var(--mint); }

.mc-upload-zone { border: 2px dashed var(--line-soft); border-radius: 14px; padding: 40px; text-align: center; color: var(--dim); cursor: pointer; transition: border-color var(--fast); }
.mc-upload-zone:hover { border-color: var(--mint); }

.mc-batch-summary { margin: 14px 0; font-size: 13px; color: var(--dim); font-family: var(--f-mono); }

.mc-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--line-soft); margin-bottom: 8px; background: var(--surface); animation: rise 0.3s var(--ease) both; }
.mc-row-name { font-weight: 600; }
.mc-row-status { color: var(--dim); font-size: 12.5px; display: flex; align-items: center; gap: 6px; }
.mc-row-ok { border-color: var(--ok); }
.mc-row-ok .mc-row-status { color: var(--ok-text); }
.mc-row-bad { border-color: var(--bad); }
.mc-row-bad .mc-row-status { color: var(--bad-text); }
.mc-row-error { border-color: var(--warn); }
.mc-row-pick { border-color: var(--blue); }

.mc-spin { display: inline-block; width: 11px; height: 11px; border: 2px solid var(--line-soft); border-top-color: var(--mint); border-radius: 50%; animation: mc-spin 0.7s linear infinite; }
@keyframes mc-spin { to { transform: rotate(360deg); } }

.mc-chip-row { width: 100%; display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.mc-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 999px; background: var(--field-bg); font-size: 11.5px; }
.mc-chip-bad { background: var(--bad); color: #fff; }
.mc-chip i { cursor: pointer; opacity: 0.7; font-style: normal; }
.mc-chip i:hover { opacity: 1; }

.mc-warning { width: 100%; color: var(--warn-text); font-size: 12px; margin-top: 4px; }

.mc-row-ocr { width: 100%; margin-top: 6px; font-size: 12px; color: var(--dim); }
.mc-row-ocr pre { white-space: pre-wrap; background: var(--field-bg); padding: 10px; border-radius: 8px; margin-top: 6px; font-family: var(--f-mono); }

.mc-btn { padding: 7px 14px; border-radius: 8px; border: 1px solid var(--line-soft); background: transparent; color: var(--text); cursor: pointer; font-size: 12.5px; transition: background var(--fast); }
.mc-btn:hover { background: var(--surface-2); }
.mc-btn-primary { background: var(--mint); color: #04140f; border-color: var(--mint); font-weight: 600; }
.mc-btn-danger { color: var(--bad-text); border-color: var(--bad); }
```

- [ ] **Step 3: Manual verification**

```bash
cd /tmp/mc-smoke/competitive-workbench
cp /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench/index.html \
   /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench/core.js \
   /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench/settings.js \
   /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench/materialcheck.js \
   /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench/styles.css \
   public/
DATA_DIR=/tmp/mc-smoke/data ADMIN_USER=admin ADMIN_PIN=123456 PORT=8099 node server.js
```

Open `http://localhost:8099/login`, log in as `admin`/`123456`, then:
1. Confirm a "素材质检" tab appears in the top nav and is clickable, showing "检测台 / 历史记录 / 关键词库" sub-tabs (关键词库 visible since `admin` is an admin user).
2. Because no products are configured yet (Task 8 not built), the upload zone should reject uploads with a toast "先去「关键词库」配置至少一个产品" — confirm this happens by clicking the upload zone and picking any image.
3. Manually seed a product via curl (reusing Task 4's verification), then retry uploading a real image whose filename contains "GC-Multi" — confirm a result row appears, transitions from "识别中…" to a pass/fail badge (if `tesseract` isn't installed, expect the `ocr_failed` amber-bordered row instead — that's the expected behavior per Task 1's constraints, not a bug).
4. Open ⋯ → 功能显示设置, confirm "素材质检" appears as a 6th toggle and unchecking it hides the tab, rechecking restores it.

Stop the server once confirmed.

- [ ] **Step 4: Commit (covers Task 5 and Task 6 together)**

```bash
cd /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench
git add index.html core.js settings.js materialcheck.js styles.css
git commit -m "$(cat <<'EOF'
feat: 新增素材质检标签页（检测台批量上传 + 结果展示 + 人工选择产品）
EOF
)"
```

---

### Task 7: `materialcheck.js` — 历史记录 (history view)

**Files:**
- Modify: `competitive-workbench/materialcheck.js`
- Modify: `competitive-workbench/styles.css`

**Interfaces:**
- Consumes: `GET /api/materialcheck/records` (Task 4), the module-level `products`/`escapeHtml`/`call` from Task 6.
- Produces: a working `renderHistory()` replacing Task 6's stub, plus a `openHistoryDetail(record)` detail modal.

- [ ] **Step 1: Replace the `renderHistory` stub**

In `materialcheck.js`, replace:

```js
  // ── 历史记录（Task 7 填充） ────────────────────────────
  async function renderHistory() {
    A.$('#mc-history-view').innerHTML = '<p class="rv-empty">开发中…</p>';
  }
```

with:

```js
  // ── 历史记录 ────────────────────────────────────────
  let historyRows = [], detailMask, detailBody;

  async function renderHistory() {
    const el = A.$('#mc-history-view');
    el.innerHTML = '<p class="rv-empty">读取中…</p>';
    try {
      const j = await call('/api/materialcheck/records?limit=1000');
      historyRows = j.records;
    } catch (e) { el.innerHTML = ''; return A.toast(e.message, 'bad'); }

    el.innerHTML = `
      <div class="mc-filter-bar">
        <select id="mc-f-product"><option value="">全部产品</option>${products.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>
        <select id="mc-f-status"><option value="">全部状态</option><option value="pass">通过</option><option value="fail">不通过</option><option value="ocr_failed">识别失败</option></select>
      </div>
      <div class="mc-history-list" id="mc-history-list"></div>`;

    const draw = () => {
      const pf = A.$('#mc-f-product').value, sf = A.$('#mc-f-status').value;
      const shown = historyRows.filter((r) => (!pf || r.productId === pf) && (!sf || r.status === sf));
      const list = A.$('#mc-history-list');
      if (!shown.length) { list.innerHTML = '<p class="rv-empty">没有匹配的记录</p>'; return; }
      list.innerHTML = shown.map((r, i) => historyRowHtml(r, i)).join('');
      shown.forEach((r, i) => { list.querySelector(`[data-hi="${i}"]`).onclick = () => openHistoryDetail(r); });
    };
    A.$('#mc-f-product').onchange = draw;
    A.$('#mc-f-status').onchange = draw;
    draw();
  }

  function historyRowHtml(r, i) {
    const badge = r.status === 'pass' ? '✓ 通过' : r.status === 'ocr_failed' ? '⚠ 识别失败' : '✕ 不通过';
    const cls = r.status === 'pass' ? 'mc-row-ok' : r.status === 'ocr_failed' ? 'mc-row-error' : 'mc-row-bad';
    return `<div class="mc-history-row ${cls}" data-hi="${i}">
      <span class="mc-row-name">${escapeHtml(r.filename)}</span>
      <span class="mc-row-status">${badge} · ${escapeHtml(r.productName || '')} · ${new Date(r.timestamp).toLocaleString('zh-CN')} · ${escapeHtml(r.uploadedBy)}</span>
    </div>`;
  }

  function buildDetailSheet() {
    detailMask = document.createElement('div');
    detailMask.className = 'sheet-mask';
    detailMask.hidden = true;
    detailMask.innerHTML = `
      <div class="sheet sheet-wide" role="dialog">
        <div class="sheet-head"><h2>检测详情</h2><button class="kill" id="mc-detail-close" title="关闭">×</button></div>
        <div class="sheet-body" id="mc-detail-body"></div>
      </div>`;
    document.body.appendChild(detailMask);
    detailBody = detailMask.querySelector('#mc-detail-body');
    detailMask.querySelector('#mc-detail-close').onclick = () => (detailMask.hidden = true);
    detailMask.onclick = (e) => { if (e.target === detailMask) detailMask.hidden = true; };
  }

  function openHistoryDetail(r) {
    if (!detailMask) buildDetailSheet();
    let html = escapeHtml(r.ocrText || '（没有识别到文字）');
    (r.crossedKeywords || []).forEach((c) => {
      html = html.split(escapeHtml(c.keyword)).join(`<mark class="mc-mark-bad">${escapeHtml(c.keyword)}</mark>`);
    });
    const missing = (r.missingKeywords || []).map((k) => `<span class="mc-chip mc-chip-bad">${escapeHtml(k)}</span>`).join('') || '（无缺词）';
    const crossed = (r.crossedKeywords || []).map((c) => `<span class="mc-chip mc-chip-bad">${escapeHtml(c.keyword)} · 属于「${escapeHtml(c.fromProductName)}」</span>`).join('') || '（无串词）';
    detailBody.innerHTML = `
      <p><b>${escapeHtml(r.filename)}</b> · ${escapeHtml(r.productName || '')} · ${new Date(r.timestamp).toLocaleString('zh-CN')}</p>
      <div class="mc-chip-row"><b>缺词：</b>${missing}</div>
      <div class="mc-chip-row"><b>串词：</b>${crossed}</div>
      <pre class="mc-ocr-text">${html}</pre>`;
    detailMask.hidden = false;
  }
```

- [ ] **Step 2: Add supporting CSS**

In `styles.css`, append inside the `/* ═══ 素材质检 (materialcheck) ═══ */` section added in Task 6:

```css
.mc-filter-bar { display: flex; gap: 10px; margin-bottom: 16px; }
.mc-filter-bar select { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line-soft); background: var(--field-bg); color: var(--text); }

.mc-history-row { display: flex; flex-wrap: wrap; gap: 10px; padding: 10px 14px; border-radius: 10px; border: 1px solid var(--line-soft); margin-bottom: 6px; cursor: pointer; transition: background var(--fast); }
.mc-history-row:hover { background: var(--surface-2); }

.mc-ocr-text { white-space: pre-wrap; background: var(--field-bg); padding: 14px; border-radius: 10px; font-family: var(--f-mono); font-size: 12.5px; line-height: 1.6; max-height: 320px; overflow-y: auto; margin-top: 12px; }
.mc-mark-bad { background: var(--bad); color: #fff; padding: 0 2px; border-radius: 3px; }
```

- [ ] **Step 3: Manual verification**

```bash
cd /tmp/mc-smoke/competitive-workbench
cp /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench/materialcheck.js \
   /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench/styles.css \
   public/
DATA_DIR=/tmp/mc-smoke/data ADMIN_USER=admin ADMIN_PIN=123456 PORT=8099 node server.js
```

Open `http://localhost:8099`, go to 素材质检 → 历史记录. Confirm: records from Task 6's manual testing show up as rows; the two filter dropdowns (产品/状态) narrow the list; clicking a row opens a "检测详情" sheet with the OCR text, missing/crossed keyword chips, and (for any record with crossed keywords) the crossed keyword highlighted inline in the OCR text via a red `<mark>`. Confirm the sheet closes via the × button, clicking outside it, or Escape (Escape-to-close comes from `styles.css`'s existing `.sheet-mask` conventions — if it doesn't fire, that's expected since this task didn't wire a `keydown` listener; note it as a known gap rather than a bug, matching admin.js's pattern which does wire it — optionally add the same `document.addEventListener('keydown', ...)` from admin.js's `build()` if you want parity, but it's not required for this task's acceptance).

Stop the server once confirmed.

- [ ] **Step 4: Commit**

```bash
cd /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench
git add materialcheck.js styles.css
git commit -m "$(cat <<'EOF'
feat: 素材质检历史记录视图（按产品/状态过滤 + 详情高亮串词）
EOF
)"
```

---

### Task 8: `materialcheck.js` — 关键词库管理 (admin panel)

**Files:**
- Modify: `competitive-workbench/materialcheck.js`
- Modify: `competitive-workbench/styles.css`

**Interfaces:**
- Consumes: `PUT /api/materialcheck/products` (Task 4), module-level `products`/`universalKeywords` (Task 6, mutated in place then saved).
- Produces: a working `renderLibrary()` replacing Task 6's stub.

- [ ] **Step 1: Replace the `renderLibrary` stub**

In `materialcheck.js`, replace:

```js
  // ── 关键词库（Task 8 填充） ────────────────────────────
  async function renderLibrary() {
    A.$('#mc-library-view').innerHTML = '<p class="rv-empty">开发中…</p>';
  }
```

with:

```js
  // ── 关键词库 ────────────────────────────────────────
  async function renderLibrary() {
    const el = A.$('#mc-library-view');
    if (!A.me.admin) { el.innerHTML = '<p class="rv-empty">只有管理员能管理关键词库</p>'; return; }

    el.innerHTML = `
      <div class="mc-lib">
        <div class="mc-lib-products">
          <div class="mc-lib-head"><h3>产品</h3><button class="mc-btn" id="mc-add-product">+ 新增产品</button></div>
          <div id="mc-product-list"></div>
        </div>
        <div class="mc-lib-detail" id="mc-lib-detail"></div>
      </div>
      <div class="mc-universal">
        <h3>通用词（任何产品图上出现都不算问题）</h3>
        <div class="mc-chip-editor" id="mc-universal-chips"></div>
        <div class="mc-kw-add"><input placeholder="输入通用词，回车添加" id="mc-universal-input"><button class="mc-btn" id="mc-universal-add-btn">添加</button></div>
        <button class="mc-btn mc-btn-primary" id="mc-lib-save">保存关键词库</button>
        <p class="mc-lib-error" id="mc-lib-error" hidden></p>
      </div>`;

    let selected = products[0]?.id || null;

    const drawProductList = () => {
      A.$('#mc-product-list').innerHTML = products.map((p) => `
        <div class="mc-product-item ${p.id === selected ? 'is-active' : ''}" data-id="${p.id}">
          <span>${escapeHtml(p.name)}</span><small>${p.keywords.length} 词</small>
        </div>`).join('') || '<p class="rv-empty">还没有产品</p>';
      A.$$('#mc-product-list .mc-product-item').forEach((it) => {
        it.onclick = () => { selected = it.dataset.id; drawProductList(); drawDetail(); };
      });
    };

    const drawDetail = () => {
      const detail = A.$('#mc-lib-detail');
      const p = products.find((x) => x.id === selected);
      if (!p) { detail.innerHTML = '<p class="rv-empty">选一个产品</p>'; return; }
      detail.innerHTML = `
        <div class="mc-kw-editor">
          <label>产品名称 / 型号</label>
          <input class="mc-kw-name" value="${escapeHtml(p.name)}">
          <label>专属关键词</label>
          <div class="mc-chip-editor" id="mc-kw-chips"></div>
          <div class="mc-kw-add"><input placeholder="输入关键词，回车添加" id="mc-kw-input"><button class="mc-btn" id="mc-kw-add-btn">添加</button></div>
          <button class="mc-btn mc-btn-danger" id="mc-del-product">删除这个产品</button>
        </div>`;

      const drawChips = () => {
        A.$('#mc-kw-chips').innerHTML = p.keywords.map((k, i) => `<span class="mc-chip">${escapeHtml(k)}<i data-i="${i}">×</i></span>`).join('');
        A.$$('#mc-kw-chips i').forEach((x) => (x.onclick = () => { p.keywords.splice(Number(x.dataset.i), 1); drawChips(); drawProductList(); }));
      };
      drawChips();

      A.$('.mc-kw-name').oninput = (e) => { p.name = e.target.value; };

      const addKw = () => {
        const input = A.$('#mc-kw-input');
        const v = input.value.trim();
        if (!v) return;
        p.keywords.push(v); input.value = ''; drawChips(); drawProductList();
      };
      A.$('#mc-kw-add-btn').onclick = addKw;
      A.$('#mc-kw-input').onkeydown = (e) => { if (e.key === 'Enter') addKw(); };

      A.$('#mc-del-product').onclick = () => {
        products = products.filter((x) => x.id !== p.id);
        selected = products[0]?.id || null;
        drawProductList(); drawDetail();
      };
    };

    A.$('#mc-add-product').onclick = () => {
      const p = { id: 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2), name: '新产品', keywords: [] };
      products.push(p); selected = p.id; drawProductList(); drawDetail();
    };

    const drawUniversal = () => {
      A.$('#mc-universal-chips').innerHTML = universalKeywords.map((k, i) => `<span class="mc-chip">${escapeHtml(k)}<i data-i="${i}">×</i></span>`).join('');
      A.$$('#mc-universal-chips i').forEach((x) => (x.onclick = () => { universalKeywords.splice(Number(x.dataset.i), 1); drawUniversal(); }));
    };
    const addUniversal = () => {
      const input = A.$('#mc-universal-input');
      const v = input.value.trim();
      if (!v) return;
      universalKeywords.push(v); input.value = ''; drawUniversal();
    };
    A.$('#mc-universal-add-btn').onclick = addUniversal;
    A.$('#mc-universal-input').onkeydown = (e) => { if (e.key === 'Enter') addUniversal(); };

    A.$('#mc-lib-save').onclick = async () => {
      const errEl = A.$('#mc-lib-error');
      errEl.hidden = true;
      try {
        const saved = await call('/api/materialcheck/products', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ products, universalKeywords })
        });
        products = saved.products; universalKeywords = saved.universalKeywords;
        A.toast('关键词库已保存');
        drawProductList(); drawDetail(); drawUniversal();
      } catch (e) {
        errEl.hidden = false; errEl.textContent = e.message;
      }
    };

    drawProductList(); drawDetail(); drawUniversal();
  }
```

- [ ] **Step 2: Add supporting CSS**

In `styles.css`, append inside the `/* ═══ 素材质检 (materialcheck) ═══ */` section:

```css
.mc-lib { display: grid; grid-template-columns: 220px 1fr; gap: 24px; }
.mc-lib-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.mc-product-item { padding: 8px 10px; border-radius: 8px; cursor: pointer; display: flex; justify-content: space-between; font-size: 13px; }
.mc-product-item:hover { background: var(--surface-2); }
.mc-product-item.is-active { background: var(--mint-dim); color: var(--mint); }
.mc-product-item small { color: var(--dimmer); }

.mc-kw-editor label { display: block; margin: 14px 0 6px; font-size: 12px; color: var(--dim); }
.mc-kw-editor input, .mc-kw-add input { padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line-soft); background: var(--field-bg); color: var(--text); }
.mc-kw-add { display: flex; gap: 8px; margin-top: 8px; }
.mc-chip-editor { display: flex; flex-wrap: wrap; gap: 6px; min-height: 30px; }

.mc-universal { margin-top: 30px; padding-top: 20px; border-top: 1px solid var(--line-soft); }
.mc-lib-error { color: var(--bad-text); font-size: 12.5px; margin-top: 8px; }
```

- [ ] **Step 3: Manual verification**

```bash
cd /tmp/mc-smoke/competitive-workbench
cp /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench/materialcheck.js \
   /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench/styles.css \
   public/
DATA_DIR=/tmp/mc-smoke/data ADMIN_USER=admin ADMIN_PIN=123456 PORT=8099 node server.js
```

Open `http://localhost:8099`, go to 素材质检 → 关键词库. Confirm:
1. "+ 新增产品" adds a product to the left list; clicking it shows an editable name field and an empty keyword-chip editor on the right.
2. Typing a keyword and hitting Enter (or clicking 添加) adds a chip; clicking a chip's `×` removes it.
3. Adding a universal keyword works the same way in the 通用词 section at the bottom.
4. Clicking "保存关键词库" with two products sharing one keyword shows the inline error from `saveProducts`'s uniqueness check (e.g. give both products the keyword "测试词" and save) — confirm the red error text appears under the save button and the library is NOT silently corrupted (reload the page, confirm the pre-save state persisted, not the conflicting one).
5. Fix the conflict, save again, confirm the toast "关键词库已保存" appears and the change survives a page reload.
6. Log out and log in as a non-admin user (create one via 用户管理 if needed) — confirm the 关键词库 sub-tab is not visible at all.

Stop the server once confirmed.

- [ ] **Step 4: Commit**

```bash
cd /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench
git add materialcheck.js styles.css
git commit -m "$(cat <<'EOF'
feat: 素材质检关键词库管理面板（产品CRUD + 通用词 + 唯一性校验反馈）
EOF
)"
```

---

### Task 9: Deployment packaging — `install.sh`, `scripts/repack-tarball.sh`, tarball rebuild

**Files:**
- Modify: `competitive-workbench/install.sh`
- Modify: `competitive-workbench/scripts/repack-tarball.sh`
- Modify: `competitive-workbench/competitive-workbench.tar.gz` (regenerated binary)

**Interfaces:**
- Consumes: all files created/modified in Tasks 1–8.
- Produces: an installable deployment where `install.sh` provisions `tesseract-ocr`, copies the three new server files, and creates `materialcheck/`'s data directory; a tarball that matches the loose checkout byte-for-byte per file content.

- [ ] **Step 1: Add the apt step to `install.sh`**

In `install.sh`, find step 1 (Node install, ends around line 44) and step 2 (service user, starts around line 45 with `# ── 2. 专用用户`). Insert a new step between them, and renumber every subsequent step comment by one (`# ── 2. 专用用户` → `# ── 3. 专用用户`, and so on through whatever the file's last step number currently is):

```bash
# ── 2. OCR 引擎（tesseract） ─────────────────────────────
if command -v tesseract >/dev/null 2>&1; then
  info "tesseract 已就绪：$(tesseract --version 2>&1 | head -1)"
else
  info "安装 tesseract-ocr…"
  apt-get update -qq
  apt-get install -y -qq tesseract-ocr tesseract-ocr-chi-sim >/dev/null
  command -v tesseract >/dev/null 2>&1 || die "tesseract 安装失败，素材质检功能需要它才能跑"
  info "tesseract 安装完成：$(tesseract --version 2>&1 | head -1)"
fi
```

- [ ] **Step 2: Add the new files to `install.sh`'s copy-list**

Find the `for f in ...` loop (around line 56-61):

```bash
for f in server.js merge.js audit.js xlsx-lite.js reviews-nlp.js reviews-ingest.js reviews-store.js preview3d-store.js report-store.js; do
```

Replace with:

```bash
for f in server.js merge.js audit.js xlsx-lite.js reviews-nlp.js reviews-ingest.js reviews-store.js preview3d-store.js report-store.js materialcheck-ocr.js materialcheck-match.js materialcheck-store.js; do
```

- [ ] **Step 3: Add the new data directory to `install.sh`**

Find the data-directory creation line (around line 67):

```bash
mkdir -p "$DATA_DIR" "$DATA_DIR/reviews" "$DATA_DIR/products3d" "$DATA_DIR/reports"
```

Replace with:

```bash
mkdir -p "$DATA_DIR" "$DATA_DIR/reviews" "$DATA_DIR/products3d" "$DATA_DIR/reports" "$DATA_DIR/materialcheck" "$DATA_DIR/uploads/materialcheck"
```

- [ ] **Step 4: Update `scripts/repack-tarball.sh`'s manifests**

Find the first `cp` list (server-side files, around lines 22-24):

```bash
cp server.js xlsx-lite.js reviews-nlp.js reviews-ingest.js \
   reviews-store.js preview3d-store.js report-store.js install.sh README.md \
   "$WORK/competitive-workbench/"
```

Replace with:

```bash
cp server.js xlsx-lite.js reviews-nlp.js reviews-ingest.js \
   reviews-store.js preview3d-store.js report-store.js \
   materialcheck-ocr.js materialcheck-match.js materialcheck-store.js \
   install.sh README.md \
   "$WORK/competitive-workbench/"
```

Find the second `cp` list (frontend files, around lines 26-33):

```bash
cp index.html login.html core.js matrix.js compare.js reviews.js preview3d.js \
   preview3d-scene.js report.js admin.js users.js settings.js styles.css \
   echarts.min.js html2canvas.min.js iqair-logo.webp \
   three.module.min.js three-orbitcontrols.js three-effectcomposer.js \
   three-renderpass.js three-unrealbloompass.js three-outputpass.js \
   three-copyshader.js three-luminosityhighpassshader.js three-maskpass.js \
   three-pass.js three-shaderpass.js three-outputshader.js three-css2drenderer.js \
   "$WORK/competitive-workbench/public/"
```

Replace with:

```bash
cp index.html login.html core.js matrix.js compare.js reviews.js preview3d.js \
   preview3d-scene.js report.js admin.js users.js settings.js materialcheck.js styles.css \
   echarts.min.js html2canvas.min.js iqair-logo.webp \
   three.module.min.js three-orbitcontrols.js three-effectcomposer.js \
   three-renderpass.js three-unrealbloompass.js three-outputpass.js \
   three-copyshader.js three-luminosityhighpassshader.js three-maskpass.js \
   three-pass.js three-shaderpass.js three-outputshader.js three-css2drenderer.js \
   "$WORK/competitive-workbench/public/"
```

- [ ] **Step 5: Run the repack script and verify**

```bash
cd /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench
bash scripts/repack-tarball.sh
tar tzf competitive-workbench.tar.gz | grep -E 'materialcheck|install.sh'
```

Expected output includes:
```
competitive-workbench/materialcheck-ocr.js
competitive-workbench/materialcheck-match.js
competitive-workbench/materialcheck-store.js
competitive-workbench/install.sh
competitive-workbench/public/materialcheck.js
```

- [ ] **Step 6: Full-stack smoke test from the freshly repacked tarball**

This is the final end-to-end check — unpack the just-rebuilt tarball clean (no manual file copying, unlike Tasks 4/6/7/8's scratch-directory checks) and confirm the shipped artifact actually works:

```bash
rm -rf /tmp/mc-final && mkdir -p /tmp/mc-final
tar xzf competitive-workbench.tar.gz -C /tmp/mc-final
cd /tmp/mc-final/competitive-workbench
DATA_DIR=/tmp/mc-final/data ADMIN_USER=admin ADMIN_PIN=123456 PORT=8098 node server.js
```

Open `http://localhost:8098`, log in, and repeat a condensed version of Tasks 6-8's manual checks: add a product with keywords in 关键词库, upload a matching image in 检测台, confirm it appears in 历史记录. Stop the server once confirmed — this is the artifact that actually gets deployed per the repo's `design/deepspace-polish` → `EC-Workbench/Product` → `/opt/workbench` pipeline described in CLAUDE.md, so it's worth confirming it works from a clean unpack rather than trusting the incremental scratch-dir checks alone.

- [ ] **Step 7: Commit**

```bash
cd /root/IQAir-Project/test/.claude/worktrees/design-polish/competitive-workbench
git add install.sh scripts/repack-tarball.sh competitive-workbench.tar.gz
git commit -m "$(cat <<'EOF'
chore: 素材质检接入部署脚本（tesseract-ocr apt 安装 + 打包清单）+ 重新打包 tarball
EOF
)"
```

---

## Self-Review Notes

**Spec coverage** — every section of `docs/superpowers/specs/2026-07-21-material-keyword-check-design.md` maps to a task: pipeline (Tasks 1-3), data model (Task 3), backend API (Task 4), frontend UI's three sub-views (Tasks 6-8), error handling for OCR failure/library conflicts (built into Tasks 1/3's tests and Task 4's routes), test plan (Tasks 1-3's `materialcheck.test.js`, manual verification steps throughout), out-of-scope items (no CV product recognition, no fuzzy matching, no async job queue — none introduced anywhere in this plan).

**Type/interface consistency checked** — `resolveProductForUpload`'s return shape (`{method, product, ambiguous, candidates}`) is identical between its Task 2 definition and Task 3's `detectFile` usage; `matchAgainstProduct`'s `{missingKeywords, crossedKeywords, status}` shape is identical between Task 2's tests, Task 3's `_finish()`, and Task 6/7's frontend rendering of `result.missingKeywords`/`result.crossedKeywords`/`result.status`; the record shape (`id, batchId, timestamp, uploadedBy, filename, imagePath, productId, productName, matchMethod, ocrText, missingKeywords, crossedKeywords, status, warning`) is identical across Task 3's `_finish()`, Task 4's route responses, and Task 6/7's frontend consumption.

**No placeholders** — every step contains complete, runnable code or exact verification commands with expected output; no "add appropriate error handling" language anywhere.
