/**
 * report-store.js — 个人报告：访客/浏览趋势 + 生意参谋日指标
 *
 * 按用户隔离：每个人的周报是自己的数据，不是团队共享文档，
 * 所以不走 matrix/compare 那套三方合并协同，一人一个文件就够。
 *
 * 两张表都是「按日期追加」的历史记录，不是像 3D 预览那样的整份快照——
 * 每周导出的表格时间窗口会互相重叠，用 (日期[+店铺]) 做主键增量合并，
 * 老数据不会因为新导出一份表格就消失，跨周看趋势才有意义。
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { readSheet } = require('./xlsx-lite.js');

const TRAFFIC_COL = { date: '统计日期', store: '店铺名称', visitors: '访客数', pageviews: '浏览量' };

const METRIC_COL = {
  date: '统计时段', pageviews: '浏览量', visitors: '访客数', clicks: '点击次数', clickVisitors: '点击人数',
  clickRate: '点击率', bounceRate: '跳失率', avgStay: '平均停留时长(秒)',
  orderAmount: '引导下单金额', orderBuyers: '引导下单买家数', orderRate: '引导下单转化率',
  payAmount: '引导支付金额', payBuyers: '引导支付买家数', payRate: '引导支付转化率',
  detailViews: '引导商品详情次数', detailVisitors: '引导商品详情人数',
  cartVisitors: '引导加购人数', cartItems: '引导加购件数'
};

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Excel 日期序列号兜底：正常导出日期是文本 "2026-06-22"，但防着哪天换个导出工具变成序列号 */
const normDate = (v) => {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return s;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const ms = Math.round((Number(s) - 25569) * 86400 * 1000);
    const d = new Date(ms);
    if (!isNaN(d)) return d.toISOString().slice(0, 10);
  }
  return s;
};

/**
 * 生意参谋这类导出常在真正的表头前面加两行说明文字 + 一行空行
 * （"数据说明：以下数据为..." / "收藏网址：..." / 空行 / 表头 / 数据…）——
 * 不能假定第一行就是表头，要在前几行里找「包含所有必需列名」的那一行。
 */
function recordsFrom(buf, requiredCols) {
  const { headers, rows } = readSheet(buf);
  const grid = [headers, ...rows];
  let headerRow = null, headerIdx = -1;
  for (let i = 0; i < Math.min(10, grid.length); i++) {
    const set = new Set(grid[i].map((c) => String(c ?? '').trim()));
    if (requiredCols.every((c) => set.has(c))) { headerRow = grid[i]; headerIdx = i; break; }
  }
  if (headerIdx < 0) return [];
  return grid.slice(headerIdx + 1)
    .filter((r) => r.some((c) => String(c ?? '').trim() !== ''))
    .map((r) => Object.fromEntries(headerRow.map((h, i) => [String(h ?? '').trim(), r[i] ?? ''])));
}

class ReportStore {
  constructor(dir) { this.dir = dir; }

  file(userId) { return path.join(this.dir, userId + '.json'); }

  async _load(userId) {
    try {
      const s = JSON.parse(await fsp.readFile(this.file(userId), 'utf8'));
      return { traffic: Array.isArray(s.traffic) ? s.traffic : [], metrics: Array.isArray(s.metrics) ? s.metrics : [] };
    } catch { return { traffic: [], metrics: [] }; }
  }

  async _save(userId, data) {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(this.file(userId), JSON.stringify(data, null, 1));
  }

  async summary(userId) { return this._load(userId); }

  async importTraffic(userId, buf) {
    const required = Object.values(TRAFFIC_COL);
    const rows = recordsFrom(buf, required);
    if (!rows.length) throw new Error(`表格里没找到包含这些列的表头行：${required.join('、')}`);

    const data = await this._load(userId);
    const map = new Map(data.traffic.map((r) => [r.date + '|' + r.store, r]));
    let added = 0, updated = 0, skipped = 0;
    for (const r of rows) {
      const date = normDate(r[TRAFFIC_COL.date]);
      const store = String(r[TRAFFIC_COL.store] || '').trim();
      if (!date || !store) { skipped++; continue; }
      const key = date + '|' + store;
      if (map.has(key)) updated++; else added++;
      map.set(key, { date, store, visitors: num(r[TRAFFIC_COL.visitors]), pageviews: num(r[TRAFFIC_COL.pageviews]) });
    }
    data.traffic = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    await this._save(userId, data);
    return { added, updated, skipped, total: data.traffic.length };
  }

  async importMetrics(userId, buf) {
    const required = Object.values(METRIC_COL);
    const rows = recordsFrom(buf, required);
    if (!rows.length) throw new Error(`表格里没找到包含这些列的表头行：${required.join('、')}`);

    const data = await this._load(userId);
    const map = new Map(data.metrics.map((r) => [r.date, r]));
    let added = 0, updated = 0, skipped = 0;
    for (const r of rows) {
      const date = normDate(r[METRIC_COL.date]);
      if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(date)) { skipped++; continue; }
      const row = { date };
      for (const key of Object.keys(METRIC_COL)) { if (key !== 'date') row[key] = num(r[METRIC_COL[key]]); }
      if (map.has(date)) updated++; else added++;
      map.set(date, row);
    }
    data.metrics = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    await this._save(userId, data);
    return { added, updated, skipped, total: data.metrics.length };
  }
}

module.exports = { ReportStore, TRAFFIC_COL, METRIC_COL };
