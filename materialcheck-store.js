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
const TYPE_LABEL = { machine: '机器', filter: '滤芯', accessory: '附件' };

function makeLibraryId() {
  return 'lib_' + crypto.randomBytes(6).toString('hex');
}

function makeGroupId() {
  return 'grp_' + crypto.randomBytes(6).toString('hex');
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
  return {
    id: makeLibraryId(), name,
    products: [], universalKeywords: [], groups: []
  };
}

function emptyPlatform() {
  return { libraries: [emptyLibrary(DEFAULT_LIBRARY_NAME)] };
}

/**
 * 磁盘上的库如果还没有 groups 数组，说明是"机器/滤芯/附件三套固定组内通用词"的旧结构。
 * 旧结构里这三套通用词是整库共享、不区分具体是哪几个产品在共用的，所以迁移策略是：
 * 每一套非空的旧通用词，自动建一个包含"该类型下所有产品"的分组，原样保留旧的共享效果——
 * 迁移后这些产品事实上还是互相共享这些词，用户可以在页面上再手动拆分成更细的分组。
 */
function migrateLegacyGroups(r, products) {
  const groups = [];
  match.PRODUCT_TYPES.forEach((type) => {
    const legacyWords = Array.isArray(r[type + 'SharedKeywords']) ? r[type + 'SharedKeywords'] : [];
    if (!legacyWords.length) return;
    const gid = makeGroupId();
    groups.push({ id: gid, name: `${TYPE_LABEL[type]}组通用词（迁移前）`, type, keywords: legacyWords });
    products.forEach((p) => { if (p.type === type) p.groupIds.push(gid); });
  });
  return groups;
}

/** 兼容老的单分组字段 groupId（string|null）——现在一个产品可以同时属于多个分组，
 *  所以磁盘/前端传来的可能是老的 groupId，也可能是新的 groupIds 数组，统一成数组。 */
function normalizeGroupIds(p) {
  if (Array.isArray(p && p.groupIds)) return p.groupIds.filter((id) => typeof id === 'string' && id);
  if (p && p.groupId) return [p.groupId];
  return [];
}

