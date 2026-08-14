'use strict';

const { assertAllowedImageUrl } = require('./detail-url');
const MIB = 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({ perAssetBytes: 50 * MIB, totalBytes: 500 * MIB });
const MAX_ATTEMPTS = 2;
const MAX_ERROR_CANDIDATES = 8;
const SAFE_MESSAGES = Object.freeze({
  HTTP_UNAVAILABLE: '图片响应不可用', REQUEST_FAILED: '图片请求失败', INVALID_RESPONSE: '图片响应无效',
  INVALID_TYPE: '图片响应类型无效', EMPTY_BODY: '图片响应为空', ASSET_SIZE_LIMIT: '图片超过单资源大小限制',
  TASK_SIZE_LIMIT: '图片超过任务大小限制', DECODE_FAILED: '图片无法解码', READ_FAILED: '图片读取失败', INVALID_CANDIDATE: '图片候选无效',
});

class CandidateUnavailable extends Error {
  constructor(code, { retryable = false, terminal = false } = {}) { super(SAFE_MESSAGES[code] || SAFE_MESSAGES.READ_FAILED); this.code = code; this.retryable = retryable; this.terminal = terminal; }
}
function cancelled() { return Object.assign(new Error('任务已取消'), { code: 'DETAIL_CANCELLED' }); }
function aborted(signal) { if (signal?.aborted) throw cancelled(); }
function clear(buffer) { if (Buffer.isBuffer(buffer) || buffer instanceof Uint8Array) buffer.fill(0); }
function release(blocks) { for (const block of blocks) { if (block?.buffer) { clear(block.buffer); block.buffer = null; } } }
function safeCandidate(value) { try { const url = new URL(String(value)); return `${url.protocol}//${url.hostname}/…`.slice(0, 160); } catch { return '无效图片候选'; } }
function unavailable(assetIndex, candidates, last) {
  const error = new Error('详情图片资源不可用'); error.code = 'ASSET_UNAVAILABLE'; error.assetIndex = assetIndex;
  error.candidates = candidates.slice(0, MAX_ERROR_CANDIDATES).map(safeCandidate);
  error.lastError = { code: SAFE_MESSAGES[last?.code] ? last.code : 'READ_FAILED', message: SAFE_MESSAGES[last?.code] || SAFE_MESSAGES.READ_FAILED };
  return error;
}
function safeEmit(emit, event) { try { emit?.(event); } catch {} }
function limitsOf(input) { const value = { ...DEFAULT_LIMITS, ...(input || {}) }; for (const key of ['perAssetBytes', 'totalBytes']) if (!Number.isSafeInteger(value[key]) || value[key] <= 0) throw new TypeError(`无效的图片限制: ${key}`); return value; }

function raceAbort(promise, signal, onAbort) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) { onAbort?.(); return Promise.reject(cancelled()); }
  return new Promise((resolve, reject) => {
    const stop = () => { try { onAbort?.(); } finally { reject(cancelled()); } };
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve(promise).then((value) => { signal.removeEventListener('abort', stop); resolve(value); }, (error) => { signal.removeEventListener('abort', stop); reject(error); });
  });
}
function validateResponse(response) {
  if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status) || !response.stream || !response.headers || typeof response.stream[Symbol.asyncIterator] !== 'function') throw new CandidateUnavailable('INVALID_RESPONSE');
  const iterator = response.stream[Symbol.asyncIterator]();
  if (!iterator || typeof iterator.next !== 'function' || typeof iterator.return !== 'function') throw new CandidateUnavailable('INVALID_RESPONSE');
  return iterator;
}
async function close(iterator) { try { await iterator?.return?.(); } catch {} }

