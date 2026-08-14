'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { extractDetail } = require('./taobao-detail-adapter');

class FakeLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
  }

  async count() {
    return this.page.document.querySelectorAll(this.selector).length;
  }
}

class FakePage {
  constructor({
    url,
    html,
    rootSelector,
    rootHeight = 1000,
    rootViewportHeight = rootHeight,
    rootPageTop = 0,
    viewportHeight = 1000,
    pageHeight = null,
    lazyHtml = null,
    revealAfterScroll = Infinity,
    alwaysMutate = false,
  }) {
    this.currentUrl = url;
    this.rootSelector = rootSelector;
    this.dom = new JSDOM(html, { url });
    this.document = this.dom.window.document;
    this.window = this.dom.window;
    this.root = this.document.querySelector(rootSelector);
    this.rootHeight = rootHeight;
    this.rootViewportHeight = rootViewportHeight;
    this.rootPageTop = rootPageTop;
    this.viewportHeight = viewportHeight;
    this.pageHeight = pageHeight == null
      ? rootPageTop + Math.max(rootHeight, rootViewportHeight)
      : pageHeight;
    this.lazyHtml = lazyHtml;
    this.revealAfterScroll = revealAfterScroll;
    this.alwaysMutate = alwaysMutate;
    this.controlledScrollY = 0;
    this.rootScrollTop = 0;
    this.scrollCalls = 0;
    this.pageScrollRequests = 0;
    this.snapshotCalls = 0;
    this.extractCalls = 0;
    this.browserFunctionCalls = 0;
    this.evaluateInputs = [];
    this.locatorSelectors = [];

    for (const image of this.document.querySelectorAll('img[data-current-src]')) {
      Object.defineProperty(image, 'currentSrc', {
        configurable: true,
        value: image.getAttribute('data-current-src'),
      });
    }

    if (this.root) this.installGeometry();
  }

  installGeometry() {
    const page = this;
    const visibleRootHeight = () => Math.min(page.rootHeight, page.rootViewportHeight);
    const maxRootScroll = () => Math.max(0, page.rootHeight - page.rootViewportHeight);
    const maxPageScroll = () => Math.max(0, page.pageHeight - page.viewportHeight);

    Object.defineProperties(this.root, {
      scrollHeight: { configurable: true, get: () => page.rootHeight },
      offsetHeight: { configurable: true, get: () => visibleRootHeight() },
      clientHeight: { configurable: true, get: () => page.rootViewportHeight },
      scrollTop: {
        configurable: true,
        get: () => page.rootScrollTop,
        set: (value) => {
          page.rootScrollTop = Math.min(maxRootScroll(), Math.max(0, Number(value) || 0));
        },
      },
    });
    this.root.getBoundingClientRect = () => {
      const top = page.rootPageTop - page.controlledScrollY;
      const height = visibleRootHeight();
      return {
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 1000,
        width: 1000,
      };
    };

    Object.defineProperties(this.window, {
      innerHeight: { configurable: true, value: this.viewportHeight },
      scrollY: { configurable: true, get: () => page.controlledScrollY },
      pageYOffset: { configurable: true, get: () => page.controlledScrollY },
    });
    this.window.scrollBy = (options) => {
      this.pageScrollRequests += 1;
      const top = typeof options === 'number' ? options : options && options.top;
      this.controlledScrollY = Math.min(
        maxPageScroll(),
        Math.max(0, this.controlledScrollY + (Number(top) || 0)),
      );
    };
  }

  url() {
    return this.currentUrl;
  }

  locator(selector) {
    this.locatorSelectors.push(selector);
    return new FakeLocator(this, selector);
  }

  addLazyContent() {
    if (this.lazyHtml) this.root.insertAdjacentHTML('beforeend', this.lazyHtml);
    if (this.alwaysMutate) this.root.append(this.document.createTextNode('动态更新'));
  }

  async evaluate(browserFunction, input) {
    this.browserFunctionCalls += 1;
    this.evaluateInputs.push(structuredClone(input));
    if (input.operation === 'snapshot') this.snapshotCalls += 1;
    if (input.operation === 'scroll') this.scrollCalls += 1;
    if (input.operation === 'extract') this.extractCalls += 1;

    const globals = {
      window: this.window,
      document: this.document,
      MutationObserver: this.window.MutationObserver,
      Node: this.window.Node,
    };
    const previous = new Map();
    for (const [key, value] of Object.entries(globals)) {
      previous.set(key, {
        exists: Object.prototype.hasOwnProperty.call(globalThis, key),
        value: globalThis[key],
      });
      globalThis[key] = value;
    }

    try {
      const result = await browserFunction(input);
      if (input.operation === 'scroll' && this.scrollCalls >= this.revealAfterScroll) {
        this.addLazyContent();
        this.revealAfterScroll = Infinity;
      } else if (input.operation === 'scroll' && this.alwaysMutate) {
        this.addLazyContent();
      }
      return structuredClone(result);
    } finally {
      for (const [key, value] of previous) {
        if (value.exists) globalThis[key] = value.value;
        else delete globalThis[key];
      }
    }
  }
}