function normalizeLibrary(raw) {
  const r = raw || {};
  const hasGroups = Array.isArray(r.groups);
  const products = (Array.isArray(r.products) ? r.products : []).map((p) => ({
    id: p.id, name: p.name, type: p.type,
    groupIds: hasGroups ? normalizeGroupIds(p) : [],
    keywords: Array.isArray(p.keywords) ? p.keywords : [],
    // 没配置过预期价格的产品（老数据/还没填的产品）就是 null，不参与价格校验
    price: (typeof p.price === 'number' && Number.isFinite(p.price)) ? p.price : null
  }));
  const groups = hasGroups
    ? r.groups.map((g) => ({
      id: String((g && g.id) || makeGroupId()),
      name: String((g && g.name) || '未命名分组'),
      type: match.PRODUCT_TYPES.includes(g && g.type) ? g.type : 'machine',
      keywords: Array.isArray(g && g.keywords) ? g.keywords : []
    }))
    : migrateLegacyGroups(r, products);
  return {
    id: String(r.id || makeLibraryId()),
    name: String(r.name || '未命名词库'),
    products,
    universalKeywords: Array.isArray(r.universalKeywords) ? r.universalKeywords : [],
    groups
  };
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

/** 读到的磁盘数据里，只要有一个库还不是当前格式（没有 libraries 包装，或者库里没有 groups 数组），就说明发生了迁移。 */
function detectsLegacyFormat(raw) {
  if (!raw) return false;
  const libraryIsCurrent = (l) => l && Array.isArray(l.groups);
  const platformIsCurrent = (p) => p && Array.isArray(p.libraries) && p.libraries.every(libraryIsCurrent);
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
      products: JSON.parse(JSON.stringify(src.products)),
      universalKeywords: JSON.parse(JSON.stringify(src.universalKeywords)),
      groups: JSON.parse(JSON.stringify(src.groups))
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

  async saveProducts(platform, libraryId, products, universalKeywords, groups = []) {
    this._assertPlatform(platform);
    const idx = this._findLibraryIndex(platform, libraryId);
    if ((products || []).some((p) => !String(p.name || '').trim())) {
      throw new Error('产品名称不能为空');
    }
    const cleanGroups = (groups || [])
      .map((g) => {
        const name = String((g && g.name) || '').trim();
        const type = g && g.type;
        if (!name || !match.PRODUCT_TYPES.includes(type)) return null;
        return { id: String((g && g.id) || makeGroupId()), name, type, keywords: cleanKeywords(g && g.keywords) };
      })
      .filter(Boolean);
    const dupGroup = cleanGroups.find((g, i) => cleanGroups.some((g2, j) => j !== i && g2.type === g.type && g2.name === g.name));
    if (dupGroup) throw new Error(`分组名「${dupGroup.name}」在同一个类型下重复了，换个名字`);

    const groupById = new Map(cleanGroups.map((g) => [g.id, g]));
    const cleanProducts = (products || []).map((p) => {
      const type = match.PRODUCT_TYPES.includes(p.type) ? p.type : '';
      // 分组的类型必须跟产品自己的类型一致，否则视为没这个分组——正常操作下前端不会产出这种数据，这里只是兜底；
      // 一个产品现在可以同时属于多个分组（比如"机器通用"+"瑞士制造机型"两个分组的共享词都要求）
      const groupIds = normalizeGroupIds(p).filter((gid) => {
        const group = groupById.get(gid);
        return group && group.type === type;
      });
      const price = (p.price === '' || p.price == null) ? null : Number(p.price);
      return {
        id: p.id,
        name: String(p.name || '').trim(),
        type,
        groupIds,
        keywords: cleanKeywords(p.keywords),
        price: Number.isFinite(price) && price > 0 ? price : null
      };
    });

    const conflicts = match.validateLibrary(cleanProducts, universalKeywords, cleanGroups);
    if (conflicts.length) {
      const c = conflicts[0];
      throw new Error(`关键词「${c.keyword}」重复出现在「${c.first}」和「${c.second}」，一个词只能属于一处`);
    }
    const clean = {
      id: libraryId,
      name: this.platforms[platform].libraries[idx].name,
      products: cleanProducts,
      universalKeywords: cleanKeywords(universalKeywords),
      groups: cleanGroups
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
        imagePath: url, filename, ocrText, ocrConfidence, batchId, uploadedBy, platform, libraryId: lib.id, expiresAt: Date.now() + PENDING_TTL_MS
      });
      return { needsManualPick: true, pendingId, ocrText, filename, candidates: resolution.candidates, lowConfidence };
    }

    const warning = resolution.method === 'filename'
      ? match.crossCheckWarning(resolution.product, ocrText, lib.products)
      : null;

    return this._finish({
      platform, libraryId: lib.id, product: resolution.product, allProducts: lib.products, groups: lib.groups, universalKeywords: lib.universalKeywords, method: resolution.method,
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
      platform: p.platform, libraryId: lib.id, product, allProducts: lib.products, groups: lib.groups, universalKeywords: lib.universalKeywords, method: 'manual', ocrText: p.ocrText, ocrConfidence: p.ocrConfidence,
      imagePath: p.imagePath, filename: p.filename, batchId: p.batchId, uploadedBy: p.uploadedBy || uploadedBy, warning: null
    });
  }

  async _finish({ platform, libraryId, product, allProducts, groups, universalKeywords, method, ocrText, ocrConfidence, imagePath, filename, batchId, uploadedBy, warning }) {
    const { missingKeywords, crossedKeywords, priceIssue, status } = match.matchAgainstProduct(ocrText, product, allProducts, groups, universalKeywords);
    const record = {
      id: 'mc_' + crypto.randomBytes(6).toString('hex'), batchId, timestamp: new Date().toISOString(), uploadedBy, platform, libraryId,
      filename, imagePath, productId: product.id, productName: product.name, matchMethod: method,
      ocrText, ocrConfidence, missingKeywords, crossedKeywords, priceIssue, status, warning
    };
    await this.append(record);
    return record;
  }
}

module.exports = { MaterialCheckStore, PLATFORMS };
