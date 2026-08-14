'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractDetail } = require('./taobao-detail-adapter');

class FakeLocator {
  constructor(count) {
    this.matchCount = count;
  }

  async count() {
    return this.matchCount;
  }
}

class FakePage {
  constructor({
    url,
    rootSelector,
    rootCount = 1,
    title = '',
    blocks = [],
    lazyBlock = null,
    revealAfterScroll = Infinity,
    rootHeight = 1000,
    viewportHeight = 1000,
    alwaysMutate = false,
  }) {
    this.currentUrl = url;
    this.rootSelector = rootSelector;
    this.rootCount = rootCount;
    this.title = title;
    this.blocks = blocks.slice();
    this.lazyBlock = lazyBlock;
    this.revealAfterScroll = revealAfterScroll;
    this.rootHeight = rootHeight;
    this.viewportHeight = viewportHeight;
    this.alwaysMutate = alwaysMutate;
    this.controlledScrollY = 0;
    this.scrollCalls = 0;
    this.snapshotCalls = 0;
    this.extractCalls = 0;
    this.mutationCount = 0;
    this.locatorSelectors = [];
  }

  url() {
    return this.currentUrl;
  }

  locator(selector) {
    this.locatorSelectors.push(selector);
    const knowsSiteRoot = selector.split(',').map((part) => part.trim()).includes(this.rootSelector);
    return new FakeLocator(knowsSiteRoot ? this.rootCount : 0);
  }

  async evaluate(_browserFunction, input) {
    if (input.operation === 'snapshot') {
      this.snapshotCalls += 1;
      return {
        rootHeight: this.rootHeight,
        imageCount: this.blocks.filter((block) => (
          block.kind === 'image' && !(block.ancestorMarkers && block.ancestorMarkers.length)
        )).length,
        mutationCount: this.mutationCount,
        atEnd: this.controlledScrollY + this.viewportHeight >= this.rootHeight,
      };
    }

    if (input.operation === 'scroll') {
      this.scrollCalls += 1;
      this.controlledScrollY = Math.min(
        Math.max(0, this.rootHeight - this.viewportHeight),
        this.controlledScrollY + this.viewportHeight,
      );
      if (this.lazyBlock && this.scrollCalls === this.revealAfterScroll) {
        this.blocks.push(this.lazyBlock);
        this.mutationCount += 1;
      }
      if (this.alwaysMutate) this.mutationCount += 1;
      return null;
    }

    if (input.operation === 'extract') {
      this.extractCalls += 1;
      return { title: this.title, blocks: this.blocks.map((block) => structuredClone(block)) };
    }

    throw new Error(`FakePage 不支持 evaluate operation: ${input.operation}`);
  }
}

test('extracts the trusted Tmall root in DOM order and reveals a fourth-screen lazy image', async () => {
  const workbenchPage = { scrollY: 0 };
  const page = new FakePage({
    url: 'https://detail.tmall.com/item.htm?id=550555337975&skuId=1',
    rootSelector: '#description',
    rootHeight: 4000,
    viewportHeight: 1000,
    revealAfterScroll: 3,
    title: '  IQAir Atem 详情  ',
    blocks: [
      {
        kind: 'image',
        domIndex: 0,
        currentSrc: 'https://img.alicdn.com/detail/1600.webp',
        srcset: [
          '//img.alicdn.com/detail/1600.webp 1600w',
          'https://img.alicdn.com/detail/retina.JPG?keep=~crop-X~ 2x',
          'https://img.alicdn.com/detail/800.jpg 800w',
          'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw== 9999w',
        ].join(', '),
        src: 'https://img.alicdn.com/detail/source.jpg',
        lazy: {
          'data-ks-lazyload': 'https://img.alicdn.com/detail/stale.jpg',
          'data-lazyload': 'https://img.alicdn.com/detail/source.jpg',
          'data-src': 'data:image/gif;base64,AAAA',
          'data-original': '//img.alicdn.com/detail/original.PNG?Signature=Aa~crop~',
        },
      },
      {
        kind: 'image',
        domIndex: 1,
        currentSrc: 'https://img.alicdn.com/recommend/not-detail.jpg',
        ancestorMarkers: ['J_Recommend recommendation'],
      },
      { kind: 'text', domIndex: 2, text: '  滤芯说明\n  高效净化  ' },
      {
        kind: 'image',
        domIndex: 3,
        currentSrc: 'https://img.alicdn.com/reviews/customer-upload.jpg',
        ancestorMarkers: ['J_Reviews reviews'],
      },
      { kind: 'table', domIndex: 4, rows: [['型号', 'Atem'], ['适用面积', '30 m²']] },
    ],
    lazyBlock: {
      kind: 'image',
      domIndex: 5,
      currentSrc: '',
      srcset: '',
      src: 'data:image/gif;base64,AAAA',
      lazy: { 'data-src': '//img.alicdn.com/detail/fourth-screen.webp' },
    },
  });
  const observations = [];

  const detail = await extractDetail(page, {
    timeoutMs: 1000,
    emit: (event) => observations.push(event),
  });

  assert.equal(detail.title, 'IQAir Atem 详情');
  assert.equal(detail.productId, '550555337975');
  assert.deepEqual(detail.blocks.map((block) => [block.kind, block.domIndex]), [
    ['image', 0],
    ['text', 2],
    ['table', 4],
    ['image', 5],
  ]);
  assert.deepEqual(detail.blocks[0].candidates, [
    'https://img.alicdn.com/detail/1600.webp',
    'https://img.alicdn.com/detail/800.jpg',
    'https://img.alicdn.com/detail/retina.JPG?keep=~crop-X~',
    'https://img.alicdn.com/detail/source.jpg',
    'https://img.alicdn.com/detail/stale.jpg',
    'https://img.alicdn.com/detail/original.PNG?Signature=Aa~crop~',
  ]);
  assert.deepEqual(detail.blocks.at(-1).candidates, [
    'https://img.alicdn.com/detail/fourth-screen.webp',
  ]);
  assert.equal(page.scrollCalls, 6, '第四屏出现后仍需连续稳定三次');
  assert.ok(page.controlledScrollY > 0, '受控 Worker page 应执行滚动');
  assert.equal(workbenchPage.scrollY, 0, '用户自己的工作台页面不参与滚动');
  assert.ok(observations.some((event) => event.imageCount === 2));
});

