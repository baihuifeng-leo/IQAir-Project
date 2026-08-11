/**
 * 个人报告 · 每周 AI 新闻
 *
 * 只读取公开 RSS，不把 LLM 当作事实来源：卡片里的摘要来自 RSS 原文摘要，
 * 并始终保留标题、来源与链接。这样即使外网/模型服务不可用，已发布周报也
 * 不会丢失或被悄悄改写。
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const WEEK_MS = 7 * 86400000;
const MAX_ITEMS_PER_FEED = 12;
const USER_AGENT = 'IQAir-Workbench-News/1.0 (+internal weekly report)';

const FEEDS = [
  // 原始出版物 RSS 负责有内容的摘要；Google News 只作中文垂直领域发现，
  // 不以它的聚合页图片/摘要作为唯一事实来源。
  { lane: 'global', label: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { lane: 'global', label: '全球 AI', url: 'https://news.google.com/rss/search?q=artificial+intelligence+when:7d&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { lane: 'commerce', label: '中文电商 AI', url: 'https://news.google.com/rss/search?q=AI+%E7%94%B5%E5%95%86&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' },
  { lane: 'air', label: '空气品质 AI', url: 'https://news.google.com/rss/search?q=AI+%E7%A9%BA%E6%B0%94%E5%93%81%E8%B3%AA&hl=zh-TW&gl=TW&ceid=TW:zh-Hant' }
];
const CHINAZ_AI_URL = 'https://www.chinaz.com/ai/';

const COMMERCE_WORDS = ['电商', '零售', '购物', '淘宝', '天猫', '京东', '拼多多', '抖音', '直播', '营销', '广告', '消费', '零售'];
const AIR_WORDS = ['空气净化', '空气品质', '空气质量', '净化器', '室内空气', '污染', 'pm2.5', '滤网'];
const HOT_WORDS = ['openai', 'google', 'anthropic', 'meta', 'microsoft', 'nvidia', '模型', '人工智能', 'ai', '生成式'];

const clean = (s = '') => String(s).replace(/<!\[CDATA\[|\]\]>/g, '')
  // Google News 会把 description 里的 <a> 再转义一次；先还原才能正确剥掉链接。
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
  .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const textOf = (xml, tag) => clean((new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml) || [])[1] || '');
const mondayOf = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
const countHits = (s, words) => words.reduce((n, w) => n + (s.includes(w) ? 1 : 0), 0);

function parseFeed(xml, feed) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.slice(0, MAX_ITEMS_PER_FEED).map((item) => {
    const title = textOf(item, 'title');
    const link = textOf(item, 'link');
    const description = textOf(item, 'description');
    const sourceMatch = /<source[^>]*>([\s\S]*?)<\/source>/i.exec(item);
    const source = clean(sourceMatch?.[1] || feed.label);
    const publishedAt = new Date(textOf(item, 'pubDate'));
    return { lane: feed.lane, title, link, source, description, publishedAt: isNaN(publishedAt) ? null : publishedAt.toISOString() };
  }).filter((x) => x.title && /^https?:\/\//.test(x.link));
}
function parseChinazAi(html) {
  const rows = []; const seen = new Set();
  const links = html.matchAll(/<a\b[^>]*href=["']([^"']+(?:\.s?html|\/feed\/[^"']+))["'][^>]*class=["'][^"']*home-product_link[^"']*["'][^>]*>([\s\S]{0,9000}?)<\/a>/gi);
  for (const match of links) {
    const href = new URL(match[1], CHINAZ_AI_URL); const title = clean(/<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(match[2])?.[1] || '');
    if (href.hostname !== 'www.chinaz.com' || !title || title.length < 8 || !/[\u4e00-\u9fff]/.test(title) || seen.has(href.href)) continue;
    if (/推广|广告|GEO|培训课程|招商加盟/.test(title)) continue;
    seen.add(href.href);
    rows.push({ lane: 'chinaz', title, link: href.href, source: '站长之家 AI 新闻', description: title, publishedAt: new Date().toISOString() });
    if (rows.length >= MAX_ITEMS_PER_FEED) break;
  }
  return rows;
}

function requestText(rawUrl, redirects = 0) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(rawUrl); } catch { return reject(new Error('无效 RSS 地址')); }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, text/html' }, timeout: 12000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
        res.resume(); return resolve(requestText(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on('data', (chunk) => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(new Error('响应过大')); else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

function score(item) {
  const hay = (item.title + ' ' + item.description).toLowerCase();
  const ageDays = item.publishedAt ? Math.max(0, (Date.now() - new Date(item.publishedAt)) / 86400000) : 14;
  return countHits(hay, HOT_WORDS) * 3 + countHits(hay, COMMERCE_WORDS) * 9 + countHits(hay, AIR_WORDS) * 12 + (item.lane === 'chinaz' ? 24 : 0) + (item.lane === 'global' ? 4 : 0) - ageDays;
}

function shortSummary(item) {
  const s = clean(item.description).replace(/^.+? - /, '');
  if (!s) return '请打开原文查看事件细节。';
  return s.length > 150 ? s.slice(0, 147) + '…' : s;
}

function toCard(item) {
  const hay = (item.title + ' ' + item.description).toLowerCase();
  const tags = [];
  if (item.lane === 'air' || countHits(hay, AIR_WORDS)) tags.push('空气品质相关');
  if (item.lane === 'commerce' || countHits(hay, COMMERCE_WORDS)) tags.push('电商相关');
  if (item.lane === 'chinaz') tags.unshift('站长之家优选');
  if (!tags.length) tags.push('全球 AI 热点');
  return { title: item.title, summary: shortSummary(item), source: item.source, url: item.link, publishedAt: item.publishedAt, tags, imageUrl: null };
}

function metaValue(html, name) {
  return new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)`, 'i').exec(html)?.[1]
    || new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i').exec(html)?.[1] || '';
}
function articleText(html) {
  const section = /<[^>]+id=["']article-content["'][^>]*>([\s\S]*?)<\/[^>]+>/i.exec(html)?.[1]
    || /<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i.exec(html)?.[1] || html;
  return clean(section).replace(/(责任编辑|相关阅读|本文来自).*/s, '').slice(0, 5000);
}
function imageAttr(tag, names) {
  for (const name of names) {
    const quoted = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag);
    const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, 'i').exec(tag);
    const value = quoted?.[1] || bare?.[1];
    if (value && !/^data:/i.test(value)) return value.replace(/&amp;/g, '&');
  }
  return '';
}
function coverRelevance(title, hint) {
  const subject = String(title || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const candidate = String(hint || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (!subject || !candidate) return 0;
  let hits = candidate.includes(subject) ? 8 : 0;
  const terms = subject.match(/[\u4e00-\u9fff]{2}|[a-z0-9]{2,}/g) || [];
  for (const term of new Set(terms)) if (candidate.includes(term)) hits += 2;
  return Math.min(hits, 14);
}

function articleImages(html, pageUrl, title = '') {
  // OG 图经常只是站点封面。优先正文中尺寸足够、语义更贴近标题、且适合 16:9 的图片；
  // 再保留高质量的 OG 图，给人工“换图”一个稳定的同篇报道候选池。
  const section = /<[^>]+id=["']article-content["'][^>]*>([\s\S]*?)<\/[^^>]+>/i.exec(html)?.[1]
    || /<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i.exec(html)?.[1] || html;
  const images = [];
  let index = 0;
  for (const match of section.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0]; const raw = imageAttr(tag, ['data-original', 'data-src', 'data-lazy-src', 'src']);
    if (!raw) continue;
    let url; try { url = new URL(raw, pageUrl).toString(); } catch { continue; }
    const hint = `${tag} ${url}`;
    if (!/^https?:\/\//i.test(url) || /(?:logo|icon|avatar|qrcode|qr-code|advert|ad[_-]|banner)/i.test(hint)) continue;
    const width = Number(imageAttr(tag, ['data-width', 'width'])) || 0;
    const height = Number(imageAttr(tag, ['data-height', 'height'])) || 0;
    const ratio = width && height ? width / height : 1.78;
    // 竖版素材在双栏放映会挤压摘要，且没有无裁切的横版展示价值；不作为自动候选。
    if (ratio < 0.82 || ratio > 3) continue;
    const score = 40 + (width >= 960 ? 16 : width >= 600 ? 9 : 0) + (height >= 540 ? 12 : height >= 300 ? 6 : 0)
      + (ratio >= 1.35 && ratio <= 2.05 ? 18 : ratio >= 1.1 ? 5 : 0) + coverRelevance(title, hint) - index++;
    images.push({ url, score, source: 'article' });
  }
  const og = metaValue(html, 'og:image') || metaValue(html, 'twitter:image');
  try {
    const url = og ? new URL(og.replace(/&amp;/g, '&'), pageUrl).toString() : null;
    if (url && !/(?:logo|icon|avatar|qrcode|qr-code|advert|ad[_-]|banner)/i.test(url)) images.push({ url, score: 8 + coverRelevance(title, url), source: 'og' });
  } catch { /* 无效 OG 图不能阻断新闻生成 */ }
  const seen = new Set();
  return images.sort((a, b) => b.score - a.score).filter((item) => !seen.has(item.url) && seen.add(item.url)).slice(0, 5);
}
function articleImage(html, pageUrl, title = '') { return articleImages(html, pageUrl, title)[0]?.url || null; }

class ReportNewsStore {
  constructor(dir, getText = requestText, ai = null, ownerFor = (userId) => userId) { this.dir = dir; this.getText = getText; this.ai = ai; this.ownerFor = ownerFor; }
  file(userId) {
    const id = String(this.ownerFor(userId) || userId || '').trim();
    if (!/^u_[a-z0-9]+$/i.test(id)) throw new Error('用户标识不合法');
    return path.join(this.dir, id + '.json');
  }
  async load(userId) {
    try {
      const data = JSON.parse(await fsp.readFile(this.file(userId), 'utf8'));
      return { weeks: data.weeks || {}, drafts: data.drafts || {}, candidates: data.candidates || {}, lastAttempt: data.lastAttempt || null };
    } catch { return { weeks: {}, drafts: {}, candidates: {}, lastAttempt: null }; }
  }
  async save(userId, data) { await fsp.mkdir(this.dir, { recursive: true }); await fsp.writeFile(this.file(userId), JSON.stringify(data, null, 1)); }
  async clearLiveNews(userId) {
    const data = await this.load(userId);
    data.weeks = {};
    data.drafts = {};
    await this.save(userId, data);
    return { cleared: true };
  }
  async summary(userId) { const data = await this.load(userId); const key = mondayOf(); return { weekStart: key, news: data.weeks[key] || null, candidates: data.candidates[key] || [], lastAttempt: data.lastAttempt || null }; }
  async refresh(userId, options = {}) {
    const data = await this.load(userId); const weekStart = mondayOf();
    const results = await Promise.allSettled([
      (async () => parseChinazAi(await this.getText(CHINAZ_AI_URL)))(),
      ...FEEDS.map(async (feed) => parseFeed(await this.getText(feed.url), feed))
    ]);
    const candidates = results.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
    const seen = new Set();
    const unique = candidates.filter((x) => { const key = x.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); if (!/[\u4e00-\u9fff]/.test(x.title + x.description) || !key || seen.has(key)) return false; seen.add(key); return true; });
    const ranked = unique.sort((a, b) => score(b) - score(a));
    const focused = ranked.filter((x) => x.lane !== 'global' || countHits((x.title + x.description).toLowerCase(), COMMERCE_WORDS) + countHits((x.title + x.description).toLowerCase(), AIR_WORDS));
    const pick = (pool, count, used) => pool.filter((x) => !used.has(x.link)).slice(0, count);
    const used = new Set(); const global = pick(ranked.filter((x) => x.lane === 'global'), 2, used); global.forEach((x) => used.add(x.link));
    while (global.length < 2) { const x = pick(ranked, 1, used)[0]; if (!x) break; global.push(x); used.add(x.link); }
    // 雷达页先各留一个电商与空气品质席位；两个垂直源本周都没有内容时，
    // 才由高相关的通用 AI 新闻补位。
    const radar = [];
    for (const lane of ['commerce', 'air']) {
      const x = pick(ranked.filter((item) => item.lane === lane), 1, used)[0];
      if (x) { radar.push(x); used.add(x.link); }
    }
    radar.push(...pick(focused, 2 - radar.length, used)); radar.forEach((x) => used.add(x.link));
    while (radar.length < 2) { const x = pick(ranked, 1, used)[0]; if (!x) break; radar.push(x); used.add(x.link); }
    if (global.length < 2 || radar.length < 2) throw new Error('本周可用新闻不足 4 条');
    const start = options.rotate && ranked.length > 12 ? Math.floor(Math.random() * (ranked.length - 12 + 1)) : 0;
    const cards = ranked.slice(start, start + 12).map((item) => ({ ...toCard(item), id: crypto.createHash('sha1').update(item.link).digest('hex').slice(0, 12), lane: item.lane }));
    if (cards.length < 2) throw new Error('本周中文 AI 候选不足两条');
    data.candidates[weekStart] = cards;
    data.lastAttempt = { at: new Date().toISOString(), ok: true, sourceCount: candidates.length };
    await this.save(userId, data);
    return { weekStart, candidates: cards, sourceCount: candidates.length };
  }
  async generate(userId, weekStartInput, ids) {
    const weekStart = mondayOf(weekStartInput); const data = await this.load(userId);
    const candidates = data.candidates[weekStart] || [];
    const picked = Array.isArray(ids) ? ids.map((id) => candidates.find((x) => x.id === id)).filter(Boolean) : [];
    if (picked.length !== 2 || new Set(picked.map((x) => x.id)).size !== 2) throw new Error('请选择两条不同的候选新闻');
    if (!this.ai?.configured()) throw new Error('AI 新闻生成未配置：请设置 AI_API_KEY 和 AI_MODEL');
    const sourceCards = await Promise.all(picked.map(async ({ id, lane, ...card }) => {
      const html = await this.getText(card.url);
      const body = articleText(html);
      const coverOptions = articleImages(html, card.url, `${card.title} ${body.slice(0, 700)}`);
      return { id, ...card, articleText: body, imageUrl: coverOptions[0]?.url || card.imageUrl, coverOptions };
    }));
    const generated = await this.ai.generate(sourceCards);
    const cards = generated.map((draft) => {
      const source = sourceCards.find((card) => card.id === draft.id);
      return { ...source, ...draft, aiGenerated: true, articleText: undefined };
    });
    // 图像服务是非阻断兜底：正文没有合适横图时才尝试生成。失败或未配置都不能
    // 影响已经可核对的新闻摘要与发布流程。
    if (typeof this.ai?.imageConfigured === 'function' && this.ai.imageConfigured()) {
      await Promise.all(cards.map(async (card) => {
        if (card.coverOptions?.length) return;
        try {
          const source = sourceCards.find((item) => item.id === card.id);
          const imageUrl = await this.ai.generateCover(source);
          if (imageUrl) { card.imageUrl = imageUrl; card.coverOptions = [{ url: imageUrl, source: 'generated' }]; card.coverKind = 'generated'; }
        } catch { /* 图像服务不可用时保留无图演示底板与上传入口 */ }
      }));
    }
    const news = { weekStart, publishedAt: new Date().toISOString(), pages: { global: cards }, sourceCount: candidates.length };
    data.weeks[weekStart] = news;
    for (const key of Object.keys(data.weeks).sort().slice(0, -12)) delete data.weeks[key];
    await this.save(userId, data); return news;
  }
  async setCover(userId, weekStartInput, cardId, imageUrl) {
    const weekStart = mondayOf(weekStartInput); const data = await this.load(userId);
    const news = data.weeks[weekStart];
    const card = news?.pages?.global?.find((item) => item.id === String(cardId || ''));
    if (!card) throw new Error('未找到本周已生成的新闻');
    const url = String(imageUrl || '').trim();
    const autoCandidate = (card.coverOptions || []).some((item) => item?.url === url);
    if (!url || (!url.startsWith('/uploads/') && !autoCandidate)) throw new Error('封面必须来自本次新闻候选或本站上传图片');
    card.imageUrl = url;
    card.coverUpdatedAt = new Date().toISOString();
    await this.save(userId, data);
    return news;
  }
  async importUrl(userId, weekStartInput, rawUrl) {
    const weekStart = mondayOf(weekStartInput); const url = String(rawUrl || '').trim();
    if (!/^https:\/\//i.test(url)) throw new Error('只支持 https 新闻链接');
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'localhost' || host === '[::1]' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local') || /(^|\.)((127|10|0)\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) throw new Error('不能读取内网地址');
    const html = await this.getText(url);
    const title = clean(metaValue(html, 'og:title') || textOf(html, 'title'));
    const description = clean(metaValue(html, 'description') || metaValue(html, 'og:description') || articleText(html).slice(0, 240));
    if (!title || !/[\u4e00-\u9fff]/.test(title + description)) throw new Error('未读到可用的中文新闻内容');
    const item = { title, description, link: url, source: host.replace(/^www\./, ''), publishedAt: new Date().toISOString(), lane: 'manual' };
    const coverOptions = articleImages(html, url, `${title} ${description}`);
    const card = { ...toCard(item), id: crypto.createHash('sha1').update(url).digest('hex').slice(0, 12), lane: 'manual', imageUrl: coverOptions[0]?.url || null, coverOptions };
    const data = await this.load(userId); const list = data.candidates[weekStart] || [];
    data.candidates[weekStart] = [card, ...list.filter((x) => x.id !== card.id)].slice(0, 20);
    await this.save(userId, data); return card;
  }
  cleanCard(input) {
    const title = String(input?.title || '').trim().slice(0, 140);
    const summary = String(input?.summary || '').trim().slice(0, 500);
    const source = String(input?.source || '').trim().slice(0, 80);
    const sourceUrl = String(input?.url || '').trim();
    const imageUrl = String(input?.imageUrl || '');
    if (!title || !summary || !source) throw new Error('每条新闻都需填写中文标题、摘要和来源');
    if (!/[\u4e00-\u9fff]/.test(title + summary)) throw new Error('发布稿只接受中文标题和摘要');
    if (sourceUrl && !/^https?:\/\//.test(sourceUrl)) throw new Error('原始来源链接不合法');
    if (imageUrl && !imageUrl.startsWith('/uploads/')) throw new Error('封面必须上传到工作台');
    return { title, summary, source, url: sourceUrl, imageUrl: imageUrl || null, publishedAt: input?.publishedAt || null, tags: Array.isArray(input?.tags) ? input.tags.map((x) => String(x).slice(0, 30)).slice(0, 3) : [] };
  }
  async saveDraft(userId, input) {
    const weekStart = mondayOf(input?.weekStart);
    const pages = input?.pages || {};
    const draft = { weekStart, updatedAt: new Date().toISOString(), pages: { global: (pages.global || []).map((x) => this.cleanCard(x)), radar: (pages.radar || []).map((x) => this.cleanCard(x)) }, sourceCount: 0 };
    if (draft.pages.global.length !== 2 || draft.pages.radar.length !== 2) throw new Error('第 3、4 页各需两条新闻');
    const data = await this.load(userId); data.drafts[weekStart] = draft; await this.save(userId, data); return draft;
  }
  async publish(userId, weekStartInput) {
    const weekStart = mondayOf(weekStartInput); const data = await this.load(userId); const draft = data.drafts[weekStart];
    if (!draft) throw new Error('先保存本周发布稿');
    const news = { ...draft, publishedAt: new Date().toISOString() };
    data.weeks[weekStart] = news;
    for (const key of Object.keys(data.weeks).sort().slice(0, -12)) delete data.weeks[key];
    await this.save(userId, data); return news;
  }
  async refreshSafely(userId, options) { try { return await this.refresh(userId, options); } catch (e) { const data = await this.load(userId); data.lastAttempt = { at: new Date().toISOString(), ok: false, error: e.message }; await this.save(userId, data); throw e; } }
}

module.exports = { ReportNewsStore, parseFeed, parseChinazAi, mondayOf, shortSummary, articleImage, articleImages };
