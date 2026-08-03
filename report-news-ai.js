/**
 * Weekly report AI writer.  Talks only to an OpenAI Chat Completions-compatible
 * endpoint; credentials are intentionally read from the service environment.
 */
'use strict';
const https = require('https');

const MAX_ARTICLE_TEXT = 6000;
const clean = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

function requestJson(url, headers, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = https.request(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': body.length }, timeout: 45000 }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (chunk) => { size += chunk.length; if (size > 1024 * 1024) req.destroy(new Error('AI 响应过大')); else chunks.push(chunk); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`AI 服务返回 HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(text)); } catch { reject(new Error('AI 服务没有返回 JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('AI 服务超时')));
    req.on('error', reject); req.end(body);
  });
}

function validate(result, expectedIds) {
  if (!Array.isArray(result?.cards) || result.cards.length !== 2) throw new Error('AI 返回格式不完整');
  const cards = result.cards.map((item) => ({
    id: clean(item?.id, 80),
    title: clean(item?.title, 42),
    summary: clean(item?.summary, 320),
    keyPoint: clean(item?.keyPoint, 110),
    presenterText: clean(item?.presenterText, 150),
    bullets: Array.isArray(item?.bullets) ? item.bullets.map((x) => clean(x, 44)).filter(Boolean).slice(0, 3) : [],
    layout: item?.layout === 'image-focus' ? 'image-focus' : 'text-focus'
  }));
  if (new Set(cards.map((x) => x.id)).size !== 2 || !cards.every((x) => expectedIds.includes(x.id))) throw new Error('AI 返回了不匹配的新闻');
  if (!cards.every((x) => x.title && x.summary && x.keyPoint && x.presenterText && x.bullets.length === 3)) throw new Error('AI 返回内容不完整');
  return cards;
}

class ReportNewsAi {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || process.env.AI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.apiKey = options.apiKey || process.env.AI_API_KEY || '';
    this.model = options.model || process.env.AI_MODEL || '';
    this.protocol = options.protocol || process.env.AI_API_PROTOCOL || 'openai';
    this.request = options.request || requestJson;
  }
  configured() { return Boolean(this.apiKey && this.model); }
  async generate(cards) {
    if (!this.configured()) throw new Error('AI 新闻生成未配置：请设置 AI_API_KEY 和 AI_MODEL');
    if (!Array.isArray(cards) || cards.length !== 2) throw new Error('AI 生成需要两条新闻');
    const articles = cards.map((card) => ({ id: card.id, source: card.source, originalTitle: card.title, article: clean(card.articleText, MAX_ARTICLE_TEXT), hasImage: Boolean(card.imageUrl), imageUrl: card.imageUrl || null }));
    if (articles.some((x) => x.article.length < 80)) throw new Error('无法读取足够的新闻正文，不能进行 AI 整理');
    const prompt = `你是中国电商团队的周报编辑。只能依据下面两篇原文，不得补充、猜测或编造事实。为每篇新闻生成适合管理层汇报、可投放到 16:9 放映页的中文内容。\n\n返回严格 JSON：{"cards":[{"id":"原 id","title":"<=42字的中文标题","summary":"180-300字，按发生了什么→为何重要→业务应关注什么的顺序写成可直接放映的正文","keyPoint":"<=110字的一句话结论，作为标题下的副标题","presenterText":"<=150字的口语讲稿，补充摘要中最重要的决策语境","bullets":["<=44字事实要点","<=44字影响要点","<=44字后续关注"],"layout":"image-focus 或 text-focus"}]}。若有配图且图可作为事件视觉焦点用 image-focus，否则 text-focus。\n\n原文：${JSON.stringify(articles)}`;
    const system = '你是严谨的中文新闻编辑。输出仅包含合法 JSON。';
    const payload = {
      model: this.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    };
    // 新闻摘要不需要展示推理过程。DeepSeek V4 默认开启思考，显式关闭可稳定
    // 延迟与输出 Token 成本；其它 OpenAI 兼容服务不发送这个专有字段。
    let response; let content;
    if (this.protocol === 'anthropic') {
      delete payload.response_format;
      payload.max_tokens = 1400;
      payload.thinking = { type: 'disabled' };
      payload.system = system;
      payload.messages = [{ role: 'user', content: prompt }];
      response = await this.request(`${this.baseUrl}/messages`, { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, payload);
      content = response?.content?.find((part) => part.type === 'text')?.text;
    } else {
      if (/api\.deepseek\.com$/i.test(this.baseUrl)) { payload.thinking = { type: 'disabled' }; payload.max_tokens = 1400; }
      response = await this.request(`${this.baseUrl}/chat/completions`, { Authorization: `Bearer ${this.apiKey}` }, payload);
      content = response?.choices?.[0]?.message?.content;
    }
    let parsed; try { parsed = typeof content === 'string' ? JSON.parse(content) : content; } catch { throw new Error('AI 返回的内容不是合法 JSON'); }
    return validate(parsed, cards.map((x) => x.id));
  }
}

module.exports = { ReportNewsAi, validate };
