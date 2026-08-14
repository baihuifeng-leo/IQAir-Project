'use strict';

const { assertAllowedImageUrl } = require('./detail-url');

const ROOT_SELECTORS = Object.freeze({
  'detail.tmall.com': Object.freeze([
    '#description',
    '.tm-detail-desc',
    '#J_DivItemDesc',
    '[data-module="detail-content"]',
  ]),
  'item.taobao.com': Object.freeze([
    '#J_DivItemDesc',
    '.tb-detail-desc',
    '#description',
    '[data-module="detail-content"]',
  ]),
});

const EXTRACTION_POLICY = Object.freeze({
  lazyAttributes: Object.freeze([
    'data-ks-lazyload',
    'data-lazyload',
    'data-src',
    'data-original',
    'data-url',
  ]),
  excludedAncestorTags: Object.freeze(['NAV', 'HEADER', 'FOOTER', 'ASIDE']),
  excludedMarkerTerms: Object.freeze([
    'review',
    'reviews',
    'rating',
    'rate',
    'recommend',
    'recommended',
    'recommendation',
    'recommendations',
    'related',
    'guess you like',
    'shop',
    'store',
    'navigation',
    'overlay',
    'modal',
    'main image',
    'main gallery',
    'product image',
    'product gallery',
    'image gallery',
    'gallery',
    'carousel',
    'swiper',
    '评价',
    '推荐',
    '猜你喜欢',
    '主图',
    '轮播',
  ]),
});

const DEFAULT_TIMEOUT_MS = 30_000;
const OBSERVATION_DELAY_MS = 100;
const REQUIRED_STABLE_OBSERVATIONS = 3;

function detailError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readPageUrl(page) {
  const value = typeof page.url === 'function' ? page.url() : page.url;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw detailError('DETAIL_SITE_UNSUPPORTED', '无法识别商品详情页地址');
  }
  return url;
}

function productIdFrom(url) {
  const values = url.searchParams.getAll('id');
  if (values.length !== 1 || !/^[1-9]\d*$/.test(values[0])) {
    throw detailError('DETAIL_SITE_UNSUPPORTED', '商品详情页缺少有效商品 ID');
  }
  return values[0];
}

function parseSrcset(input) {
  const source = typeof input === 'string' ? input : '';
  const parsed = [];
  let position = 0;
  let index = 0;

  while (position < source.length) {
    while (position < source.length && /[\s,]/.test(source[position])) position += 1;
    if (position >= source.length) break;

    const urlStart = position;
    while (position < source.length && !/\s/.test(source[position])) position += 1;
    let url = source.slice(urlStart, position);
    let descriptor = '';

    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      while (position < source.length && /\s/.test(source[position])) position += 1;
      const descriptorStart = position;
      while (position < source.length && source[position] !== ',') position += 1;
      descriptor = source.slice(descriptorStart, position).trim();
    }
    if (source[position] === ',') position += 1;

    const numeric = descriptor.match(/^(\d+(?:\.\d+)?)(?:w|x)$/i);
    if (url) {
      parsed.push({
        url,
        score: numeric ? Number(numeric[1]) : Number.NEGATIVE_INFINITY,
        index,
      });
      index += 1;
    }
  }

  parsed.sort((left, right) => right.score - left.score || left.index - right.index);
  return parsed.map((candidate) => candidate.url);
}

function isKnownPlaceholder(url) {
  const filename = url.pathname.split('/').pop().toLowerCase();
  return /^(?:transparent|spaceball|spacer|blank|pixel|1x1)\.(?:gif|png|webp)$/.test(filename);
}

function normalizeMarker(value) {
  return String(value == null ? '' : value)
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .trim();
}

function markerHasExcludedTerm(marker, policy) {
  const normalized = normalizeMarker(marker);
  if (!normalized) return false;
  const padded = ` ${normalized} `;
  return policy.excludedMarkerTerms.some((term) => {
    const normalizedTerm = normalizeMarker(term);
    if (!normalizedTerm) return false;
    if (/[^\x00-\x7f]/.test(normalizedTerm)) return normalized.includes(normalizedTerm);
    return padded.includes(` ${normalizedTerm} `);
  });
}

function isExcludedContext(ancestorTags, ancestorMarkers, policy) {
  const tags = Array.isArray(ancestorTags) ? ancestorTags : [];
  if (tags.some((tag) => policy.excludedAncestorTags.includes(String(tag).toUpperCase()))) {
    return true;
  }
  const markers = Array.isArray(ancestorMarkers) ? ancestorMarkers : [];
  return markers.some((marker) => markerHasExcludedTerm(marker, policy));
}