test('uses the Taobao root, excludes recommendation/review decoys, and keeps serialized blocks', async () => {
  const page = new FakePage({
    url: 'https://item.taobao.com/item.htm?id=778899',
    rootSelector: '#J_DivItemDesc',
    title: '淘宝商品详情',
    blocks: [
      { kind: 'text', domIndex: 0, text: '产品说明' },
      {
        kind: 'image',
        domIndex: 1,
        currentSrc: '',
        srcset: '//img.alicdn.com/taobao/900.jpg 900w, //img.alicdn.com/taobao/450.jpg 450w',
        src: '//img.alicdn.com/taobao/fallback.jpg',
        lazy: {
          'data-lazyload': '//img.alicdn.com/taobao/fallback.jpg',
          'data-url': 'https://img.alicdn.com/taobao/last.jpg',
        },
      },
      { kind: 'video', domIndex: 2, poster: '//img.alicdn.com/taobao/video-poster.jpg' },
      { kind: 'table', domIndex: 3, rows: [['CADR', '300 m³/h']] },
      { kind: 'text', domIndex: 4, text: '猜你喜欢', ancestorMarkers: ['guess-you-like'] },
      {
        kind: 'image',
        domIndex: 5,
        currentSrc: 'https://img.alicdn.com/review/decoy.jpg',
        ancestorMarkers: ['customer-reviews'],
      },
    ],
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
    { kind: 'table', rows: [['CADR', '300 m³/h']], domIndex: 3 },
  ]);
  assert.equal(page.scrollCalls, 3, '已到根节点底部也必须观察连续三次稳定状态');
});

test('rejects missing and ambiguous site-specific detail roots', async () => {
  const missing = new FakePage({
    url: 'https://detail.tmall.com/item.htm?id=1',
    rootSelector: '#description',
    rootCount: 0,
  });
  const ambiguous = new FakePage({
    url: 'https://item.taobao.com/item.htm?id=2',
    rootSelector: '#J_DivItemDesc',
    rootCount: 2,
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

test('requires three consecutive stable observations after the latest DOM mutation', async () => {
  const page = new FakePage({
    url: 'https://detail.tmall.com/item.htm?id=3',
    rootSelector: '#description',
    blocks: [{
      kind: 'image',
      domIndex: 0,
      currentSrc: 'https://img.alicdn.com/detail/only.jpg',
    }],
    lazyBlock: { kind: 'text', domIndex: 1, text: '延迟说明' },
    revealAfterScroll: 2,
  });

  const detail = await extractDetail(page, { timeoutMs: 1000, emit: () => {} });

  assert.equal(page.scrollCalls, 5, '第二次滚动突变后，稳定计数必须归零并重新累计三次');
  assert.deepEqual(detail.blocks.map((block) => block.domIndex), [0, 1]);
});

test('fails with DETAIL_INCOMPLETE instead of returning a partial page at timeout', async () => {
  const page = new FakePage({
    url: 'https://item.taobao.com/item.htm?id=4',
    rootSelector: '#J_DivItemDesc',
    blocks: [{
      kind: 'image',
      domIndex: 0,
      currentSrc: 'https://img.alicdn.com/taobao/partial.jpg',
    }],
    alwaysMutate: true,
  });

  await assert.rejects(
    extractDetail(page, { timeoutMs: 15, emit: () => {} }),
    (error) => error.code === 'DETAIL_INCOMPLETE' && /完整/.test(error.message),
  );
  assert.ok(page.scrollCalls >= 1);
  assert.equal(page.extractCalls, 0, '超时页不得进入局部内容提取');
});
