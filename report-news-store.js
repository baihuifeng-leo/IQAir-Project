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
  return countHits(hay, HOT_WORDS) * 3 + countHits(hay, COMMERCE_WORDS) * 9 + countHits(hay, AIR_WORDS) * 12 + (item.lane === 'global' ? 4 : 0) - ageDays;
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
  if (!tags.length) tags.push('全球 AI 热点');
  return { title: item.title, summary: shortSummary(item), source: item.source, url: item.link, publishedAt: item.publishedAt, tags, imageUrl: null };
}

async function withArticleImage(item, getText) {
  try {
    const html = await getText(item.link);
    const meta = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i.exec(html)
      || /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i.exec(html);
    const imageUrl = meta && /^https:\/\//i.test(meta[1]) ? meta[1].replace(/&amp;/g, '&') : null;
    return { ...toCard(item), imageUrl };
  } catch { return toCard(item); }
}

class ReportNewsStore {
  constructor(dir, getText = requestText) { this.dir = dir; this.file = path.join(dir, 'weekly-ai-news.json'); this.getText = getText; }
  async load() { try { return JSON.parse(await fsp.readFile(this.file, 'utf8')); } catch { return { weeks: {}, lastAttempt: null }; } }
  async save(data) { await fsp.mkdir(this.dir, { recursive: true }); await fsp.writeFile(this.file, JSON.stringify(data, null, 1)); }
  async summary() { const data = await this.load(); const key = mondayOf(); return { weekStart: key, news: data.weeks[key] || data.weeks[Object.keys(data.weeks).sort().pop()] || null, lastAttempt: data.lastAttempt || null }; }
  async refresh() {
    const data = await this.load(); const weekStart = mondayOf();
    const results = await Promise.allSettled(FEEDS.map(async (feed) => parseFeed(await this.getText(feed.url), feed)));
    const candidates = results.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
    const seen = new Set();
    const unique = candidates.filter((x) => { const key = x.title.toLowerCase().replace(/\W/g, ''); if (!key || seen.has(key)) return false; seen.add(key); return true; });
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
    const cards = await Promise.all([...global, ...radar].map((item) => withArticleImage(item, this.getText)));
    const news = { weekStart, publishedAt: new Date().toISOString(), pages: { global: cards.slice(0, 2), radar: cards.slice(2) }, sourceCount: candidates.length };
    data.weeks[weekStart] = news;
    for (const key of Object.keys(data.weeks).sort().slice(0, -12)) delete data.weeks[key];
    data.lastAttempt = { at: new Date().toISOString(), ok: true, sourceCount: candidates.length };
    await this.save(data);
    return news;
  }
  async refreshSafely() { try { return await this.refresh(); } catch (e) { const data = await this.load(); data.lastAttempt = { at: new Date().toISOString(), ok: false, error: e.message }; await this.save(data); throw e; } }
}

module.exports = { ReportNewsStore, parseFeed, mondayOf, shortSummary };
