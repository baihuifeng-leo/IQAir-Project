/**
 * audit.js — 把两份文档的差异翻译成人话，写进变更日志
 */
'use strict';
const { deepEqual } = require('./merge.js');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const idArr = (a) => Array.isArray(a) && a.every((x) => isObj(x) && typeof x.id === 'string');

const LABEL = {
  brands: '品牌', bands: '价格带', products: '产品', tags: '分类',
  groups: '分组', rows: '参数行', lines: '数值', cells: '单元格',
  name: '名称', price: '价格', label: '标签', title: '标题', subtitle: '副标题',
  v: '数值', s: '注释', ev: '英文数值', es: '英文注释', mark: '高亮',
  color: '颜色', tag: '分类', image: '产品图', image34: '3:4 素材', logo: 'Logo',
  model: '型号', ownBrandId: '我方品牌', italic: '斜体', underline: '下划线', isNew: '新品标记',
  name_en: '英文名称', label_en: '英文标签', title_en: '英文标题', subtitle_en: '英文副标题'
};

const nice = (k) => LABEL[k] || k;
const brief = (v) => {
  if (v === undefined) return '空';
  if (v === null) return '空';
  if (typeof v === 'string') return v.length > 24 ? v.slice(0, 24) + '…' : (v || '空');
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (Array.isArray(v)) return `${v.length} 项`;
  if (isObj(v)) return v.name || v.label || v.v || '一组内容';
  return String(v);
};

/** 返回最多 limit 条人类可读的变更描述 */
function diffSummary(before, after, limit = 24) {
  const out = [];
  walk(before, after, [], out, limit);
  return out.slice(0, limit);
}

function pathText(path) {
  return path.filter(Boolean).join(' › ');
}

function walk(a, b, path, out, limit) {
  if (out.length >= limit) return;
  if (deepEqual(a, b)) return;

  if (idArr(a) && idArr(b)) {
    const A = new Map(a.map((x) => [x.id, x])), B = new Map(b.map((x) => [x.id, x]));
    for (const [id, x] of A) if (!B.has(id)) out.push(`删除 ${pathText(path)}「${brief(x)}」`);
    for (const [id, y] of B) if (!A.has(id)) out.push(`新增 ${pathText(path)}「${brief(y)}」`);
    for (const [id, x] of A) if (B.has(id)) walk(x, B.get(id), [...path, brief(x)], out, limit);
    return;
  }

  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (out.length >= limit) return;
      const inA = k in a, inB = k in b;
      if (inA && !inB) { out.push(`删除 ${pathText(path)} 的${nice(k)}`); continue; }
      if (!inA && inB) {
        if (isObj(b[k]) || Array.isArray(b[k])) walk(undefined, b[k], [...path, nice(k)], out, limit);
        else out.push(`${pathText([...path, nice(k)])} 设为「${brief(b[k])}」`);
        continue;
      }
      walk(a[k], b[k], [...path, isObj(a[k]) || Array.isArray(a[k]) ? nice(k) : nice(k)], out, limit);
    }
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    // 没有 id 的数组（比如单元格里的几行数值）：长度一样就逐位比，能说清到底改了哪一行
    if (a.length === b.length) {
      a.forEach((x, i) => walk(x, b[i], [...path, `第 ${i + 1} 行`], out, limit));
    } else {
      out.push(`${pathText(path)}：${a.length} 项 → ${b.length} 项`);
    }
    return;
  }

  const p = pathText(path);
  if (a === undefined) out.push(`${p} 设为「${brief(b)}」`);
  else out.push(`${p}：「${brief(a)}」→「${brief(b)}」`);
}

module.exports = { diffSummary };