function fixture(title, body) {
  return `<!doctype html><html><head><title>${title}</title><meta property="og:title" content="  ${title}  "></head><body>${body}</body></html>`;
}

test('extracts nested Tmall child nodes in real DOM order and reveals a fourth-screen root-lazy image', async () => {
  const workbenchPage = { scrollY: 0 };
  const page = new FakePage({
    url: 'https://detail.tmall.com/item.htm?id=550555337975&skuId=1',
    rootSelector: '#description',
    rootHeight: 4000,
    rootViewportHeight: 1000,
    viewportHeight: 1000,
    revealAfterScroll: 3,
    html: fixture('IQAir Atem 详情', `
      <main id="description">
        <p>before<img data-current-src="https://img.alicdn.com/detail/1600.webp" srcset="//img.alicdn.com/detail/1600.webp 1600w, https://img.alicdn.com/detail/retina.JPG?keep=~crop-X~ 2x, https://img.alicdn.com/detail/800.jpg 800w, data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw== 9999w" src="https://img.alicdn.com/detail/source.jpg" data-ks-lazyload="https://img.alicdn.com/detail/stale.jpg" data-lazyload="https://img.alicdn.com/detail/source.jpg" data-src="data:image/gif;base64,AAAA" data-original="//img.alicdn.com/detail/original.PNG?Signature=Aa~crop~">after</p>
        <section data-component="mainImageGallery"><img src="https://img.alicdn.com/main/decoy.jpg"></section>
        <section data-section="recommendationList"><img src="https://img.alicdn.com/recommend/not-detail.jpg"></section>
        <section aria-label="customerReviews"><img src="https://img.alicdn.com/reviews/customer-upload.jpg"></section>
        <li><p>滤芯说明</p><table><tr><th>型号</th><td>Atem</td></tr><tr><th>适用面积</th><td>30 m²</td></tr></table></li>
      </main>
    `),
    lazyHtml: '<img data-current-src="" src="data:image/gif;base64,AAAA" data-src="//img.alicdn.com/detail/fourth-screen.webp">',
  });
  const observations = [];

  const detail = await extractDetail(page, {
    timeoutMs: 1000,
    emit: (event) => observations.push(event),
  });

  assert.equal(detail.title, 'IQAir Atem 详情');
  assert.equal(detail.productId, '550555337975');
  assert.deepEqual(detail.blocks, [
    { kind: 'text', text: 'before', domIndex: 0 },
    {
      kind: 'image',
      candidates: [
        'https://img.alicdn.com/detail/1600.webp',
        'https://img.alicdn.com/detail/800.jpg',
        'https://img.alicdn.com/detail/retina.JPG?keep=~crop-X~',
        'https://img.alicdn.com/detail/source.jpg',
        'https://img.alicdn.com/detail/stale.jpg',
        'https://img.alicdn.com/detail/original.PNG?Signature=Aa~crop~',
      ],
      domIndex: 1,
    },
    { kind: 'text', text: 'after', domIndex: 2 },
    { kind: 'text', text: '滤芯说明', domIndex: 3 },
    { kind: 'table', rows: [['型号', 'Atem'], ['适用面积', '30 m²']], domIndex: 4 },
    {
      kind: 'image',
      candidates: ['https://img.alicdn.com/detail/fourth-screen.webp'],
      domIndex: 5,
    },
  ]);
  assert.equal(page.scrollCalls, 6, 'root reaches its end, mutates, then needs three stable observations');
  assert.equal(page.rootScrollTop, 3000, 'the overflow detail root itself is scrolled');
  assert.equal(page.controlledScrollY, 0, 'a visible overflow root does not move the workbench page');
  assert.equal(workbenchPage.scrollY, 0, 'the user workbench page remains untouched');
  assert.equal(page.browserFunctionCalls, page.snapshotCalls + page.scrollCalls + page.extractCalls);
  assert.ok(page.evaluateInputs.every((input) => (
    input.extractionPolicy && input.extractionPolicy.lazyAttributes.includes('data-src')
  )));
  assert.ok(observations.some((event) => event.imageCount === 2));
});