function normalizeCandidates(rawBlock, policy = EXTRACTION_POLICY) {
  const inputs = [];
  if (rawBlock.kind === 'video') {
    inputs.push(rawBlock.currentSrc, rawBlock.poster, rawBlock.src);
  } else {
    inputs.push(rawBlock.currentSrc);
    inputs.push(...parseSrcset(rawBlock.srcset));
    inputs.push(rawBlock.src);
  }
  const lazy = rawBlock.lazy && typeof rawBlock.lazy === 'object' ? rawBlock.lazy : {};
  for (const attribute of policy.lazyAttributes) inputs.push(lazy[attribute]);

  const candidates = [];
  const seen = new Set();
  for (const input of inputs) {
    if (typeof input !== 'string' || input.trim() === '') continue;
    let url;
    try {
      url = assertAllowedImageUrl(input.trim());
    } catch {
      continue;
    }
    if (isKnownPlaceholder(url)) continue;
    const normalized = url.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push(normalized);
  }
  return candidates;
}

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function isExcludedBlock(block, policy = EXTRACTION_POLICY) {
  return isExcludedContext(block.ancestorTags, block.ancestorMarkers, policy);
}

function serializeBlocks(rawBlocks, policy = EXTRACTION_POLICY) {
  if (!Array.isArray(rawBlocks)) return [];
  const ordered = rawBlocks
    .filter((block) => block && typeof block === 'object' && !isExcludedBlock(block, policy))
    .map((block, order) => ({ block, order }))
    .sort((left, right) => {
      const leftIndex = Number.isInteger(left.block.domIndex) ? left.block.domIndex : left.order;
      const rightIndex = Number.isInteger(right.block.domIndex) ? right.block.domIndex : right.order;
      return leftIndex - rightIndex || left.order - right.order;
    });

  const blocks = [];
  for (const { block, order } of ordered) {
    const domIndex = Number.isInteger(block.domIndex) && block.domIndex >= 0
      ? block.domIndex
      : order;
    if (block.kind === 'image' || block.kind === 'video') {
      const candidates = normalizeCandidates(block, policy);
      if (candidates.length) blocks.push({ kind: block.kind, candidates, domIndex });
      continue;
    }
    if (block.kind === 'text') {
      const text = cleanText(block.text);
      if (text) blocks.push({ kind: 'text', text, domIndex });
      continue;
    }
    if (block.kind === 'table' && Array.isArray(block.rows)) {
      const rows = block.rows
        .filter(Array.isArray)
        .map((row) => row.map(cleanText));
      if (rows.length) blocks.push({ kind: 'table', rows, domIndex });
    }
  }
  return blocks;
}

