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

const LAZY_ATTRIBUTES = Object.freeze([
  'data-ks-lazyload',
  'data-lazyload',
  'data-src',
  'data-original',
  'data-url',
]);

const DEFAULT_TIMEOUT_MS = 30_000;
const OBSERVATION_DELAY_MS = 100;
const REQUIRED_STABLE_OBSERVATIONS = 3;
const EXCLUDED_ANCESTOR_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);
const EXCLUDED_ANCESTOR_MARKER = /(?:^|[\s_-])(?:reviews?|rate|recommend(?:ed|ation|ations)?|related|guess[\s_-]*you[\s_-]*like|shop|store|navigation|overlay|modal)(?=$|[\s_-])/i;

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

function normalizeCandidates(rawBlock) {
  const inputs = [];
  if (rawBlock.kind === 'video') {
    inputs.push(rawBlock.currentSrc, rawBlock.poster, rawBlock.src);
  } else {
    inputs.push(rawBlock.currentSrc);
    inputs.push(...parseSrcset(rawBlock.srcset));
    inputs.push(rawBlock.src);
  }
  const lazy = rawBlock.lazy && typeof rawBlock.lazy === 'object' ? rawBlock.lazy : {};
  for (const attribute of LAZY_ATTRIBUTES) inputs.push(lazy[attribute]);

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

function isExcludedBlock(block) {
  const tags = Array.isArray(block.ancestorTags) ? block.ancestorTags : [];
  if (tags.some((tag) => EXCLUDED_ANCESTOR_TAGS.has(String(tag).toUpperCase()))) return true;
  const markers = Array.isArray(block.ancestorMarkers) ? block.ancestorMarkers : [];
  return markers.some((marker) => (
    EXCLUDED_ANCESTOR_MARKER.test(String(marker)) || /推荐|评价|猜你喜欢/.test(String(marker))
  ));
}

function serializeBlocks(rawBlocks) {
  if (!Array.isArray(rawBlocks)) return [];
  const ordered = rawBlocks
    .filter((block) => block && typeof block === 'object' && !isExcludedBlock(block))
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
      blocks.push({ kind: block.kind, candidates: normalizeCandidates(block), domIndex });
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

function pageOperation({ operation, rootSelector }) {
  const roots = Array.from(document.querySelectorAll(rootSelector));
  if (roots.length !== 1) return null;
  const root = roots[0];

  function markerFor(element) {
    const className = typeof element.className === 'string'
      ? element.className
      : element.className && element.className.baseVal;
    return [
      element.id,
      className,
      element.getAttribute && element.getAttribute('data-module'),
      element.getAttribute && element.getAttribute('data-section'),
      element.getAttribute && element.getAttribute('aria-label'),
      element.getAttribute && element.getAttribute('role'),
    ].filter(Boolean).join(' ');
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

  function isExcluded(element) {
    const excludedTags = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE']);
    const excludedMarker = /(?:^|[\s_-])(?:reviews?|rate|recommend(?:ed|ation|ations)?|related|guess[\s_-]*you[\s_-]*like|shop|store|navigation|overlay|modal)(?=$|[\s_-])/i;
    const context = contextFor(element);
    for (let index = 0; index < context.ancestorTags.length; index += 1) {
      if (excludedTags.has(context.ancestorTags[index])) return true;
      const marker = context.ancestorMarkers[index];
      if (excludedMarker.test(marker) || /推荐|评价|猜你喜欢/.test(marker)) return true;
    }
    return false;
  }

  const stateKey = '__ecWorkbenchDetailObservation_v1__';
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
    const pending = state.observer.takeRecords();
    state.mutationCount += pending.length;
    return state;
  }

  if (operation === 'snapshot') {
    const state = observationState();
    const rect = root.getBoundingClientRect();
    const rootHeight = Math.max(root.scrollHeight || 0, root.offsetHeight || 0, Math.ceil(rect.height));
    const imageCount = Array.from(root.querySelectorAll('img')).filter((image) => !isExcluded(image)).length;
    return {
      rootHeight,
      imageCount,
      mutationCount: state.mutationCount,
      atEnd: rect.bottom <= window.innerHeight + 1,
    };
  }

  if (operation === 'scroll') {
    observationState();
    const rect = root.getBoundingClientRect();
    const step = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    if (rect.top > window.innerHeight) {
      window.scrollBy({ top: rect.top, left: 0, behavior: 'auto' });
    } else {
      window.scrollBy({ top: step, left: 0, behavior: 'auto' });
    }
    return null;
  }

  if (operation !== 'extract') return null;

  const lazyAttributes = [
    'data-ks-lazyload',
    'data-lazyload',
    'data-src',
    'data-original',
    'data-url',
  ];
  const elements = Array.from(root.querySelectorAll('img, video, table, p, h2, h3, h4, h5, h6, li'));
  const blocks = [];

  for (let domIndex = 0; domIndex < elements.length; domIndex += 1) {
    const element = elements[domIndex];
    const context = contextFor(element);
    const lazy = {};
    for (const attribute of lazyAttributes) {
      const value = element.getAttribute(attribute);
      if (value) lazy[attribute] = value;
    }

    if (element.tagName === 'IMG') {
      blocks.push({
        kind: 'image',
        domIndex,
        ...context,
        currentSrc: element.currentSrc || '',
        srcset: element.getAttribute('srcset') || '',
        src: element.getAttribute('src') || element.src || '',
        lazy,
      });
    } else if (element.tagName === 'VIDEO') {
      blocks.push({
        kind: 'video',
        domIndex,
        ...context,
        poster: element.poster || element.getAttribute('poster') || '',
        lazy,
      });
    } else if (element.tagName === 'TABLE') {
      blocks.push({
        kind: 'table',
        domIndex,
        ...context,
        rows: Array.from(element.rows || []).map((row) => (
          Array.from(row.cells || []).map((cell) => cell.textContent || '')
        )),
      });
    } else {
      blocks.push({
        kind: 'text',
        domIndex,
        ...context,
        text: element.textContent || '',
      });
    }
  }

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

async function waitForStableDetail(page, rootSelector, timeoutMs, emit) {
  const deadline = Date.now() + timeoutMs;
  let previous = await page.evaluate(pageOperation, { operation: 'snapshot', rootSelector });
  if (!previous) throw detailError('DETAIL_ROOT_NOT_FOUND', '商品详情区域已消失');
  let stableObservations = 0;
  safeEmit(emit, previous, stableObservations);

  while (stableObservations < REQUIRED_STABLE_OBSERVATIONS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw detailError('DETAIL_INCOMPLETE', '商品详情在限定时间内未达到完整稳定状态');
    }
    await page.evaluate(pageOperation, { operation: 'scroll', rootSelector });
    await delay(Math.min(OBSERVATION_DELAY_MS, remaining));
    const current = await page.evaluate(pageOperation, { operation: 'snapshot', rootSelector });
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
  const extracted = await page.evaluate(pageOperation, { operation: 'extract', rootSelector });
  if (!extracted) throw detailError('DETAIL_ROOT_NOT_FOUND', '商品详情区域已消失');
  return {
    title: cleanText(extracted.title),
    productId,
    blocks: serializeBlocks(extracted.blocks),
  };
}

module.exports = {
  extractDetail,
};
