/**
 * report-store.js — 个人报告：每日数据（店铺整体 + 首页）+ 微盟数据（按周）
 *
 * 按用户隔离：每个人的周报是自己的数据，不是团队共享文档，
 * 所以不走 matrix/compare 那套三方合并协同，一人一个文件就够。
 *
 * 一份 Excel 里同时有「店铺整体」和「首页」两种口径的字段（列名用
 * "（店铺）"/"（首页）" 区分），不用再传两份表。这份表本身就是按日
 * 追加的历史记录，每周重新导出时间窗口会和上次重叠，用日期做主键
 * 增量合并——已经有的日期直接覆盖，不会重复，老数据也不会因为这次
 * 导出没包含就消失。
 *
 * 真正的数据经常不在第一个 sheet 里（前面可能还有透视表/对比表之类
 * 的辅助 sheet），所以要把所有 sheet 都扫一遍，找表头对得上的那个。
 *
 * 微盟数据（公众号/小程序/APP 三端）没有导出接口，原周报 PPT 第二页
 * 是运营每周手动誊抄的 8 个指标 + 三端浏览量/访客数拆分，所以这部分
 * 走手动填表，不走 Excel 导入。按「周一」为主键增量合并，同一周重新
 * 填一次就是覆盖更新，环比统一跟「上一次填的记录」算，不用自己算。
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { readAllSheets } = require('./xlsx-lite.js');

const COL = {
  date: '统计时段',
  shopPageviews: '浏览量（店铺）', shopVisitors: '访客数（店铺）',
  pageviews: '浏览量（首页）', visitors: '访客数（首页）',
  clicks: '点击次数', clickVisitors: '点击人数',
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

/** Excel 日期序列号兜底：日期可能是文本 "2026-06-22"，也可能是序列号 "45768" */
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

const WEIMENG_METRICS = ['pageviews', 'visitors', 'visits', 'avgDepth', 'clickUsers', 'clicks', 'avgStay', 'bounceRate'];
const WEIMENG_CHANNELS = ['wechat', 'miniprogram', 'app'];

/** 任意日期落到当周周一，微盟数据按周记录，主键是周一 */
const mondayOf = (v) => {
  const d = new Date(String(v ?? '').trim() + 'T00:00:00');
  if (isNaN(d)) return null;
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
};

/** 在所有 sheet、每个 sheet 的前 10 行里找「包含所有必需列名」的表头行 */
function recordsFrom(buf, requiredCols) {
  const sheets = readAllSheets(buf);
  for (const { headers, rows } of sheets) {
    const grid = [headers, ...rows];
    for (let i = 0; i < Math.min(10, grid.length); i++) {
      const set = new Set(grid[i].map((c) => String(c ?? '').trim()));
      if (!requiredCols.every((c) => set.has(c))) continue;
      const headerRow = grid[i];
      return grid.slice(i + 1)
        .filter((r) => r.some((c) => String(c ?? '').trim() !== ''))
        .map((r) => Object.fromEntries(headerRow.map((h, j) => [String(h ?? '').trim(), r[j] ?? ''])));
    }
  }
  return [];
}

class ReportStore {
  constructor(dir) { this.dir = dir; }

  file(userId) { return path.join(this.dir, userId + '.json'); }

  async _load(userId) {
    try {
      const s = JSON.parse(await fsp.readFile(this.file(userId), 'utf8'));
      return {
        daily: Array.isArray(s.daily) ? s.daily : [],
        weimeng: Array.isArray(s.weimeng) ? s.weimeng : []
      };
    } catch { return { daily: [], weimeng: [] }; }
  }

  async _save(userId, data) {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(this.file(userId), JSON.stringify(data, null, 1));
  }

  async summary(userId) { return this._load(userId); }

  async import(userId, buf) {
    const required = Object.values(COL);
    const rows = recordsFrom(buf, required);
    if (!rows.length) throw new Error(`表格里没找到包含这些列的表头行：${required.join('、')}`);

    const data = await this._load(userId);
    const map = new Map(data.daily.map((r) => [r.date, r]));
    let added = 0, updated = 0, skipped = 0;
    for (const r of rows) {
      const date = normDate(r[COL.date]);
      if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(date)) { skipped++; continue; }
      const row = { date };
      for (const key of Object.keys(COL)) { if (key !== 'date') row[key] = num(r[COL[key]]); }
      if (map.has(date)) updated++; else added++;
      map.set(date, row);
    }
    data.daily = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    await this._save(userId, data);
    return { added, updated, skipped, total: data.daily.length };
  }

  /** 手动填一周的微盟数据，按周一主键 upsert */
  async weimengSave(userId, input) {
    const weekStart = mondayOf(input && input.weekStart);
    if (!weekStart) throw new Error('周开始日期不对，选一个日期');

    const entry = { weekStart };
    for (const key of WEIMENG_METRICS) entry[key] = num(input[key]);
    entry.channels = {};
    for (const key of WEIMENG_CHANNELS) {
      const c = (input.channels && input.channels[key]) || {};
      entry.channels[key] = { pv: num(c.pv), uv: num(c.uv) };
    }

    const data = await this._load(userId);
    const map = new Map(data.weimeng.map((r) => [r.weekStart, r]));
    const isNew = !map.has(weekStart);
    map.set(weekStart, entry);
    data.weimeng = [...map.values()].sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0));
    await this._save(userId, data);
    return { entry, isNew, total: data.weimeng.length };
  }
}

module.exports = { ReportStore, COL };
