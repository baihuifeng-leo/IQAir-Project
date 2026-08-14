'use strict';

const { assertAllowedImageUrl } = require('./detail-url');

const MIB = 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  perAssetBytes: 50 * MIB,
  totalBytes: 500 * MIB,
});
const MAX_ATTEMPTS_PER_CANDIDATE = 2;
const MAX_ERROR_CANDIDATE_LENGTH = 160;

class CandidateUnavailable extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

function cancelledError() {
  const error = new Error('任务已取消');
  error.code = 'DETAIL_CANCELLED';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError();
}

function assetUnavailable(assetIndex, candidates) {
  const error = new Error('详情图片资源不可用');
  error.code = 'ASSET_UNAVAILABLE';
  error.assetIndex = assetIndex;
  error.candidates = candidates.map(safeCandidate);
  return error;
}

function safeCandidate(candidate) {
  try {
    const url = new URL(String(candidate));
    const value = `${url.protocol}//${url.hostname}/…`;
    return value.slice(0, MAX_ERROR_CANDIDATE_LENGTH);
  } catch {
    return '无效图片候选';
  }
}

function statusOf(response) {
  const value = typeof response?.status === 'function' ? response.status() : response?.status;
  return Number(value);
}

async function headersOf(response) {
  const value = typeof response?.headers === 'function' ? await response.headers() : response?.headers;
  if (!value) return Object.create(null);
  if (typeof value.get === 'function') return value;
  const normalized = Object.create(null);
  for (const [key, header] of Object.entries(value)) normalized[String(key).toLowerCase()] = header;
  return normalized;
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) || headers.get(name.toLowerCase());
  return headers?.[name] || headers?.[name.toLowerCase()];
}

async function bodyOf(response) {
  const body = typeof response?.body === 'function' ? await response.body() : response?.body;
  if (body == null) return [];
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return [body];
  if (typeof body[Symbol.asyncIterator] === 'function' || typeof body[Symbol.iterator] === 'function') return body;
  throw new CandidateUnavailable('图片响应没有可读取内容');
}

function clearBuffer(buffer) {
  if (Buffer.isBuffer(buffer) || buffer instanceof Uint8Array) buffer.fill(0);
}

function releaseResolved(blocks) {
  for (const block of blocks) {
    if (!block?.buffer) continue;
    clearBuffer(block.buffer);
    block.buffer = null;
  }
}

function validLimits(input) {
  const result = { ...DEFAULT_LIMITS, ...(input || {}) };
  for (const key of ['perAssetBytes', 'totalBytes']) {
    if (!Number.isSafeInteger(result[key]) || result[key] <= 0) throw new TypeError(`无效的图片限制: ${key}`);
  }
  return result;
}

async function downloadCandidate(url, { request, sharp, signal, limits, completedBytes }) {
  throwIfAborted(signal);
  let response;
  try {
    response = await request(url, { signal });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'DETAIL_CANCELLED') throw cancelledError();
    throw new CandidateUnavailable('图片请求失败', { retryable: true });
  }
  throwIfAborted(signal);

  const status = statusOf(response);
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    throw new CandidateUnavailable('图片响应不可用', { retryable: status >= 500 && status < 600 });
  }
  const headers = await headersOf(response);
  const contentType = String(headerValue(headers, 'content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) throw new CandidateUnavailable('图片响应类型无效');

  const chunks = [];
  let bytes = 0;
  try {
    const body = await bodyOf(response);
    for await (const value of body) {
      throwIfAborted(signal);
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (bytes + chunk.length > limits.perAssetBytes) throw new CandidateUnavailable('图片超过单资源大小限制');
      if (completedBytes + bytes + chunk.length > limits.totalBytes) throw new CandidateUnavailable('图片超过任务大小限制');
      chunks.push(chunk);
      bytes += chunk.length;
    }
    throwIfAborted(signal);
    if (bytes === 0) throw new CandidateUnavailable('图片响应为空');
    const buffer = Buffer.concat(chunks, bytes);
    for (const chunk of chunks) clearBuffer(chunk);
    try {
      const metadata = await sharp(buffer, { animated: false, limitInputPixels: false }).metadata();
      if (!Number.isInteger(metadata?.width) || metadata.width <= 0 || !Number.isInteger(metadata?.height) || metadata.height <= 0) {
        throw new Error('missing dimensions');
      }
      throwIfAborted(signal);
      return { buffer, width: metadata.width, height: metadata.height, bytes };
    } catch (error) {
      clearBuffer(buffer);
      if (signal?.aborted || error?.code === 'DETAIL_CANCELLED') throw cancelledError();
      throw new CandidateUnavailable('图片无法解码');
    }
  } catch (error) {
    for (const chunk of chunks) clearBuffer(chunk);
    if (signal?.aborted || error?.code === 'DETAIL_CANCELLED' || error?.name === 'AbortError') throw cancelledError();
    if (error instanceof CandidateUnavailable) throw error;
    throw new CandidateUnavailable('图片读取失败', { retryable: true });
  }
}

async function resolveImageBlock(block, assetIndex, options, completedBytes) {
  const candidates = Array.isArray(block?.candidates) ? block.candidates : [];
  for (const candidate of candidates) {
    let url;
    try {
      url = assertAllowedImageUrl(candidate).toString();
    } catch {
      continue;
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_CANDIDATE; attempt += 1) {
      throwIfAborted(options.signal);
      try {
        const image = await downloadCandidate(url, { ...options, completedBytes });
        options.emit?.({ phase: 'resolving', assetIndex, attempt: attempt + 1, resolved: true });
        return image;
      } catch (error) {
        if (error?.code === 'DETAIL_CANCELLED') throw error;
        if (!(error instanceof CandidateUnavailable) || !error.retryable || attempt + 1 === MAX_ATTEMPTS_PER_CANDIDATE) break;
      }
    }
  }
  throw assetUnavailable(assetIndex, candidates);
}

async function resolveAllImages(blocks, { request, sharp, signal, limits, emit } = {}) {
  if (typeof request !== 'function') throw new TypeError('request 必须是函数');
  if (typeof sharp !== 'function') throw new TypeError('sharp 必须是函数');
  const resolved = [];
  const activeLimits = validLimits(limits);
  let completedBytes = 0;
  let assetIndex = 0;
  try {
    for (const block of Array.isArray(blocks) ? blocks : []) {
      throwIfAborted(signal);
      if (block?.kind !== 'image' && block?.kind !== 'video') {
        resolved.push({ ...block });
        continue;
      }
      const image = await resolveImageBlock(block, assetIndex, { request, sharp, signal, limits: activeLimits, emit }, completedBytes);
      completedBytes += image.bytes;
      resolved.push({ kind: block.kind, domIndex: block.domIndex, buffer: image.buffer, width: image.width, height: image.height });
      assetIndex += 1;
    }
    return resolved;
  } catch (error) {
    releaseResolved(resolved);
    throw error;
  }
}

module.exports = { resolveAllImages };
