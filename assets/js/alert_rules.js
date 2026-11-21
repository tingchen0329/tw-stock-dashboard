/**
 * 到價通知規則：解析與判斷（網頁的規則產生器與 scripts/alerts.mjs 共用，純計算、無 DOM）
 *
 * 一行一條：代號,條件,數值,備註
 *   代號：台股 2330；美股 US:NVDA（或直接 NVDA）；總經 MACRO:keep（擔保維持率）、MACRO:taiex、MACRO:vix …
 *   條件：見 CONDITIONS（也接受英文別名，例如 price<=、rsi>=）
 *   # 開頭或空白行忽略；第一列可以是標題「代號,條件,數值,備註」
 */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const CONDITIONS = [
  { key: '價格<=', label: '價格 ≤', field: 'price', op: '<=', value: true },
  { key: '價格>=', label: '價格 ≥', field: 'price', op: '>=', value: true },
  { key: '漲幅>=', label: '今日漲幅 ≥ %', field: 'chgPct', op: '>=', value: true },
  { key: '跌幅>=', label: '今日跌幅 ≥ %', field: 'chgPct', op: 'drop', value: true },
  { key: 'RSI<=', label: 'RSI(14) ≤', field: 'rsi', op: '<=', value: true },
  { key: 'RSI>=', label: 'RSI(14) ≥', field: 'rsi', op: '>=', value: true },
  { key: '本益比<=', label: '本益比 ≤', field: 'pe', op: '<=', value: true },
  { key: '千張大戶週增減>=', label: '千張大戶週增減 ≥ 百分點', field: 'big1000Chg', op: '>=', value: true },
  { key: '站上MA20', label: '收盤站上 20 日均線', field: 'ma20', op: 'above', value: false },
  { key: '跌破MA20', label: '收盤跌破 20 日均線', field: 'ma20', op: 'below', value: false },
];

const ALIAS = {
  '<=': '價格<=', '>=': '價格>=', 'price<=': '價格<=', 'price>=': '價格>=', '價<=': '價格<=', '價>=': '價格>=',
  'chg>=': '漲幅>=', 'up>=': '漲幅>=', 'drop>=': '跌幅>=', 'down>=': '跌幅>=',
  'rsi<=': 'RSI<=', 'rsi>=': 'RSI>=', 'pe<=': '本益比<=', 'big1000chg>=': '千張大戶週增減>=',
  'above_ma20': '站上MA20', 'below_ma20': '跌破MA20', '站上ma20': '站上MA20', '跌破ma20': '跌破MA20',
};

/** FNV-1a 32 位元雜湊（瀏覽器與 Node 結果相同）→ 規則 id；狀態檔只存 id，不會洩漏規則內容 */
export function ruleId(text) {
  let x = 0x811c9dc5;
  for (const ch of String(text)) {
    x ^= ch.codePointAt(0);
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x.toString(16).padStart(8, '0');
}

/** 代號 → {kind:'tw'|'us'|'macro', code} */
export function parseCode(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, '');
  if (/^MACRO:/i.test(s)) return { kind: 'macro', code: s.slice(6).toLowerCase() };
  const u = s.toUpperCase();
  if (/^US:/.test(u)) return { kind: 'us', code: u.slice(3) };
  if (/^\d{4,6}[A-Z]?$/.test(u)) return { kind: 'tw', code: u.replace(/\.TWO?$/, '') };
  if (/^[A-Z][A-Z0-9.\-]{0,9}$/.test(u)) return { kind: 'us', code: u };
  return null;
}

/**
 * @returns {{rules:{line,id,kind,code,cond,value,note,text}[], errors:{line,msg}[]}}
 */
