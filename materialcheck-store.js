'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const match = require('./materialcheck-match.js');
const { runOcr } = require('./materialcheck-ocr.js');

const PENDING_TTL_MS = 30 * 60 * 1000;
// PaddleOCR 给每行识别结果打分，这是整张图（过滤噪声后剩下的行）的平均置信度
// 低于这个数就当"识别本身不可靠"处理，跟"文件名/OCR 都判断不出产品"走同一套
// 转人工核对的流程，而不是拿一份不可靠的文字去判定缺词/串词，可能把好素材冤枉了。
const OVERALL_MIN_CONFIDENCE = 0.7;

const PLATFORMS = ['tmall', 'jd'];
const DEFAULT_LIBRARY_NAME = '默认词库';

function makeLibraryId() {
  return 'lib_' + crypto.randomBytes(6).toString('hex');
}

function cleanKeywords(keywords) {
  return (keywords || [])
    .map((k) => {
      const text = String(match.keywordText(k)).trim();
      return text ? { text, category: match.keywordCategory(k) } : null;
    })
    .filter(Boolean);
}

function emptyLibrary(name) {
  return { id: makeLibraryId(), name, products: [] };
}

function emptyPlatform() {
  return { libraries: [emptyLibrary(DEFAULT_LIBRARY_NAME)] };
}

/** 产品与关键词强绑定，每个产品自己一份完整清单（不再有分组/全局通用词这层）。
 *  兼容磁盘上仍是旧结构（带 groups/universalKeywords/groupIds）的情况：这里只按
 *  当前格式读 products 自己的 keywords，旧结构里分组/通用词的内容不会自动带过来——
 *  那部分内容需要用一次性脚本先下沉到各个产品自己的 keywords 里，再读这份文件。 */
function normalizeLibrary(raw) {
  const r = raw || {};
  const products = (Array.isArray(r.products) ? r.products : []).map((p) => ({
    id: p.id, name: p.name, type: p.type,
    keywords: Array.isArray(p.keywords) ? p.keywords : [],
    // 没配置过预期价格的产品（老数据/还没填的产品）就是 null，不参与价格校验
    price: (typeof p.price === 'number' && Number.isFinite(p.price)) ? p.price : null
  }));
  return { id: String(r.id || makeLibraryId()), name: String(r.name || '未命名词库'), products };
}

/**
 * 兼容三种磁盘格式（从新到旧）：
 * 1. 当前的多词库结构 { libraries: [{id,name,products,...}, ...] }
 * 2. v2 的单词库结构（没有 libraries 数组，字段直接铺在平台下） { products: [...], universalKeywords: [...] }
 * 3. v1 更早的扁平结构，整个 raw 就是一个平台的数据（那时候还没有 tmall/jd 概念）
 * 旧格式一律包成一套叫「默认词库」的库——这是一次性迁移，load() 随后立刻落盘，
 * 这样迁移只发生一次，之后磁盘上就是当前格式了。
 */
function normalizePlatformData(raw) {
  const r = raw || {};
  if (Array.isArray(r.libraries) && r.libraries.length) {
    return { libraries: r.libraries.map(normalizeLibrary) };
  }
  if (Array.isArray(r.products)) {
    return { libraries: [normalizeLibrary({ ...r, name: DEFAULT_LIBRARY_NAME })] };
  }
  return emptyPlatform();
}

function loadPlatforms(raw) {
  if (raw && (raw.tmall || raw.jd)) {
    return { tmall: normalizePlatformData(raw.tmall), jd: normalizePlatformData(raw.jd) };
  }
  if (raw && Array.isArray(raw.products)) {
    return { tmall: normalizePlatformData(raw), jd: emptyPlatform() };
  }
  return { tmall: emptyPlatform(), jd: emptyPlatform() };
}

/** 读到的磁盘数据里，只要有一个平台还没有 libraries 包装，就说明是还没升级到多词库结构的老格式。 */
function detectsLegacyFormat(raw) {
  if (!raw) return false;
  const platformIsCurrent = (p) => p && Array.isArray(p.libraries);
  if (raw.tmall || raw.jd) return !(platformIsCurrent(raw.tmall) && platformIsCurrent(raw.jd));
  return true; // 连 tmall/jd 命名空间都没有，是最老的扁平格式
}

class MaterialCheckStore {
  constructor(dir, uploadDir, { ocrConcurrency = 2 } = {}) {
    this.dir = dir;
    this.uploadDir = uploadDir;
    this.productsFile = path.join(dir, 'products.json');
    this.recordsFile = path.join(dir, 'records.jsonl');
    this.platforms = { tmall: emptyPlatform(), jd: emptyPlatform() };
    this.records = [];
    this.pending = new Map();
    // 服务端并发队列：单台 VM 是单进程 Node，OCR 是 CPU 密集操作，
    // 这里跨所有请求、所有用户地限制同时在跑的 OCR 进程数，
    // 避免一次性起太多进程拖垮机器（见设计文档「技术前提与约束」）。
    // 防御式下限：并发数配成 0 或负数会让队列永远排不空（第一个任务
    // 排进队列后再没有任何东西触发 drain），静默卡死整条检测流水线。
    this._ocrConcurrency = Math.max(1, ocrConcurrency);
    this._ocrActive = 0;
    this._ocrQueue = [];
  }