function pageOperation({ operation, rootSelector, extractionPolicy }) {
  const roots = Array.from(document.querySelectorAll(rootSelector));
  if (roots.length !== 1) return null;
  const root = roots[0];
  const policy = extractionPolicy || {};
  const lazyAttributes = Array.isArray(policy.lazyAttributes) ? policy.lazyAttributes : [];
  const excludedAncestorTags = new Set(Array.isArray(policy.excludedAncestorTags)
    ? policy.excludedAncestorTags.map((tag) => String(tag).toUpperCase())
    : []);
  const excludedMarkerTerms = Array.isArray(policy.excludedMarkerTerms)
    ? policy.excludedMarkerTerms.map((term) => String(term))
    : [];

  function markerFor(element) {
    const values = [];
    if (element.id) values.push(element.id);
    if (typeof element.className === 'string') values.push(element.className);
    else if (element.className && element.className.baseVal) values.push(element.className.baseVal);
    if (element.getAttribute && element.getAttribute('role')) values.push(element.getAttribute('role'));
    for (const attribute of Array.from(element.attributes || [])) {
      if (/^(?:data-|aria-)/i.test(attribute.name)) {
        values.push(attribute.name, attribute.value);
      }
    }
    return values.filter(Boolean).join(' ');
  }

  function normalizeBrowserMarker(value) {
    return String(value == null ? '' : value)
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .toLowerCase()
      .trim();
  }

  function hasExcludedMarker(marker) {
    const normalized = normalizeBrowserMarker(marker);
    if (!normalized) return false;
    const padded = ` ${normalized} `;
    return excludedMarkerTerms.some((term) => {
      const normalizedTerm = normalizeBrowserMarker(term);
      if (!normalizedTerm) return false;
      if (/[^\x00-\x7f]/.test(normalizedTerm)) return normalized.includes(normalizedTerm);
      return padded.includes(` ${normalizedTerm} `);
    });
  }

  function contextFor(element) {
    const ancestorTags = [];
    const ancestorMarkers = [];
    let current = element;
    while (current && current !== root) {
      ancestorTags.push(current.tagName || '');
      ancestorMarkers.push(markerFor(current));
      current = current.parentElement;
    }
    return { ancestorTags, ancestorMarkers };
  }

  function isExcluded(context) {
    for (let index = 0; index < context.ancestorTags.length; index += 1) {
      if (excludedAncestorTags.has(String(context.ancestorTags[index]).toUpperCase())) return true;
      if (hasExcludedMarker(context.ancestorMarkers[index])) return true;
    }
    return false;
  }

  const stateKey = '__ecWorkbenchDetailObservation_v2__';
  function observationState() {
    let state = window[stateKey];
    if (!state || state.root !== root) {
      if (state && state.observer) state.observer.disconnect();
      state = { root, mutationCount: 0, observer: null };
      state.observer = new MutationObserver((records) => {
        state.mutationCount += records.length;
      });
      state.observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      window[stateKey] = state;
    }
    state.mutationCount += state.observer.takeRecords().length;
    return state;
  }

  function viewportHeight() {
    return Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
  }

  function rootIsScrollable() {
    return (root.scrollHeight || 0) > (root.clientHeight || 0) + 1;
  }

  function rootIsAtScrollEnd() {
    return !rootIsScrollable()
      || (root.scrollTop || 0) + (root.clientHeight || 0) >= (root.scrollHeight || 0) - 1;
  }

  if (operation === 'snapshot') {
    const state = observationState();
    const rect = root.getBoundingClientRect();
    const height = viewportHeight();
    const rootHeight = Math.max(root.scrollHeight || 0, root.offsetHeight || 0, Math.ceil(rect.height));
    const imageCount = Array.from(root.querySelectorAll('img')).filter((image) => !isExcluded(contextFor(image))).length;
    const rootVisible = rect.top <= height + 1 && rect.bottom >= -1;
    return {
      rootHeight,
      imageCount,
      mutationCount: state.mutationCount,
      atEnd: rootIsScrollable()
        ? rootIsAtScrollEnd() && rootVisible
        : rect.bottom <= height + 1 && rect.bottom >= -1,
    };
  }

  if (operation === 'scroll') {
    observationState();
    const rect = root.getBoundingClientRect();
    const height = viewportHeight();
    const step = height;

    if (rootIsScrollable()) {
      if (rect.top >= height) {
        window.scrollBy({ top: Math.min(step, rect.top), left: 0, behavior: 'auto' });
      } else if (rect.bottom <= 0) {
        window.scrollBy({ top: Math.max(-step, rect.bottom - height), left: 0, behavior: 'auto' });
      } else if (!rootIsAtScrollEnd()) {
        root.scrollTop = Math.min(root.scrollHeight - root.clientHeight, root.scrollTop + step);
      }
      return null;
    }

    if (rect.top > height) {
      window.scrollBy({ top: Math.min(step, rect.top), left: 0, behavior: 'auto' });
    } else if (rect.bottom > height + 1) {
      window.scrollBy({ top: Math.min(step, rect.bottom - height), left: 0, behavior: 'auto' });
    }
    return null;
  }

  if (operation !== 'extract') return null;

  const ignoredTags = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'SVG']);
  const blocks = [];
  let domIndex = 0;

  function pushBlock(block) {
    blocks.push({ ...block, domIndex });
    domIndex += 1;
  }

  function lazyValues(element) {
    const lazy = {};
    for (const attribute of lazyAttributes) {
      const value = element.getAttribute(attribute);
      if (value) lazy[attribute] = value;
    }
    return lazy;
  }

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const element = node.parentElement;
      if (!element) return;
      const context = contextFor(element);
      const text = node.nodeValue || '';
      if (!isExcluded(context) && text.trim()) pushBlock({ kind: 'text', ...context, text });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node;
    const context = contextFor(element);
    if (isExcluded(context)) return;
    const tagName = element.tagName;
    if (ignoredTags.has(tagName)) return;

    if (tagName === 'IMG') {
      pushBlock({
        kind: 'image',
        ...context,
        currentSrc: element.currentSrc || '',
        srcset: element.getAttribute('srcset') || '',
        src: element.getAttribute('src') || element.src || '',
        lazy: lazyValues(element),
      });
      return;
    }
    if (tagName === 'VIDEO') {
      pushBlock({
        kind: 'video',
        ...context,
        currentSrc: element.currentSrc || '',
        poster: element.poster || element.getAttribute('poster') || '',
        src: element.getAttribute('src') || element.src || '',
        lazy: lazyValues(element),
      });
      return;
    }
    if (tagName === 'TABLE') {
      pushBlock({
        kind: 'table',
        ...context,
        rows: Array.from(element.rows || []).map((row) => (
          Array.from(row.cells || []).map((cell) => cell.textContent || '')
        )),
      });
      return;
    }
    for (const child of Array.from(element.childNodes)) walk(child);
  }

  for (const child of Array.from(root.childNodes)) walk(child);

  const metaTitle = document.querySelector('meta[property="og:title"]');
  const heading = document.querySelector('h1');
  return {
    title: (metaTitle && metaTitle.content) || (heading && heading.textContent) || document.title || '',
    blocks,
  };
}

