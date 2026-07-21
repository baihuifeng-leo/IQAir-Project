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