export function parseRules(text) {
  const rules = [];
  const errors = [];
  String(text || '').replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [c0 = '', k0 = '', v0 = '', ...rest] = line.split(',').map((x) => x.trim());
    if (/^(代號|code)$/i.test(c0)) return;                   // 標題列
    const code = parseCode(c0);
    const key = CONDITIONS.some((c) => c.key === k0.replace(/\s/g, '')) ? k0.replace(/\s/g, '') : ALIAS[k0.replace(/\s/g, '').toLowerCase()];
    const cond = CONDITIONS.find((c) => c.key === key);
    const value = v0 === '' ? null : Number(v0.replace(/_/g, ''));
    if (!code) { errors.push({ line: i + 1, msg: `代號「${c0}」看不懂` }); return; }
    if (!cond) { errors.push({ line: i + 1, msg: `條件「${k0}」不支援` }); return; }
    if (cond.value && !isNum(value)) { errors.push({ line: i + 1, msg: `「${cond.label}」需要數值` }); return; }
    if (code.kind === 'macro' && !['price', 'chgPct'].includes(cond.field)) { errors.push({ line: i + 1, msg: '總經項目只支援價格 / 漲跌幅條件' }); return; }
    const norm = `${code.kind}:${code.code},${cond.key},${cond.value ? value : ''}`;
    rules.push({ line: i + 1, id: ruleId(norm), kind: code.kind, code: code.code, cond, value: cond.value ? value : null, note: rest.join(',').slice(0, 60), text: norm });
  });
  return { rules, errors };
}

/**
 * 判斷一條規則
 * @param {object} rule
 * @param {{price?, chgPct?, rsi?, pe?, ma20?, big1000Chg?}|null} snap  最新數據（缺值 → null，不改變狀態）
 * @returns {boolean|null}
 */
export function evaluate(rule, snap) {
  if (!snap) return null;
  const { field, op } = rule.cond;
  if (op === 'above' || op === 'below') {
    if (!isNum(snap.price) || !isNum(snap.ma20)) return null;
    return op === 'above' ? snap.price > snap.ma20 : snap.price < snap.ma20;
  }
  const v = snap[field];
  if (!isNum(v)) return null;
  if (op === '<=') return v <= rule.value;
  if (op === '>=') return v >= rule.value;
  if (op === 'drop') return v <= -Math.abs(rule.value);
  return null;
}

/**
 * 邊緣觸發：條件「由不成立變成成立」才通知；資料缺值時維持上次狀態
 * @param {object[]} rules
 * @param {(rule)=>object|null} snapOf
 * @param {{rules?:Object<string,{on:boolean, at:string}>}|null} prev  上一次的狀態檔
 * @param {string} now ISO 時間
 * @returns {{fired:{rule, snap}[], state:{rules:Object}}}
 */
export function step(rules, snapOf, prev, now) {
  const old = prev?.rules || {};
  const next = {};
  const fired = [];
  for (const r of rules) {
    const snap = snapOf(r);
    const met = evaluate(r, snap);
    const was = old[r.id];
    if (met === null) { if (was) next[r.id] = was; continue; }
    if (met && !was?.on) fired.push({ rule: r, snap });
    next[r.id] = met === !!was?.on && was ? was : { on: met, at: now };
  }
  return { fired, state: { rules: next } };
}

/** 一條觸發的文字（推播內容） */
export function describe({ rule, snap }) {
  const f2 = (v) => (isNum(v) ? (Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(Math.round(v * 100) / 100)) : 'N/A');
  const sg = (v) => (isNum(v) ? `${v > 0 ? '+' : ''}${Math.round(v * 100) / 100}%` : 'N/A');
  const name = snap?.name ? ` ${snap.name}` : '';
  const head = rule.kind === 'macro' ? `${snap?.name || rule.code}` : `${rule.kind === 'us' ? 'US:' : ''}${rule.code}${name}`;
  const cond = `${rule.cond.label}${rule.cond.value ? ` ${rule.value}` : ''}`;
  const now = rule.cond.field === 'rsi' ? `RSI ${f2(snap?.rsi)}` : rule.cond.field === 'pe' ? `本益比 ${f2(snap?.pe)}`
    : rule.cond.field === 'big1000Chg' ? `千張大戶週 ${sg(snap?.big1000Chg).replace('%', ' 百分點')}`
      : rule.cond.field === 'ma20' ? `現價 ${f2(snap?.price)}、MA20 ${f2(snap?.ma20)}` : `現價 ${f2(snap?.price)}（${sg(snap?.chgPct)}）`;
  return `🔔 ${head}｜${cond}｜${now}${rule.note ? `｜${rule.note}` : ''}`;
}
