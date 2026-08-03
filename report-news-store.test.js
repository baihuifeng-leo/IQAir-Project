'use strict';
const assert = require('assert');
const { parseFeed, mondayOf, shortSummary } = require('./report-news-store.js');

const xml = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[AI 助力中国电商]]></title><link>https://example.com/a</link><description><![CDATA[来源 - 电商平台发布人工智能新能力。]]></description><pubDate>Mon, 03 Aug 2026 00:00:00 GMT</pubDate><source>示例媒体</source></item></channel></rss>`;
const rows = parseFeed(xml, { lane: 'commerce', label: '中国电商 AI' });
assert.equal(rows.length, 1);
assert.equal(rows[0].title, 'AI 助力中国电商');
assert.equal(rows[0].source, '示例媒体');
assert.equal(shortSummary(rows[0]), '电商平台发布人工智能新能力。');
assert.equal(mondayOf(new Date('2026-08-03T12:00:00+08:00')), '2026-08-03');
console.log('✓ report-news store parsing');