  _runOcrQueued(imagePath, ocr) {
    return new Promise((resolve, reject) => {
      const task = () => {
        this._ocrActive++;
        ocr(imagePath)
          .then(resolve, reject)
          .finally(() => {
            this._ocrActive--;
            this._drainOcrQueue();
          });
      };
      if (this._ocrActive < this._ocrConcurrency) task();
      else this._ocrQueue.push(task);
    });
  }

  _drainOcrQueue() {
    while (this._ocrActive < this._ocrConcurrency && this._ocrQueue.length) {
      this._ocrQueue.shift()();
    }
  }

  async load() {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.mkdir(this.uploadDir, { recursive: true });

    let migrated = false;
    try {
      const raw = JSON.parse(await fsp.readFile(this.productsFile, 'utf8'));
      migrated = detectsLegacyFormat(raw);
      this.platforms = loadPlatforms(raw);
    } catch { /* 首次运行，没有文件 */ }

    if (migrated) {
      await this._persistPlatforms();
      console.log('[materialcheck] 已把旧版词库数据迁移为多词库结构（归入「默认词库」）');
    }

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

    const total = PLATFORMS.reduce((n, p) => n + this.platforms[p].libraries.reduce((m, l) => m + l.products.length, 0), 0);
    console.log(`[materialcheck] 载入 ${total} 个产品，${this.records.length} 条历史记录`);
  }

  async _persistPlatforms() {
    await fsp.writeFile(this.productsFile, JSON.stringify(this.platforms, null, 1));
  }

  _assertPlatform(platform) {
    if (!PLATFORMS.includes(platform)) throw new Error('平台参数不对，只能是 tmall 或 jd');
  }

  listLibraries(platform) {
    this._assertPlatform(platform);
    return this.platforms[platform].libraries.map((l) => ({ id: l.id, name: l.name, productCount: l.products.length }));
  }

  getLibrary(platform, libraryId) {
    const p = this.platforms[platform];
    if (!p) return null;
    if (!libraryId) return p.libraries[0] || null;
    return p.libraries.find((l) => l.id === libraryId) || null;
  }

  _findLibraryIndex(platform, libraryId) {
    const idx = this.platforms[platform].libraries.findIndex((l) => l.id === libraryId);
    if (idx === -1) throw new Error('这套词库不存在，可能已经被删除，刷新页面重新选一套');
    return idx;
  }

  _assertUniqueName(platform, name, excludeId) {
    const clash = this.platforms[platform].libraries.some((l) => l.id !== excludeId && l.name === name);
    if (clash) throw new Error(`「${name}」这个名字在这个平台下已经用过了，换一个名字`);
  }

  async createLibrary(platform, name) {
    this._assertPlatform(platform);
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('词库名称不能为空');
    this._assertUniqueName(platform, trimmed, null);
    const lib = emptyLibrary(trimmed);
    this.platforms[platform].libraries.push(lib);
    await this._persistPlatforms();
    return lib;
  }

  async copyLibrary(platform, sourceLibraryId, name) {
    this._assertPlatform(platform);
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('词库名称不能为空');
    const idx = this._findLibraryIndex(platform, sourceLibraryId);
    this._assertUniqueName(platform, trimmed, null);
    const src = this.platforms[platform].libraries[idx];
    const lib = {
      id: makeLibraryId(),
      name: trimmed,
      products: JSON.parse(JSON.stringify(src.products))
    };
    this.platforms[platform].libraries.push(lib);
    await this._persistPlatforms();
    return lib;
  }

  async renameLibrary(platform, libraryId, name) {
    this._assertPlatform(platform);
    const trimmed = String(name || '').trim();
    if (!trimmed) throw new Error('词库名称不能为空');
    const idx = this._findLibraryIndex(platform, libraryId);
    this._assertUniqueName(platform, trimmed, libraryId);
    this.platforms[platform].libraries[idx].name = trimmed;
    await this._persistPlatforms();
    return this.platforms[platform].libraries[idx];
  }

  async deleteLibrary(platform, libraryId) {
    this._assertPlatform(platform);
    const libs = this.platforms[platform].libraries;
    const idx = this._findLibraryIndex(platform, libraryId);
    if (libs.length <= 1) throw new Error('这个平台下至少要保留一套词库，不能把最后一套也删掉');
    libs.splice(idx, 1);
    await this._persistPlatforms();
  }

