'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReportNewsStore, parseFeed, mondayOf, shortSummary } = require('./report-news-store.js');

const xml = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[AI 助力中国电商]]></title><link>https://example.com/a</link><description><![CDATA[来源 - 电商平台发布人工智能新能力。]]></description><pubDate>Mon, 03 Aug 2026 00:00:00 GMT</pubDate><source>示例媒体</source></item></channel></rss>`;
const rows = parseFeed(xml, { lane: 'commerce', label: '中国电商 AI' });
assert.equal(rows.length, 1);
assert.equal(rows[0].title, 'AI 助力中国电商');
assert.equal(rows[0].source, '示例媒体');
assert.equal(shortSummary(rows[0]), '电商平台发布人工智能新能力。');
assert.equal(mondayOf(new Date('2026-08-03T12:00:00+08:00')), '2026-08-03');

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
  await assert.rejects(() => store.saveDraft({ weekStart: '2026-08-03', pages: { global: [card(1), card(2)], radar: [{ ...card(3), title: 'English news', summary: 'English only' }, card(4)] } }), /中文/);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ report-news draft save and publish');
})().catch((e) => { console.error(e); process.exitCode = 1; });