async function download(url, { request, sharp, signal, limits, budget }) {
  aborted(signal);
  let response;
  try { response = await raceAbort(request(url, { signal }), signal); } catch (error) { if (error?.code === 'DETAIL_CANCELLED' || signal?.aborted) throw cancelled(); throw new CandidateUnavailable('REQUEST_FAILED', { retryable: true }); }
  let iterator;
  try {
    iterator = validateResponse(response);
    if (!response.ok || response.status < 200 || response.status >= 300) throw new CandidateUnavailable('HTTP_UNAVAILABLE', { retryable: response.status >= 500 && response.status < 600 });
    let headers;
    try { headers = await raceAbort(response.headers, signal, () => close(iterator)); } catch (error) { if (error?.code === 'DETAIL_CANCELLED' || signal?.aborted) throw cancelled(); throw new CandidateUnavailable('INVALID_RESPONSE'); }
    const type = String(headers?.['content-type'] || headers?.['Content-Type'] || '').split(';', 1)[0].trim().toLowerCase();
    if (!type.startsWith('image/')) throw new CandidateUnavailable('INVALID_TYPE');
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        const item = await raceAbort(iterator.next(), signal, () => close(iterator));
        if (item.done) break;
        const chunk = Buffer.isBuffer(item.value) ? item.value : item.value instanceof Uint8Array ? Buffer.from(item.value) : null;
        if (!chunk) throw new CandidateUnavailable('READ_FAILED');
        // The bytes are already received at this point. Debit task budget before
        // rejecting this candidate so corrupt/oversized retries cannot evade it.
        budget.used += chunk.length; bytes += chunk.length; chunks.push(chunk);
        if (budget.used > limits.totalBytes) throw new CandidateUnavailable('TASK_SIZE_LIMIT', { terminal: true });
        if (bytes > limits.perAssetBytes) throw new CandidateUnavailable('ASSET_SIZE_LIMIT');
      }
      aborted(signal);
      if (!bytes) throw new CandidateUnavailable('EMPTY_BODY');
      const buffer = Buffer.concat(chunks, bytes); chunks.forEach(clear);
      try {
        const metadata = await raceAbort(sharp(buffer, { animated: false, limitInputPixels: false }).metadata(), signal, () => close(iterator));
        if (!Number.isInteger(metadata?.width) || metadata.width <= 0 || !Number.isInteger(metadata?.height) || metadata.height <= 0) throw new Error('bad dimensions');
        aborted(signal); return { buffer, width: metadata.width, height: metadata.height };
      } catch (error) { clear(buffer); if (error?.code === 'DETAIL_CANCELLED' || signal?.aborted) throw cancelled(); throw new CandidateUnavailable('DECODE_FAILED'); }
    } catch (error) { chunks.forEach(clear); if (error?.code === 'DETAIL_CANCELLED' || signal?.aborted) throw cancelled(); if (error instanceof CandidateUnavailable) throw error; throw new CandidateUnavailable('READ_FAILED', { retryable: true }); }
  } finally { if (signal?.aborted) await close(iterator); }
}

async function resolveMedia(block, assetIndex, options, budget) {
  const raw = Array.isArray(block?.candidates) ? block.candidates : []; const seen = new Set(); let last = new CandidateUnavailable('INVALID_CANDIDATE');
  for (const candidate of raw) {
    let url; try { url = assertAllowedImageUrl(candidate).toString(); } catch { continue; }
    if (seen.has(url)) continue; seen.add(url);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      aborted(options.signal);
      try { const media = await download(url, { ...options, budget }); safeEmit(options.emit, { phase: 'resolving', assetIndex, attempt, resolved: true }); return { ...media, sourceUrl: url }; }
      catch (error) { if (error?.code === 'DETAIL_CANCELLED') throw error; last = error instanceof CandidateUnavailable ? error : new CandidateUnavailable('READ_FAILED'); if (last.terminal) throw unavailable(assetIndex, raw, last); if (!last.retryable || attempt === MAX_ATTEMPTS) break; }
    }
  }
  aborted(options.signal);
  throw unavailable(assetIndex, raw, last);
}

async function resolveAllImages(blocks, { request, sharp, signal, limits, emit } = {}) {
  if (typeof request !== 'function') throw new TypeError('request 必须是函数'); if (typeof sharp !== 'function') throw new TypeError('sharp 必须是函数');
  const resolved = []; const activeLimits = limitsOf(limits); const budget = { used: 0 }; let assetIndex = 0;
  try {
    for (const block of Array.isArray(blocks) ? blocks : []) {
      aborted(signal);
      if (block?.kind !== 'image' && block?.kind !== 'video') { resolved.push({ ...block }); continue; }
      const media = await resolveMedia(block, assetIndex, { request, sharp, signal, limits: activeLimits, emit }, budget);
      resolved.push({ kind: block.kind, domIndex: block.domIndex, buffer: media.buffer, width: media.width, height: media.height, sourceUrl: media.sourceUrl }); assetIndex += 1;
    }
    return resolved;
  } catch (error) { release(resolved); throw error; }
}
module.exports = { resolveAllImages };