  async saveProducts(platform, libraryId, products) {
    this._assertPlatform(platform);
    const idx = this._findLibraryIndex(platform, libraryId);
    if ((products || []).some((p) => !String(p.name || '').trim())) {
      throw new Error('产品名称不能为空');
    }
    const cleanProducts = (products || []).map((p) => {
      const type = match.PRODUCT_TYPES.includes(p.type) ? p.type : '';
      const price = (p.price === '' || p.price == null) ? null : Number(p.price);
      return {
        id: p.id,
        name: String(p.name || '').trim(),
        type,
        keywords: cleanKeywords(p.keywords),
        price: Number.isFinite(price) && price > 0 ? price : null
      };
    });

    const clean = {
      id: libraryId,
      name: this.platforms[platform].libraries[idx].name,
      products: cleanProducts
    };
    this.platforms[platform].libraries[idx] = clean;
    await this._persistPlatforms();
    return clean;
  }

  async append(record) {
    await fsp.appendFile(this.recordsFile, JSON.stringify(record) + '\n');
    this.records.push(record);
  }

  listRecords({ platform, libraryId, productId, status, uploadedBy, limit = 500 } = {}) {
    let rows = this.records;
    if (platform) rows = rows.filter((r) => r.platform === platform);
    if (libraryId) rows = rows.filter((r) => r.libraryId === libraryId);
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

  async detectFile({ buf, ext, filename, batchId, uploadedBy, platform, libraryId, ocr = runOcr }) {
    this._assertPlatform(platform);
    const lib = this.getLibrary(platform, libraryId);
    if (!lib) throw new Error('这套词库不存在，可能已经被删除，刷新页面重新选一套');
    if (!lib.products.length) throw new Error('还没有配置任何产品的关键词，先去「关键词库」里加一个产品');

    const name = crypto.randomBytes(9).toString('hex') + ext;
    const imagePath = path.join(this.uploadDir, name);
    await fsp.writeFile(imagePath, buf);
    const url = '/uploads/materialcheck/' + name;

    let ocrText, ocrConfidence;
    try {
      const result = await this._runOcrQueued(imagePath, ocr);
      ocrText = result.text;
      ocrConfidence = result.confidence;
    } catch (e) {
      const record = {
        id: 'mc_' + crypto.randomBytes(6).toString('hex'), batchId, timestamp: new Date().toISOString(), uploadedBy, platform, libraryId: lib.id,
        filename, imagePath: url, productId: null, productName: null, matchMethod: null,
        ocrText: '', ocrConfidence: null, missingKeywords: [], extraKeywords: [], status: 'ocr_failed', warning: e.message
      };
      await this.append(record);
      return record;
    }

    const lowConfidence = ocrConfidence < OVERALL_MIN_CONFIDENCE;
    const resolution = lowConfidence
      ? { product: null, candidates: [] }
      : match.resolveProductForUpload(filename, ocrText, lib.products);

    if (!resolution.product) {
      this._cleanupPending();
      const pendingId = 'mcp_' + crypto.randomBytes(6).toString('hex');
      this.pending.set(pendingId, {
        imagePath: url, filename, ocrText, ocrConfidence, batchId, uploadedBy, platform, libraryId: lib.id, expiresAt: Date.now() + PENDING_TTL_MS
      });
      return { needsManualPick: true, pendingId, ocrText, filename, candidates: resolution.candidates, lowConfidence };
    }

    const warning = resolution.method === 'filename'
      ? match.crossCheckWarning(resolution.product, ocrText, lib.products)
      : null;

    return this._finish({
      platform, libraryId: lib.id, product: resolution.product, allProducts: lib.products, method: resolution.method,
      ocrText, ocrConfidence, imagePath: url, filename, batchId, uploadedBy, warning
    });
  }

  async resolvePending(pendingId, productId, uploadedBy) {
    this._cleanupPending();
    const p = this.pending.get(pendingId);
    if (!p) throw new Error('这次待选择已经过期了，重新上传这张图');
    const lib = this.getLibrary(p.platform, p.libraryId);
    if (!lib) throw new Error('这套词库不存在，可能已经被删除，刷新页面重新选一套');
    const product = lib.products.find((x) => x.id === productId);
    if (!product) throw new Error('选的这个产品不存在');
    this.pending.delete(pendingId);
    return this._finish({
      platform: p.platform, libraryId: lib.id, product, allProducts: lib.products, method: 'manual', ocrText: p.ocrText, ocrConfidence: p.ocrConfidence,
      imagePath: p.imagePath, filename: p.filename, batchId: p.batchId, uploadedBy: p.uploadedBy || uploadedBy, warning: null
    });
  }

  async _finish({ platform, libraryId, product, allProducts, method, ocrText, ocrConfidence, imagePath, filename, batchId, uploadedBy, warning }) {
    const { missingKeywords, extraKeywords, priceIssue, status } = match.matchAgainstProduct(ocrText, product, allProducts);
    const record = {
      id: 'mc_' + crypto.randomBytes(6).toString('hex'), batchId, timestamp: new Date().toISOString(), uploadedBy, platform, libraryId,
      filename, imagePath, productId: product.id, productName: product.name, matchMethod: method,
      ocrText, ocrConfidence, missingKeywords, extraKeywords, priceIssue, status, warning
    };
    await this.append(record);
    return record;
  }
}

module.exports = { MaterialCheckStore, PLATFORMS };
