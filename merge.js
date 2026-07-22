/**
 * merge.js — 三方合并
 *
 * 两个人同时改同一份文档时，服务端拿 base（对方拉走时的版本）、
 * mine（对方提交的版本）、remote（服务器当前版本）做合并。
 *
 * 规则：
 *   对象      → 逐键递归
 *   带 id 的数组 → 按 id 配对递归；两边各自新增的都保留；删除只在"另一方没改过"时生效
 *   其它      → 谁改了听谁的；两边都改了，听后提交的（mine）
 */
'use strict';

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function idArray(a) {
  return Array.isArray(a) && a.every((x) => isObj(x) && typeof x.id === 'string');
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

const byId = (arr) => new Map((arr || []).map((x) => [x.id, x]));

function mergeIdArrays(base, mine, remote) {
  const B = byId(base), M = byId(mine), R = byId(remote);
  const out = [];

  // 以 remote 的顺序为骨架
  for (const r of remote) {
    const b = B.get(r.id), m = M.get(r.id);
    if (m === undefined) {
      // 我这边没有它：是我删的，还是我拉走之后对方才加的？
      const iDeletedIt = b !== undefined;
      const otherTouchedIt = b !== undefined && !deepEqual(b, r);
      if (iDeletedIt && !otherTouchedIt) continue; // 我删的，且对方没动过 → 删掉
      out.push(r);                                  // 对方新增的，或对方改过的 → 留着
      continue;
    }
    out.push(merge3(b, m, r));
  }

  // 我这边新增的（base 和 remote 都没有）追加到末尾
  for (const m of mine) {
    if (!R.has(m.id) && !B.has(m.id)) out.push(m);
  }

  // 对方删掉的，如果我改过内容，把它救回来
  for (const m of mine) {
    if (R.has(m.id) || !B.has(m.id)) continue;
    if (!deepEqual(B.get(m.id), m)) out.push(m);
  }

  return out;
}

function merge3(base, mine, remote) {
  if (deepEqual(mine, remote)) return remote;
  if (deepEqual(mine, base)) return remote;   // 我没改，全听对方的
  if (deepEqual(remote, base)) return mine;   // 对方没改，全听我的

  if (isObj(mine) && isObj(remote)) {
    const b = isObj(base) ? base : {};
    const out = {};
    const keys = new Set([...Object.keys(remote), ...Object.keys(mine)]);
    for (const k of keys) {
      const inM = Object.prototype.hasOwnProperty.call(mine, k);
      const inR = Object.prototype.hasOwnProperty.call(remote, k);
      const inB = Object.prototype.hasOwnProperty.call(b, k);

      if (inM && inR) { out[k] = merge3(b[k], mine[k], remote[k]); continue; }
      if (!inM && inR) {                      // 我删了这个键
        if (inB && deepEqual(b[k], remote[k])) continue; // 对方没动 → 尊重删除
        out[k] = remote[k];                   // 对方改过 → 保留
        continue;
      }
      if (inM && !inR) {                      // 对方删了这个键
        if (inB && deepEqual(b[k], mine[k])) continue;   // 我没动 → 尊重删除
        out[k] = mine[k];                     // 我改过 → 救回来
      }
    }
    return out;
  }

  if (idArray(mine) && idArray(remote) && (base === undefined || idArray(base))) {
    return mergeIdArrays(base || [], mine, remote);
  }

  return mine; // 叶子冲突：后提交的赢
}

module.exports = { merge3, deepEqual };