function snapshotIsStable(previous, current) {
  return Boolean(
    current
    && current.atEnd
    && previous
    && previous.atEnd
    && previous.rootHeight === current.rootHeight
    && previous.imageCount === current.imageCount
    && previous.mutationCount === current.mutationCount
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeEmit(emit, snapshot, stableObservations) {
  try {
    emit({
      phase: 'detecting',
      rootHeight: snapshot.rootHeight,
      imageCount: snapshot.imageCount,
      mutationCount: snapshot.mutationCount,
      stableObservations,
    });
  } catch {
    // Progress reporting must not make a valid detail page fail extraction.
  }
}

function pageInput(operation, rootSelector) {
  return { operation, rootSelector, extractionPolicy: EXTRACTION_POLICY };
}

async function waitForStableDetail(page, rootSelector, timeoutMs, emit) {
  const deadline = Date.now() + timeoutMs;
  let previous = await page.evaluate(pageOperation, pageInput('snapshot', rootSelector));
  if (!previous) throw detailError('DETAIL_ROOT_NOT_FOUND', '商品详情区域已消失');
  let stableObservations = 0;
  safeEmit(emit, previous, stableObservations);

  while (stableObservations < REQUIRED_STABLE_OBSERVATIONS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw detailError('DETAIL_INCOMPLETE', '商品详情在限定时间内未达到完整稳定状态');
    }
    await page.evaluate(pageOperation, pageInput('scroll', rootSelector));
    await delay(Math.min(OBSERVATION_DELAY_MS, remaining));
    const current = await page.evaluate(pageOperation, pageInput('snapshot', rootSelector));
    if (!current) throw detailError('DETAIL_ROOT_NOT_FOUND', '商品详情区域已消失');
    stableObservations = snapshotIsStable(previous, current) ? stableObservations + 1 : 0;
    safeEmit(emit, current, stableObservations);
    previous = current;
  }
}

async function extractDetail(page, { timeoutMs = DEFAULT_TIMEOUT_MS, emit = () => {} } = {}) {
  if (!page || typeof page.locator !== 'function' || typeof page.evaluate !== 'function') {
    throw new TypeError('extractDetail 需要受控浏览器 Page');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs 必须是正数');
  }
  if (typeof emit !== 'function') throw new TypeError('emit 必须是函数');

  const pageUrl = readPageUrl(page);
  const selectors = ROOT_SELECTORS[pageUrl.hostname];
  if (!selectors) throw detailError('DETAIL_SITE_UNSUPPORTED', '不支持的商品详情网站');
  const productId = productIdFrom(pageUrl);
  const rootSelector = selectors.join(', ');
  const rootCount = await page.locator(rootSelector).count();
  if (rootCount === 0) throw detailError('DETAIL_ROOT_NOT_FOUND', '找不到可信的商品详情区域');
  if (rootCount !== 1) throw detailError('DETAIL_ROOT_AMBIGUOUS', '商品详情区域不唯一');

  await waitForStableDetail(page, rootSelector, timeoutMs, emit);
  const extracted = await page.evaluate(pageOperation, pageInput('extract', rootSelector));
  if (!extracted) throw detailError('DETAIL_ROOT_NOT_FOUND', '商品详情区域已消失');
  return {
    title: cleanText(extracted.title),
    productId,
    blocks: serializeBlocks(extracted.blocks, EXTRACTION_POLICY),
  };
}

module.exports = {
  extractDetail,
};
