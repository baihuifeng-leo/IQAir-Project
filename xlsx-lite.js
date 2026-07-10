/**
 * xlsx-lite.js — 零依赖 .xlsx 读取器
 *
 * 只做一件事：把第一个工作表读成 { headers, rows }。
 * 够用的前提是这批淘宝评论导出文件的特征：
 *   · 单 sheet、有 sharedStrings、无 inlineStr
 *   · 日期以文本存储（"2026-06-14"），不是 Excel 序列号
 * 但仍然兼容 inlineStr、数字、布尔和序列号日期，免得换个导出工具就炸。
 */
'use strict';
const zlib = require('zlib');

/* ── ZIP：从中央目录读取条目 ───────────────────────────── */
function unzip(buf) {
  // 末尾找 EOCD（0x06054b50），允许最多 64KB 注释
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('这不是有效的 xlsx（找不到 ZIP 结尾）');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    // 本地文件头的 extra 长度可能和中央目录不同，必须重新读
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    files.set(name, () => (method === 0 ? raw : zlib.inflateRawSync(raw)));
  }
  return files;
}

/* ── XML：够用的最小解析 ───────────────────────────────── */
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const unescape = (s) =>
  s.replace(/&#(x?)([0-9a-fA-F]+);/g, (_, hex, n) => String.fromCodePoint(parseInt(n, hex ? 16 : 10)))
   .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]);

/** sharedStrings.xml → 字符串数组。<si> 里可能有多个 <t>（富文本分段），要拼起来 */
function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) text += unescape(t[1]);
    out.push(text);
  }
  return out;
}

const colIndex = (ref) => {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Excel 序列号 → YYYY-MM-DD（1900 闰年 bug 一并处理） */
function serialToDate(n) {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return isNaN(d) ? String(n) : d.toISOString().slice(0, 10);
}

function parseSheet(xml, shared, dateCols = new Set()) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let r;
  while ((r = rowRe.exec(xml))) {
    const cells = [];
    const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let c;
    while ((c = cRe.exec(r[1]))) {
      const attrs = c[1] ?? c[3] ?? '';
      const inner = c[2] ?? '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs);
      if (!ref) continue;
      const idx = colIndex(ref[1]);
      const type = /t="(\w+)"/.exec(attrs)?.[1] || 'n';

      let val = '';
      if (type === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        val = v ? shared[Number(v[1])] ?? '' : '';
      } else if (type === 'inlineStr') {
        let t; const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        while ((t = tRe.exec(inner))) val += unescape(t[1]);
      } else if (type === 'b') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        val = v && v[1] === '1' ? 'TRUE' : 'FALSE';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        val = v ? unescape(v[1]) : '';
        if (val && dateCols.has(idx) && /^\d+(\.\d+)?$/.test(val)) val = serialToDate(Number(val));
      }
      cells[idx] = val;
    }
    rows.push(cells);
  }
  return rows;
}

/** 读第一个工作表 → { headers: string[], rows: string[][] } */
function readSheet(buf) {
  const files = unzip(buf);
  const get = (n) => (files.has(n) ? files.get(n)().toString('utf8') : '');

  const shared = files.has('xl/sharedStrings.xml') ? parseSharedStrings(get('xl/sharedStrings.xml')) : [];

  // 找第一个 sheet 的实际路径（不一定叫 sheet1.xml）
  let sheetPath = 'xl/worksheets/sheet1.xml';
  if (!files.has(sheetPath)) {
    sheetPath = [...files.keys()].find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
    if (!sheetPath) throw new Error('这个 xlsx 里没有工作表');
  }

  const grid = parseSheet(get(sheetPath), shared);
  if (!grid.length) return { headers: [], rows: [] };

  const width = Math.max(...grid.map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => (grid[0][i] ?? '').trim());
  const rows = grid.slice(1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
  return { headers, rows };
}

/** 读成对象数组，key 是表头 */
function readRecords(buf) {
  const { headers, rows } = readSheet(buf);
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

module.exports = { readSheet, readRecords };
