const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProductUrl,
  assertAllowedNavigation,
  assertAllowedImageUrl,
  assertSupportedNodeRuntime,
} = require('./detail-url');

test('normalizes canonical Taobao and Tmall product URLs', () => {
  const cases = [
    [
      'https://detail.tmall.com/item.htm?id=550555337975&spm=x&skuId=6111878169768',
      {
        platform: 'taobao',
        productId: '550555337975',
        url: 'https://detail.tmall.com/item.htm?id=550555337975&skuId=6111878169768',
      },
    ],
    [
      'https://item.taobao.com/item.htm?skuId=99&id=123456789&from=ad',
      {
        platform: 'taobao',
        productId: '123456789',
        url: 'https://item.taobao.com/item.htm?id=123456789&skuId=99',
      },
    ],
  ];

  for (const [input, expected] of cases) {
    assert.deepEqual(normalizeProductUrl(input), expected);
  }
});

test('normalizes products without an optional skuId', () => {
  assert.deepEqual(normalizeProductUrl('https://item.taobao.com/item.htm?id=7'), {
    platform: 'taobao',
    productId: '7',
    url: 'https://item.taobao.com/item.htm?id=7',
  });
});

test('rejects unsafe or non-product product URLs', () => {
  const cases = [
    'http://detail.tmall.com/item.htm?id=1',
    'https://user:pass@detail.tmall.com/item.htm?id=1',
    'https://detail.tmall.com:443/item.htm?id=1',
    ' https://detail.tmall.com:8443/item.htm?id=1 ',
    'https://127.0.0.1/item.htm?id=1',
    'https://[::1]/item.htm?id=1',
    'https://detail.tmall.com.evil.test/item.htm?id=1',
    'https://detail.tmall.com/shop.htm?id=1',
    'https://detail.tmall.com/item.htm?redirect=https%3A%2F%2Fevil.test%2F',
    'https://item.taobao.com/item.htm?id=0',
    'https://item.taobao.com/item.htm?id=-1',
    'https://item.taobao.com/item.htm?id=abc',
  ];

  for (const input of cases) {
    assert.throws(() => normalizeProductUrl(input), /不支持|无效/);
  }
});

test('allows only approved top-level navigation URLs', () => {
  const allowed = [
    'https://detail.tmall.com/item.htm?id=1',
    'https://item.taobao.com/item.htm?id=1',
    'https://login.taobao.com/member/login.jhtml',
    'https://login.tmall.com/',
    'https://login.taobao.com/member/login.jhtml?redirectURL=https%3A%2F%2Fdetail.tmall.com%2Fitem.htm%3Fid%3D1',
  ];

  for (const input of allowed) {
    assert.equal(assertAllowedNavigation(input).protocol, 'https:');
  }
});

test('rejects navigation URLs that can escape the approved hosts', () => {
  const rejected = [
    'http://detail.tmall.com/item.htm?id=1',
    'https://detail.tmall.com.evil.test/item.htm?id=1',
    'https://detail.tmall.com:443/item.htm?id=1',
    ' https://login.taobao.com:8443/member/login.jhtml ',
    'https://user:pass@login.taobao.com/member/login.jhtml',
    'https://detail.tmall.com/shop.htm?id=1',
    'https://login.taobao.com/member/login.jhtml?redirectURL=https%3A%2F%2Fevil.test%2F',
    'https://login.taobao.com/member/login.jhtml?redirectURL=https%253A%252F%252Fevil.test%252F',
    'https://login.taobao.com/member/login.jhtml?redirectURL=https%3A%2F%2Flogin.taobao.com%2Fmember%2Flogin.jhtml%3FredirectURL%3Dhttps%253A%252F%252Fevil.test%252F',
  ];

  for (const input of rejected) {
    assert.throws(() => assertAllowedNavigation(input), /不支持|无效/);
  }
});

test('rejects redirect values that remain encoded after four decode rounds', () => {
  let encoded = 'https://evil.test/';
  for (let i = 0; i < 6; i += 1) encoded = encodeURIComponent(encoded);
  assert.throws(
    () => normalizeProductUrl(`https://detail.tmall.com/item.htm?id=1&extra=${encoded}`),
    /不支持|无效/,
  );
});

test('allows HTTPS Alibaba CDN image URLs and protocol-relative URLs', () => {
  const cases = [
    'https://img.alicdn.com/imgextra/i1/O1CN01.jpg',
    'https://alicdn.com/product/image.png',
    '//img.alicdn.com/tfs/TB1.png',
  ];

  for (const input of cases) {
    const url = assertAllowedImageUrl(input);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.port, '');
  }
});

test('rejects unsafe image URLs', () => {
  const cases = [
    'data:image/png;base64,AAAA',
    'http://img.alicdn.com/image.png',
    'https://127.0.0.1/image.png',
    'https://192.168.1.3/image.png',
    'https://10.0.0.4/image.png',
    'https://[::1]/image.png',
    'https://img.alicdn.com.evil.test/image.png',
    'https://user:pass@img.alicdn.com/image.png',
    'https://img.alicdn.com:8443/image.png',
    ' https://img.alicdn.com:8443/image.png ',
  ];

  for (const input of cases) {
    assert.throws(() => assertAllowedImageUrl(input), /不支持|无效/);
  }
});

test('requires Node.js 20.9 or newer at runtime', () => {
  assert.doesNotThrow(() => assertSupportedNodeRuntime('20.9.0'));
  assert.doesNotThrow(() => assertSupportedNodeRuntime('22.1.0'));
  assert.throws(() => assertSupportedNodeRuntime('20.8.1'), /Node\.js.*20\.9/);
  assert.throws(() => assertSupportedNodeRuntime('18.20.0'), /Node\.js.*20\.9/);
});

test('declares the same Node.js runtime floor in package metadata', () => {
  assert.equal(require('./package.json').engines.node, '>=20.9.0');
});
