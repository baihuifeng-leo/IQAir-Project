/**
 * xlsx-lite.js — 零依赖 .xlsx 读取器
 *
 * 主要是把工作表读成 { headers, rows }（readSheet 只读第一个，
 * readAllSheets 读全部——有些导出文件真正的数据不在第一个 sheet）。
 * 兼容 inlineStr、数字、布尔、序列号日期，以及 Excel 百分比格式
 * （靠读 styles.xml 的数字格式，不是瞎猜小数点位置），免得换个导出
 * 工具或者多几个辅助 sheet 就炸。
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

/**
 * styles.xml → 「百分比格式」的 cellXf 下标集合。
 * Excel 的规则很死：单元格显示成 "14.23%"，但存的原始值永远是 0.1423——
 * 显示成百分比只是套了个数字格式（内置 9="0%"、10="0.00%"，或者自定义
 * formatCode 里带 "%"）。不看格式直接读数字，会把 0.1423 当成 14.23% 读错。
 * 这里只需要 <cellXfs> 里第几个 <xf> 用了百分比格式，parseSheet 按下标查表。
 */
function parsePercentCellXfs(stylesXml) {
  if (!stylesXml) return new Set();
  const customPct = new Set([9, 10]); // 内置：9="0%"，10="0.00%"
  const numFmtRe = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let nm;
  while ((nm = numFmtRe.exec(stylesXml))) {
    if (unescape(nm[2]).includes('%')) customPct.add(Number(nm[1]));
  }

  const xfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!xfsBlock) return new Set();
  const pctXfIdx = new Set();
  const xfRe = /<xf\b[^>]*?\/?>/g;
  let xm, i = 0;
  while ((xm = xfRe.exec(xfsBlock[1]))) {
    const fmtId = /numFmtId="(\d+)"/.exec(xm[0]);
    if (fmtId && customPct.has(Number(fmtId[1]))) pctXfIdx.add(i);
    i++;
  }
  return pctXfIdx;
}

function parseSheet(xml, shared, dateCols = new Set(), pctCellXfs = new Set()) {
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
      const styleIdx = Number(/s="(\d+)"/.exec(attrs)?.[1] ?? -1);

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
        else if (val && pctCellXfs.has(styleIdx) && /^-?\d+(\.\d+)?$/.test(val)) val = String(Number(val) * 100);
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
  const pctCellXfs = files.has('xl/styles.xml') ? parsePercentCellXfs(get('xl/styles.xml')) : new Set();

  // 找第一个 sheet 的实际路径（不一定叫 sheet1.xml）
  let sheetPath = 'xl/worksheets/sheet1.xml';
  if (!files.has(sheetPath)) {
    sheetPath = [...files.keys()].find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
    if (!sheetPath) throw new Error('这个 xlsx 里没有工作表');
  }

  const grid = parseSheet(get(sheetPath), shared, new Set(), pctCellXfs);
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

/**
 * 读所有工作表 → [{ name, headers, rows }, ...]，按工作簿里声明的顺序。
 * 有些导出文件真正的数据不在第一个 sheet（前面几个是透视图/对比表），
 * 调用方要自己在返回的多个 sheet 里找表头对得上的那个。
 */
function readAllSheets(buf) {
  const files = unzip(buf);
  const get = (n) => (files.has(n) ? files.get(n)().toString('utf8') : '');
  const shared = files.has('xl/sharedStrings.xml') ? parseSharedStrings(get('xl/sharedStrings.xml')) : [];
  const pctCellXfs = files.has('xl/styles.xml') ? parsePercentCellXfs(get('xl/styles.xml')) : new Set();

  const wbXml = get('xl/workbook.xml');
  const relsXml = get('xl/_rels/workbook.xml.rels');

  // rId → 实际文件路径
  const ridToTarget = new Map();
  const relRe = /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/>/g;
  let rm;
  while ((rm = relRe.exec(relsXml))) {
    if (/worksheets\//.test(rm[2])) ridToTarget.set(rm[1], 'xl/' + rm[2].replace(/^\.?\/*/, ''));
  }

  const sheetMetas = [];
  const sheetRe = /<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"[^>]*\/>/g;
  let sm;
  while ((sm = sheetRe.exec(wbXml))) {
    const path = ridToTarget.get(sm[2]);
    if (path && files.has(path)) sheetMetas.push({ name: unescape(sm[1]), path });
  }
  // 解析不出 workbook.xml 就退化成「文件里所有 sheetN.xml，按文件名排」
  if (!sheetMetas.length) {
    [...files.keys()].filter((n) => /^xl\/worksheets\/.*\.xml$/.test(n)).sort()
      .forEach((path, i) => sheetMetas.push({ name: 'Sheet' + (i + 1), path }));
  }

  return sheetMetas.map(({ name, path }) => {
    const grid = parseSheet(get(path), shared, new Set(), pctCellXfs);
    if (!grid.length) return { name, headers: [], rows: [] };
    const width = Math.max(...grid.map((r) => r.length));
    const headers = Array.from({ length: width }, (_, i) => (grid[0][i] ?? '').trim());
    const rows = grid.slice(1).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
    return { name, headers, rows };
  });
}

module.exports = { readSheet, readRecords, readAllSheets };