test('uses the Taobao root, excludes data/aria camel-case decoys, and drops media without an allowed candidate', async () => {
  const page = new FakePage({
    url: 'https://item.taobao.com/item.htm?id=778899',
    rootSelector: '#J_DivItemDesc',
    html: fixture('淘宝商品详情', `
      <article id="J_DivItemDesc">
        <p>产品说明</p>
        <img srcset="//img.alicdn.com/taobao/900.jpg 900w, //img.alicdn.com/taobao/450.jpg 450w" src="//img.alicdn.com/taobao/fallback.jpg" data-lazyload="//img.alicdn.com/taobao/fallback.jpg" data-url="https://img.alicdn.com/taobao/last.jpg">
        <video poster="//img.alicdn.com/taobao/video-poster.jpg"></video>
        <img src="data:image/gif;base64,AAAA">
        <section data-section="recommendationList"><p>猜你喜欢</p></section>
        <section aria-label="customerReviews"><img src="https://img.alicdn.com/review/decoy.jpg"></section>
      </article>
    `),
  });

  const detail = await extractDetail(page, { timeoutMs: 1000, emit: () => {} });

  assert.equal(detail.productId, '778899');
  assert.deepEqual(detail.blocks, [
    { kind: 'text', text: '产品说明', domIndex: 0 },
    {
      kind: 'image',
      candidates: [
        'https://img.alicdn.com/taobao/900.jpg',
        'https://img.alicdn.com/taobao/450.jpg',
        'https://img.alicdn.com/taobao/fallback.jpg',
        'https://img.alicdn.com/taobao/last.jpg',
      ],
      domIndex: 1,
    },
    {
      kind: 'video',
      candidates: ['https://img.alicdn.com/taobao/video-poster.jpg'],
      domIndex: 2,
    },
  ]);
});

test('clamps page scrolling at the visible detail bottom before collecting three stable observations', async () => {
  const page = new FakePage({
    url: 'https://detail.tmall.com/item.htm?id=3',
    rootSelector: '#description',
    rootHeight: 4000,
    rootViewportHeight: 4000,
    rootPageTop: 0,
    viewportHeight: 1000,
    pageHeight: 7000,
    html: fixture('页面滚动详情', '<main id="description"><img src="https://img.alicdn.com/detail/only.jpg"></main>'),
  });

  const detail = await extractDetail(page, { timeoutMs: 1000, emit: () => {} });

  assert.equal(page.controlledScrollY, 3000, 'page stops with the root bottom at the viewport edge');
  assert.equal(page.pageScrollRequests, 3, 'stability sampling does not scroll the root above the viewport');
  assert.equal(page.scrollCalls, 6, 'three terminal samples follow the three page-scroll steps');
  assert.deepEqual(detail.blocks, [{
    kind: 'image',
    candidates: ['https://img.alicdn.com/detail/only.jpg'],
    domIndex: 0,
  }]);
});

test('rejects missing and ambiguous site-specific detail roots', async () => {
  const missing = new FakePage({
    url: 'https://detail.tmall.com/item.htm?id=1',
    rootSelector: '#description',
    html: fixture('缺失', '<main>no detail root</main>'),
  });
  const ambiguous = new FakePage({
    url: 'https://item.taobao.com/item.htm?id=2',
    rootSelector: '#J_DivItemDesc',
    html: fixture('重复', '<main id="J_DivItemDesc"></main><section class="tb-detail-desc"></section>'),
  });

  await assert.rejects(
    extractDetail(missing, { timeoutMs: 100, emit: () => {} }),
    (error) => error.code === 'DETAIL_ROOT_NOT_FOUND',
  );
  await assert.rejects(
    extractDetail(ambiguous, { timeoutMs: 100, emit: () => {} }),
    (error) => error.code === 'DETAIL_ROOT_AMBIGUOUS',
  );
});

test('requires three consecutive stable observations after a real DOM mutation', async () => {
  const page = new FakePage({
    url: 'https://detail.tmall.com/item.htm?id=4',
    rootSelector: '#description',
    lazyHtml: '<p>延迟说明</p>',
    revealAfterScroll: 2,
    html: fixture('延迟详情', '<main id="description"><img src="https://img.alicdn.com/detail/only.jpg"></main>'),
  });

  const detail = await extractDetail(page, { timeoutMs: 1000, emit: () => {} });

  assert.equal(page.scrollCalls, 5, 'the second-scroll mutation resets stability and restarts the count');
  assert.deepEqual(detail.blocks.map((block) => [block.kind, block.text]), [
    ['image', undefined],
    ['text', '延迟说明'],
  ]);
});

test('fails with DETAIL_INCOMPLETE instead of returning a partial page at timeout', async () => {
  const page = new FakePage({
    url: 'https://item.taobao.com/item.htm?id=5',
    rootSelector: '#J_DivItemDesc',
    alwaysMutate: true,
    html: fixture('不稳定详情', '<main id="J_DivItemDesc"><img src="https://img.alicdn.com/taobao/partial.jpg"></main>'),
  });

  await assert.rejects(
    extractDetail(page, { timeoutMs: 15, emit: () => {} }),
    (error) => error.code === 'DETAIL_INCOMPLETE' && /完整/.test(error.message),
  );
  assert.ok(page.scrollCalls >= 1);
  assert.equal(page.extractCalls, 0, 'a timed-out page never enters partial extraction');
});
