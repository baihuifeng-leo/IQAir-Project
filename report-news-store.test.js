'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReportNewsStore, parseFeed, parseChinazAi, mondayOf, shortSummary } = require('./report-news-store.js');

const xml = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[AI 助力中国电商]]></title><link>https://example.com/a</link><description><![CDATA[来源 - 电商平台发布人工智能新能力。]]></description><pubDate>Mon, 03 Aug 2026 00:00:00 GMT</pubDate><source>示例媒体</source></item></channel></rss>`;
const rows = parseFeed(xml, { lane: 'commerce', label: '中国电商 AI' });
assert.equal(rows.length, 1);
assert.equal(rows[0].title, 'AI 助力中国电商');
assert.equal(rows[0].source, '示例媒体');
assert.equal(shortSummary(rows[0]), '电商平台发布人工智能新能力。');
assert.equal(mondayOf(new Date('2026-08-03T12:00:00+08:00')), '2026-08-03');
const chinaz = parseChinazAi('<a href="/2026/0803/1768722.shtml" class="home-product_link"><h3>AI 模型在电商运营中的新进展</h3></a><a href="/feed/0803/123.shtml" class="home-product_link"><h3>推广：AI 服务</h3></a>');
assert.equal(chinaz.length, 1);
assert.equal(chinaz[0].source, '站长之家 AI 新闻');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-news-'));
  const store = new ReportNewsStore(dir);
  const card = (n) => ({ title: `中文 AI 新闻 ${n}`, summary: `这是第 ${n} 条经过编辑确认的中文摘要。`, source: '示例媒体', url: 'https://example.com/a', imageUrl: '/uploads/cover.jpg' });
  const draft = await store.saveDraft({ weekStart: '2026-08-03', pages: { global: [card(1), card(2)], radar: [card(3), card(4)] } });
  assert.equal(draft.pages.global.length, 2);
  const published = await store.publish('2026-08-03');
  assert.ok(published.publishedAt);
  const summary = await store.summary();
  assert.equal(summary.news.pages.radar[1].title, '中文 AI 新闻 4');
  const data = await store.load();
  data.candidates['2026-08-03'] = [
    { id: 'a', ...card(5), tags: ['电商相关'] }, { id: 'b', ...card(6), tags: ['空气品质相关'] }
  ];
  await store.save(data);
  const generated = await store.generate('2026-08-03', ['a', 'b']);
  assert.equal(generated.pages.global.length, 2);
  assert.equal(generated.pages.global[0].title, '中文 AI 新闻 5');
  const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-news-import-'));
  const importedStore = new ReportNewsStore(importDir, async () => '<html><head><meta property="og:title" content="中文 AI 电商新闻"><meta name="description" content="这是可用于汇报的中文新闻摘要。"><meta property="og:image" content="https://example.com/cover.jpg"></head></html>');
  const imported = await importedStore.importUrl('2026-08-03', 'https://example.com/news');
  assert.equal(imported.title, '中文 AI 电商新闻');
  assert.equal((await importedStore.summary()).candidates.length, 1);
  fs.rmSync(importDir, { recursive: true, force: true });
  await assert.rejects(() => store.saveDraft({ weekStart: '2026-08-03', pages: { global: [card(1), card(2)], radar: [{ ...card(3), title: 'English news', summary: 'English only' }, card(4)] } }), /中文/);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ report-news draft save and publish');
})().catch((e) => { console.error(e); process.exitCode = 1; });
