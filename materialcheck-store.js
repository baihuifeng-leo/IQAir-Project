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

function emptyPlatform() {
  return { products: [], universalKeywords: [], machineSharedKeywords: [], filterSharedKeywords: [], accessorySharedKeywords: [] };
}

function normalizePlatformData(raw) {
  const r = raw || {};
  return {
    products: Array.isArray(r.products) ? r.products : [],
    universalKeywords: Array.isArray(r.universalKeywords) ? r.universalKeywords : [],
    machineSharedKeywords: Array.isArray(r.machineSharedKeywords) ? r.machineSharedKeywords : [],
    filterSharedKeywords: Array.isArray(r.filterSharedKeywords) ? r.filterSharedKeywords : [],
    accessorySharedKeywords: Array.isArray(r.accessorySharedKeywords) ? r.accessorySharedKeywords : []
  };
}

/**
 * 兼容两种磁盘格式：新的按平台命名空间 { tmall: {...}, jd: {...} }，
 * 或者旧版扁平结构 { products: [...], universalKeywords: [...] }（v2 上线前的数据）。
 * 旧格式一律整体归到天猫命名空间下，京东留空——这是一次性迁移，load() 随后立刻落盘，
 * 这样迁移只发生一次，之后磁盘上就是新格式了。
 */
function loadPlatforms(raw) {
  if (raw && (raw.tmall || raw.jd)) {
    return { tmall: normalizePlatformData(raw.tmall), jd: normalizePlatformData(raw.jd) };
  }
  if (raw && Array.isArray(raw.products)) {
    return { tmall: normalizePlatformData(raw), jd: emptyPlatform() };
  }
  return { tmall: emptyPlatform(), jd: emptyPlatform() };
}

function cleanKeywords(keywords) {
  return (keywords || [])
    .map((k) => {
      const text = String(match.keywordText(k)).trim();
      return text ? { text, category: match.keywordCategory(k) } : null;
    })
    .filter(Boolean);
}

function cleanStringList(list) {
  return (list || []).map((k) => String(match.keywordText(k)).trim()).filter(Boolean);
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
      migrated = !(raw && (raw.tmall || raw.jd)) && Array.isArray(raw && raw.products);
      this.platforms = loadPlatforms(raw);
    } catch { /* 首次运行，没有文件 */ }

    if (migrated) {
      await this._persistPlatforms();
      console.log('[materialcheck] 已把旧的扁平词库数据一次性迁移到「天猫」命名空间下');
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

    const total = PLATFORMS.reduce((n, p) => n + this.platforms[p].products.length, 0);
    console.log(`[materialcheck] 载入 ${total} 个产品，${this.records.length} 条历史记录`);
  }

  async _persistPlatforms() {
    await fsp.writeFile(this.productsFile, JSON.stringify(this.platforms, null, 1));
  }

  getLibrary(platform) {
    return this.platforms[platform] || emptyPlatform();
  }

  async saveProducts(platform, products, universalKeywords, sharedPools = {}) {
    if (!PLATFORMS.includes(platform)) throw new Error('平台参数不对，只能是 tmall 或 jd');
    if ((products || []).some((p) => !String(p.name || '').trim())) {
      throw new Error('产品名称不能为空');
    }
    const conflicts = match.validateLibrary(products, universalKeywords, sharedPools);
    if (conflicts.length) {
      const c = conflicts[0];
      throw new Error(`关键词「${c.keyword}」重复出现在「${c.first}」和「${c.second}」，一个词只能属于一处`);
    }
    const clean = {
      products: (products || []).map((p) => ({
        id: p.id,
        name: String(p.name || '').trim(),
        type: match.PRODUCT_TYPES.includes(p.type) ? p.type : '',
        keywords: cleanKeywords(p.keywords)
      })),
      universalKeywords: cleanStringList(universalKeywords),
      machineSharedKeywords: cleanStringList(sharedPools.machine),
      filterSharedKeywords: cleanStringList(sharedPools.filter),
      accessorySharedKeywords: cleanStringList(sharedPools.accessory)
    };
    this.platforms[platform] = clean;
    await this._persistPlatforms();
    return clean;
  }

  async append(record) {
    await fsp.appendFile(this.recordsFile, JSON.stringify(record) + '\n');
    this.records.push(record);
  }

  listRecords({ platform, productId, status, uploadedBy, limit = 500 } = {}) {
    let rows = this.records;
    if (platform) rows = rows.filter((r) => r.platform === platform);
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

  async detectFile({ buf, ext, filename, batchId, uploadedBy, platform, ocr = runOcr }) {
    if (!PLATFORMS.includes(platform)) throw new Error('平台参数不对，只能是 tmall 或 jd');
    const lib = this.getLibrary(platform);
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
        id: 'mc_' + crypto.randomBytes(6).toString('hex'), batchId, timestamp: new Date().toISOString(), uploadedBy, platform,
        filename, imagePath: url, productId: null, productName: null, matchMethod: null,
        ocrText: '', ocrConfidence: null, missingKeywords: [], crossedKeywords: [], status: 'ocr_failed', warning: e.message
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
        imagePath: url, filename, ocrText, ocrConfidence, batchId, uploadedBy, platform, expiresAt: Date.now() + PENDING_TTL_MS
      });
      return { needsManualPick: true, pendingId, ocrText, filename, candidates: resolution.candidates, lowConfidence };
    }

    const warning = resolution.method === 'filename'
      ? match.crossCheckWarning(resolution.product, ocrText, lib.products)
      : null;

    return this._finish({
      platform, product: resolution.product, allProducts: lib.products, method: resolution.method,
      ocrText, ocrConfidence, imagePath: url, filename, batchId, uploadedBy, warning
    });
  }

  async resolvePending(pendingId, productId, uploadedBy) {
    this._cleanupPending();
    const p = this.pending.get(pendingId);
    if (!p) throw new Error('这次待选择已经过期了，重新上传这张图');
    const lib = this.getLibrary(p.platform);
    const product = lib.products.find((x) => x.id === productId);
    if (!product) throw new Error('选的这个产品不存在');
    this.pending.delete(pendingId);
    return this._finish({
      platform: p.platform, product, allProducts: lib.products, method: 'manual', ocrText: p.ocrText, ocrConfidence: p.ocrConfidence,
      imagePath: p.imagePath, filename: p.filename, batchId: p.batchId, uploadedBy: p.uploadedBy || uploadedBy, warning: null
    });
  }

  async _finish({ platform, product, allProducts, method, ocrText, ocrConfidence, imagePath, filename, batchId, uploadedBy, warning }) {
    const { missingKeywords, crossedKeywords, status } = match.matchAgainstProduct(ocrText, product, allProducts);
    const record = {
      id: 'mc_' + crypto.randomBytes(6).toString('hex'), batchId, timestamp: new Date().toISOString(), uploadedBy, platform,
      filename, imagePath, productId: product.id, productName: product.name, matchMethod: method,
      ocrText, ocrConfidence, missingKeywords, crossedKeywords, status, warning
    };
    await this.append(record);
    return record;
  }
}

module.exports = { MaterialCheckStore, PLATFORMS };
