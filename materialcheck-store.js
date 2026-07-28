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
      return text ? { text, category: match.keywordCategory(k), ratio: match.keywordRatio(k) } : null;
    })
    .filter(Boolean);
}

/**
 * 零依赖的图片宽高探测（不引入 image-size/sharp 这类三方库，跟项目里 xlsx-lite.js
 * 手写解析的路子一致）：只认 PNG/JPEG/WebP 三种素材质检本来就限定的格式，
 * 解不出来（格式认不出/文件损坏）就返回 null，调用方按"探测不出比例"处理，
 * 不阻断流程。
 */
function sniffImageSize(buf) {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      const marker = buf[offset + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      if (marker === 0xd9) break;
      const segLen = buf.readUInt16BE(offset + 2);
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      offset += 2 + segLen;
    }
    return null;
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') return { width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) };
    if (fourcc === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** 像素尺寸粗分 1:1（近似正方形）/3:4（近似竖形海报），落在这两档之外（比如宽图、
 *  其它比例的裁切）就返回 null，不强行归类——只用来跟用户选的入口做交叉校验提醒。 */
function classifyRatioFromSize(size) {
  if (!size || !size.width || !size.height) return null;
  const r = size.width / size.height;
  if (r > 0.9 && r < 1.1112) return '1:1';
  if (r > 0.6 && r < 0.85) return '3:4';
  return null;
}

/** claimedRatio 是用户选的入口（1:1/3:4 两个上传按钮之一），跟素材实际像素比例
 *  对不上就给一条软提示——不拦截、不改判定用的比例，判定始终以入口选择为准。 */
function ratioMismatchWarning(claimedRatio, buf) {
  if (!claimedRatio) return null;
  const detected = classifyRatioFromSize(sniffImageSize(buf));
  if (!detected || detected === claimedRatio) return null;
  return `这张图看起来更像 ${detected} 比例的素材，不是选的 ${claimedRatio}，请确认传对了入口`;
}

function combineWarnings(...parts) {
  const list = parts.filter(Boolean);
  return list.length ? list.join('；') : null;
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
    price: (typeof p.price === 'number' && Number.isFinite(p.price)) ? p.price : null,
    // 只接受本站 /uploads/ 下的相对路径，跟 saveProducts 的校验保持一致
    imageUrl: (typeof p.imageUrl === 'string' && p.imageUrl.startsWith('/uploads/')) ? p.imageUrl : null
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

  /** 词库页展示用：给每个产品附上"最近一条已匹配到它的检测记录的图"，不落盘、只读时算——
   *  产品自己手动传的封面（imageUrl）优先级更高由前端判断，这里只负责兜底候选。 */
  withAutoImages(lib, platform, libraryId) {
    const latest = new Map();
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r.platform !== platform || r.libraryId !== libraryId || !r.productId) continue;
      if (!latest.has(r.productId)) latest.set(r.productId, r.imagePath);
    }
    return { ...lib, products: lib.products.map((p) => ({ ...p, autoImage: latest.get(p.id) || null })) };
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
      // 只接受本站 /uploads/ 下的相对路径，防止存进任意字符串当图片地址用
      const imageUrl = (typeof p.imageUrl === 'string' && p.imageUrl.startsWith('/uploads/')) ? p.imageUrl : null;
      return {
        id: p.id,
        name: String(p.name || '').trim(),
        type,
        keywords: cleanKeywords(p.keywords),
        price: Number.isFinite(price) && price > 0 ? price : null,
        imageUrl
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

  async detectFile({ buf, ext, filename, batchId, uploadedBy, platform, libraryId, ratio, ocr = runOcr }) {
    this._assertPlatform(platform);
    const lib = this.getLibrary(platform, libraryId);
    if (!lib) throw new Error('这套词库不存在，可能已经被删除，刷新页面重新选一套');
    if (!lib.products.length) throw new Error('还没有配置任何产品的关键词，先去「关键词库」里加一个产品');

    const claimedRatio = match.RATIOS.includes(ratio) ? ratio : null;

    const name = crypto.randomBytes(9).toString('hex') + ext;
    const imagePath = path.join(this.uploadDir, name);
    await fsp.writeFile(imagePath, buf);
    const url = '/uploads/materialcheck/' + name;
    const ratioMismatch = ratioMismatchWarning(claimedRatio, buf);

    let ocrText, ocrConfidence;
    try {
      const result = await this._runOcrQueued(imagePath, ocr);
      ocrText = result.text;
      ocrConfidence = result.confidence;
    } catch (e) {
      const record = {
        id: 'mc_' + crypto.randomBytes(6).toString('hex'), batchId, timestamp: new Date().toISOString(), uploadedBy, platform, libraryId: lib.id,
        filename, imagePath: url, productId: null, productName: null, matchMethod: null, ratio: claimedRatio,
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
        imagePath: url, filename, ocrText, ocrConfidence, batchId, uploadedBy, platform, libraryId: lib.id, ratio: claimedRatio, ratioMismatch, expiresAt: Date.now() + PENDING_TTL_MS
      });
      return { needsManualPick: true, pendingId, ocrText, filename, candidates: resolution.candidates, lowConfidence, ratioMismatch };
    }

    const warning = combineWarnings(
      resolution.method === 'filename' ? match.crossCheckWarning(resolution.product, ocrText, lib.products) : null,
      ratioMismatch
    );

    return this._finish({
      platform, libraryId: lib.id, product: resolution.product, allProducts: lib.products, method: resolution.method,
      ocrText, ocrConfidence, imagePath: url, filename, batchId, uploadedBy, warning, ratio: claimedRatio
    });
  }

  /**
   * 批量自动识别词库：只做"识别+分派+算候选词"，不写检测记录（这不是合规检测，是
   * 词库维护动作），也不直接改词库——候选词要经过前端的审核页面，人工确认后才会
   * 通过已有的 saveProducts（PUT /api/materialcheck/products）真正落盘。
   */
  async autobuildScan({ buf, ext, filename, platform, libraryId, ratio, ocr = runOcr }) {
    this._assertPlatform(platform);
    const lib = this.getLibrary(platform, libraryId);
    if (!lib) throw new Error('这套词库不存在，可能已经被删除，刷新页面重新选一套');
    if (!lib.products.length) throw new Error('还没有配置任何产品的关键词，先去「关键词库」里加一个产品');
    const claimedRatio = match.RATIOS.includes(ratio) ? ratio : null;

    const name = crypto.randomBytes(9).toString('hex') + ext;
    const imagePath = path.join(this.uploadDir, name);
    await fsp.writeFile(imagePath, buf);
    const url = '/uploads/materialcheck/' + name;
    const ratioMismatch = ratioMismatchWarning(claimedRatio, buf);

    const { text: ocrText, confidence: ocrConfidence } = await this._runOcrQueued(imagePath, ocr);
    const resolution = match.resolveProductForUpload(filename, ocrText, lib.products);

    if (!resolution.product) {
      return {
        filename, imagePath: url, ocrText, ocrConfidence, ratio: claimedRatio, ratioMismatch,
        productId: null, productName: null,
        candidateProducts: (resolution.candidates || []).map((p) => ({ id: p.id, name: p.name })),
        candidates: []
      };
    }

    return {
      filename, imagePath: url, ocrText, ocrConfidence, ratio: claimedRatio, ratioMismatch,
      productId: resolution.product.id, productName: resolution.product.name,
      candidateProducts: [],
      candidates: match.buildKeywordCandidates(ocrText, resolution.product)
    };
  }

  /** 批量识别时有些图判断不出产品，人工在审核页面里手动指定产品后，用这个补算候选词。 */
  autobuildCandidatesFor({ platform, libraryId, productId, ocrText }) {
    this._assertPlatform(platform);
    const lib = this.getLibrary(platform, libraryId);
    if (!lib) throw new Error('这套词库不存在，可能已经被删除，刷新页面重新选一套');
    const product = lib.products.find((p) => p.id === productId);
    if (!product) throw new Error('选的这个产品不存在');
    return match.buildKeywordCandidates(ocrText, product);
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
      imagePath: p.imagePath, filename: p.filename, batchId: p.batchId, uploadedBy: p.uploadedBy || uploadedBy, warning: p.ratioMismatch, ratio: p.ratio
    });
  }

  async _finish({ platform, libraryId, product, allProducts, method, ocrText, ocrConfidence, imagePath, filename, batchId, uploadedBy, warning, ratio }) {
    const { missingKeywords, extraKeywords, priceIssue, status } = match.matchAgainstProduct(ocrText, product, allProducts, ratio);
    const record = {
      id: 'mc_' + crypto.randomBytes(6).toString('hex'), batchId, timestamp: new Date().toISOString(), uploadedBy, platform, libraryId,
      filename, imagePath, productId: product.id, productName: product.name, matchMethod: method, ratio,
      ocrText, ocrConfidence, missingKeywords, extraKeywords, priceIssue, status, warning
    };
    await this.append(record);
    return record;
  }
}

module.exports = { MaterialCheckStore, PLATFORMS };
