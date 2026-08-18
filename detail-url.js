'use strict';

const PRODUCT_HOSTS = new Set(['detail.tmall.com', 'item.taobao.com']);
const LOGIN_HOSTS = new Set(['login.taobao.com', 'login.tmall.com']);
const PRODUCT_PATH = '/item.htm';

function unsupported(message = '不支持的 URL') {
  throw new TypeError(message);
}

function parseUrl(input, { protocolRelative = false } = {}) {
  if (typeof input !== 'string' || input.trim() === '') unsupported('无效的 URL');
  let url;
  try {
    url = protocolRelative ? new URL(input, 'https://invalid.local') : new URL(input);
  } catch {
    unsupported('无效的 URL');
  }
  return url;
}

function hasExplicitPort(input) {
  const match = String(input).trim().match(/^(?:[a-z][a-z\d+.-]*:)?\/\/([^/?#]*)/i);
  if (!match) return false;
  const authority = match[1].replace(/^.*@/, '');
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end >= 0 && authority.slice(end + 1).startsWith(':');
  }
  return authority.includes(':');
}

function assertHttps(url, input) {
  if (url.protocol !== 'https:' || url.username || url.password || hasExplicitPort(input)) {
    unsupported();
  }
}

function decodeRepeated(value) {
  let decoded = value;
  for (let i = 0; i < 4; i += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return decoded;
    }
    if (next === decoded) return decoded;
    decoded = next;
  }
  let next;
  try {
    next = decodeURIComponent(decoded);
  } catch {
    // A malformed percent escape is not itself a redirect.
    return decoded;
  }
  if (next !== decoded) unsupported('无效的重定向 URL');
  return decoded;
}

function assertSupportedNodeRuntime(version = process.versions.node) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)/);
  const major = match ? Number(match[1]) : 0;
  const minor = match ? Number(match[2]) : 0;
  if (major < 20 || (major === 20 && minor < 9)) {
    throw new Error('需要 Node.js >=20.9.0 才能运行详情长图功能');
  }
}

assertSupportedNodeRuntime();

function looksLikeRedirect(value) {
  const decoded = decodeRepeated(value).trim();
  return /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(decoded);
}

function rejectEncodedRedirects(searchParams) {
  for (const [key, value] of searchParams) {
    if (/redirect|return|target|next|url/i.test(key) || looksLikeRedirect(value)) {
      unsupported();
    }
  }
}

function assertPositiveDecimal(value, name) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    unsupported(`无效的 ${name}`);
  }
}

function normalizeProductUrl(input) {
  const url = parseUrl(input);
  assertHttps(url, input);
  if (!PRODUCT_HOSTS.has(url.hostname) || url.pathname !== PRODUCT_PATH) unsupported();
  if (url.searchParams.getAll('id').length !== 1 || url.searchParams.getAll('skuId').length > 1) {
    unsupported('无效的商品 URL');
  }
  rejectEncodedRedirects(url.searchParams);

  const productId = url.searchParams.get('id');
  assertPositiveDecimal(productId, '商品 ID');
  const skuIds = url.searchParams.getAll('skuId');
  if (skuIds.length) assertPositiveDecimal(skuIds[0], 'SKU ID');

  const canonical = new URL(`https://${url.hostname}${PRODUCT_PATH}`);
  canonical.searchParams.set('id', productId);
  if (skuIds.length) canonical.searchParams.set('skuId', skuIds[0]);
  return { platform: 'taobao', productId, url: canonical.toString() };
}

function isAllowedProductUrl(url, input) {
  if (!PRODUCT_HOSTS.has(url.hostname) || url.pathname !== PRODUCT_PATH) return false;
  try {
    normalizeProductUrl(input);
    return true;
  } catch {
    return false;
  }
}

function isAllowedRedirect(value) {
  const decoded = decodeRepeated(value).trim();
  if (!/^https:\/\//i.test(decoded)) return false;
  try {
    const target = parseUrl(decoded);
    if (isAllowedProductUrl(target, decoded)) return true;
    if (!LOGIN_HOSTS.has(target.hostname) || target.username || target.password || hasExplicitPort(decoded)) {
      return false;
    }
    assertLoginRedirects(target);
    return true;
  } catch {
    return false;
  }
}

function assertLoginRedirects(url) {
  for (const [key, value] of url.searchParams) {
    if (/redirect|return|target|next|url/i.test(key)) {
      if (!isAllowedRedirect(value)) unsupported();
    } else if (looksLikeRedirect(value)) {
      unsupported();
    }
  }
}

function assertAllowedNavigation(input) {
  const url = parseUrl(input);
  assertHttps(url, input);
  if (isAllowedProductUrl(url, input)) return new URL(normalizeProductUrl(input).url);
  if (!LOGIN_HOSTS.has(url.hostname)) unsupported();
  assertLoginRedirects(url);
  return url;
}

function assertAllowedImageUrl(input) {
  const url = parseUrl(input, { protocolRelative: true });
  assertHttps(url, input);
  if (url.hostname !== 'alicdn.com' && !url.hostname.endsWith('.alicdn.com')) unsupported();
  return url;
}

module.exports = {
  normalizeProductUrl,
  assertAllowedNavigation,
  assertAllowedImageUrl,
  assertSupportedNodeRuntime,
};
