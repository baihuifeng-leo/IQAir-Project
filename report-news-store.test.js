'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReportNewsStore, parseFeed, parseChinazAi, mondayOf, shortSummary, articleImage } = require('./report-news-store.js');
const { ReportNewsAi } = require('./report-news-ai.js');

const xml = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[AI 助力中国电商]]></title><link>https://example.com/a</link><description><![CDATA[来源 - 电商平台发布人工智能新能力。]]></description><pubDate>Mon, 03 Aug 2026 00:00:00 GMT</pubDate><source>示例媒体</source></item></channel></rss>`;
const rows = parseFeed(xml, { lane: 'commerce', label: '中国电商 AI' });
assert.equal(rows.length, 1);
assert.equal(rows[0].title, 'AI 助力中国电商');
assert.equal(rows[0].source, '示例媒体');
assert.equal(shortSummary(rows[0]), '电商平台发布人工智能新能力。');
assert.equal(mondayOf(new Date('2026-08-03T12:00:00+08:00')), '2026-08-03');
const chinaz = parseChinazAi('<a href="/2026/0803/1768722.shtml" class="home-product_link"><h3>AI 模型在电商运营中的新进展</h3></a><a href="/feed/0803/123.shtml" class="home-product_link"><h3>推广：AI 服务</h3></a><a href="/feed/0803/124.shtml" class="home-product_link"><h3>站长团购GEO优化系统</h3></a>');
assert.equal(chinaz.length, 1);
assert.equal(chinaz[0].source, '站长之家 AI 新闻');
assert.equal(articleImage('<article><img class="article-photo" data-src="/images/report.jpg" width="900" height="506"><img src="/logo.png"></article><meta property="og:image" content="https://example.com/cover.jpg">', 'https://example.com/news'), 'https://example.com/images/report.jpg');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-news-'));
  const fakeAi = {
    configured: () => true,
    generate: async (cards) => cards.map((card, i) => ({ id: card.id, title: `AI 标题 ${i + 1}`, summary: `AI 根据正文整理出的第 ${i + 1} 条中文新闻摘要，说明事件进展与业务意义。`, keyPoint: `第 ${i + 1} 条 AI 关键结论。`, presenterText: `放映时讲第 ${i + 1} 条新闻的关键影响。`, bullets: ['事实进展', '业务影响', '后续关注'], layout: 'image-focus' }))
  };
  const store = new ReportNewsStore(dir, async () => '<article>这是足够长的中文新闻正文，用于验证 AI 新闻摘要生成流程。事件发生后，行业参与者公布了新的能力和应用计划，并说明了对业务运营的影响。团队正在持续跟进后续进展和市场反馈。</article>', fakeAi);
  const card = (n) => ({ title: `中文 AI 新闻 ${n}`, summary: `这是第 ${n} 条经过编辑确认的中文摘要。`, source: '示例媒体', url: 'https://example.com/a', imageUrl: '/uploads/cover.jpg' });
  const draft = await store.saveDraft('u_owner', { weekStart: '2026-08-03', pages: { global: [card(1), card(2)], radar: [card(3), card(4)] } });
  assert.equal(draft.pages.global.length, 2);
  const published = await store.publish('u_owner', '2026-08-03');
  assert.ok(published.publishedAt);
  const summary = await store.summary('u_owner');
  assert.equal(summary.news.pages.radar[1].title, '中文 AI 新闻 4');
  const data = await store.load('u_owner');
  data.candidates['2026-08-03'] = [
    { id: 'a', ...card(5), tags: ['电商相关'] }, { id: 'b', ...card(6), tags: ['空气品质相关'] }
  ];
  await store.save('u_owner', data);
  const generated = await store.generate('u_owner', '2026-08-03', ['a', 'b']);
  assert.equal(generated.pages.global.length, 2);
  assert.equal(generated.pages.global[0].title, 'AI 标题 1');
  assert.equal(generated.pages.global[0].bullets.length, 3);
  assert.equal(generated.pages.global[0].aiGenerated, true);
  const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-news-import-'));
  const importedStore = new ReportNewsStore(importDir, async () => '<html><head><meta property="og:title" content="中文 AI 电商新闻"><meta name="description" content="这是可用于汇报的中文新闻摘要。"><meta property="og:image" content="https://example.com/cover.jpg"></head></html>');
  const imported = await importedStore.importUrl('u_owner', '2026-08-03', 'https://example.com/news');
  assert.equal(imported.title, '中文 AI 电商新闻');
  assert.equal((await importedStore.summary('u_owner')).candidates.length, 1);
  const refreshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-news-refresh-'));
  const refreshedStore = new ReportNewsStore(refreshDir, async (url) => url === 'https://www.chinaz.com/ai/'
    ? '<a href="/2026/0803/1768722.shtml" class="home-product_link"><h3>AI 模型在电商运营中的新进展</h3></a><a href="/2026/0803/1768723.shtml" class="home-product_link"><h3>中文 AI 热点新闻发布</h3></a><a href="/2026/0803/1768724.shtml" class="home-product_link"><h3>国产大模型能力持续升级</h3></a><a href="/2026/0803/1768725.shtml" class="home-product_link"><h3>人工智能产业迎来新进展</h3></a>'
    : xml);
  const refreshed = await refreshedStore.refresh('u_owner');
  assert.equal(refreshed.candidates[0].source, '站长之家 AI 新闻');
  assert.equal(refreshed.candidates[0].tags[0], '站长之家优选');
  fs.rmSync(refreshDir, { recursive: true, force: true });
  const noConfigAi = new ReportNewsAi({ apiKey: '', model: '' });
  assert.equal(noConfigAi.configured(), false);
  let aiPayload;
  const configuredAi = new ReportNewsAi({
    baseUrl: 'https://ai.example/v1', apiKey: 'test-key', model: 'test-model',
    request: async (url, headers, payload) => {
      assert.equal(url, 'https://ai.example/v1/chat/completions');
      assert.equal(headers.Authorization, 'Bearer test-key');
      aiPayload = payload;
      return { choices: [{ message: { content: JSON.stringify({ cards: [
        { id: 'a', title: 'AI 整理标题一', summary: 'AI 根据新闻正文提炼出的中文摘要，说明事件进展、影响范围与业务相关性，供管理层快速掌握。', keyPoint: '第一条新闻对业务的关键结论。', presenterText: '第一条新闻的放映讲稿，只保留需要向管理层说明的关键影响。', bullets: ['事件发生了什么', '业务意味着什么', '下一步关注什么'], layout: 'image-focus' },
        { id: 'b', title: 'AI 整理标题二', summary: 'AI 根据新闻正文提炼出的中文摘要，说明事件进展、影响范围与业务相关性，供管理层快速掌握。', keyPoint: '第二条新闻对业务的关键结论。', presenterText: '第二条新闻的放映讲稿，只保留需要向管理层说明的关键影响。', bullets: ['事件发生了什么', '业务意味着什么', '下一步关注什么'], layout: 'text-focus' }
      ] }) } }] };
    }
  });
  const aiArticle = '这是一篇足够长的中文新闻正文，用于模拟模型依据正文而不是凭空生成摘要。新闻披露了具体事件、参与者和后续计划，因此可以生成汇报内容。报道同时说明了产品功能、行业背景与市场反馈，团队将持续观察实际落地效果和可能带来的业务变化。';
  const aiOutput = await configuredAi.generate([{ id: 'a', title: '原始标题一', source: '示例来源', articleText: aiArticle, imageUrl: null }, { id: 'b', title: '原始标题二', source: '示例来源', articleText: aiArticle, imageUrl: null }]);
  assert.equal(aiPayload.response_format.type, 'json_object');
  assert.equal(aiOutput[0].layout, 'image-focus');
  let deepseekPayload;
  const deepseekAi = new ReportNewsAi({ baseUrl: 'https://api.deepseek.com', apiKey: 'test-key', model: 'deepseek-v4-flash', request: async (url, headers, payload) => { deepseekPayload = payload; return { choices: [{ message: { content: JSON.stringify({ cards: aiOutput }) } }] }; } });
  await deepseekAi.generate([{ id: 'a', title: '原始标题一', source: '示例来源', articleText: aiArticle }, { id: 'b', title: '原始标题二', source: '示例来源', articleText: aiArticle }]);
  assert.equal(deepseekPayload.thinking.type, 'disabled');
  assert.equal(deepseekPayload.max_tokens, 1400);
  let anthropicUrl; let anthropicHeaders; let anthropicPayload;
  const anthropicAi = new ReportNewsAi({ baseUrl: 'https://www.duiapi.com/v1', apiKey: 'test-key', model: 'deepseek-v4-flash', protocol: 'anthropic', request: async (url, headers, payload) => { anthropicUrl = url; anthropicHeaders = headers; anthropicPayload = payload; return { content: [{ type: 'text', text: JSON.stringify({ cards: aiOutput }) }] }; } });
  await anthropicAi.generate([{ id: 'a', title: '原始标题一', source: '示例来源', articleText: aiArticle }, { id: 'b', title: '原始标题二', source: '示例来源', articleText: aiArticle }]);
  assert.equal(anthropicUrl, 'https://www.duiapi.com/v1/messages');
  assert.equal(anthropicHeaders['x-api-key'], 'test-key');
  assert.equal(anthropicPayload.max_tokens, 1400);
  assert.equal(anthropicPayload.thinking.type, 'disabled');
  assert.equal(anthropicPayload.response_format, undefined);
  fs.rmSync(importDir, { recursive: true, force: true });
  await assert.rejects(() => store.saveDraft('u_owner', { weekStart: '2026-08-03', pages: { global: [card(1), card(2)], radar: [{ ...card(3), title: 'English news', summary: 'English only' }, card(4)] } }), /中文/);
  assert.equal((await store.summary('u_other')).news, null, '其他账户不能读取本账户发布的新闻');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ report-news draft save and publish');
})().catch((e) => { console.error(e); process.exitCode = 1; });
