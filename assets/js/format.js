/**
 * 數字與日期格式化（純函式，無 DOM 依賴 → 可在 Node 測試）
 *
 * 規則：
 *  - 缺資料一律顯示 "N/A"，不顯示 0、不猜數字
 *  - 漲跌永遠帶 ▲/▼ 與正負號；顏色只是輔助（色盲也能讀）
 *  - 日期一律以台北時間計算（舊版用 UTC，台北 08:00 前日期會差一天）
 */

export const NA = 'N/A';
const TPE = 'Asia/Taipei';

/** 是否為有限數字（排除 null、undefined、NaN、Infinity、字串） */
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Intl.NumberFormat 建構成本高，依小數位數快取重複使用
const fmtCache = new Map();
function nf(dp) {
  if (!fmtCache.has(dp)) {
    fmtCache.set(dp, new Intl.NumberFormat('zh-TW', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
  }
  return fmtCache.get(dp);
}

/** 1234.5 → "1,234.50" */
export function num(v, dp = 2) {
  return isNum(v) ? nf(dp).format(v) : NA;
}

/** 股價：依價位決定小數位（台股 tick：50 元以上多半 1 位就夠） */
export function price(v) {
  if (!isNum(v)) return NA;
  return num(v, Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 100 ? 1 : 2);
}

/** 方向：'up' | 'down' | 'flat'（給 CSS class 用） */
export function dir(v) {
  if (!isNum(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}

/** 帶符號：+1.23 / -1.23 / 0.00。注意 0 是合法值（舊版把 0 當成缺資料） */
export function signed(v, dp = 2) {
  if (!isNum(v)) return NA;
  return (v > 0 ? '+' : '') + nf(dp).format(v);
}

/** 帶 ▲▼ 的漲跌：▲ +15.0 (+1.05%) */
export function change(chg, pct, dp = 2) {
  if (!isNum(chg)) return NA;
  const arrow = chg > 0 ? '▲ ' : chg < 0 ? '▼ ' : '';
  const p = isNum(pct) ? ` (${signed(pct, 2)}%)` : '';
  return arrow + signed(chg, dp) + p;
}

/** 百分比：12.345 → "12.35%"；signedFlag 時加正負號 */
export function pct(v, dp = 2, signedFlag = false) {
  if (!isNum(v)) return NA;
  return (signedFlag ? signed(v, dp) : num(v, dp)) + '%';
}

/** 股數 → 張（1 張 = 1,000 股），帶正負號 */
export function lots(shares) {
  if (!isNum(shares)) return NA;
  return signed(Math.round(shares / 1000), 0);
}

/** 新台幣大數字：1.23e11 → "1,230.0億"；1.2e6 → "120.0萬" */
export function twd(v) {
  if (!isNum(v)) return NA;
  const a = Math.abs(v);
  if (a >= 1e8) return num(v / 1e8, 1) + '億';
  if (a >= 1e4) return num(v / 1e4, 1) + '萬';
  return num(v, 0);
}

/** 美元大數字（中文單位）：7.47e10 → "747.0 億美元" */
export function usd(v) {
  if (!isNum(v)) return NA;
  return `${twd(v)} 美元`;
}

/** 圖表 Y 軸刻度：簡潔顯示（1.2K、3.4萬） */
export function axis(v) {
  if (!isNum(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(a >= 1e9 ? 0 : 1) + '億';
  if (a >= 1e4) return (v / 1e4).toFixed(a >= 1e5 ? 0 : 1) + '萬';
  if (a >= 100) return Math.round(v).toLocaleString('zh-TW');
  return Number(v.toFixed(a >= 10 ? 1 : 2)).toString();
}

/** 台北時間今天 'YYYY-MM-DD' */
export function todayTPE(now = new Date()) {
  // en-CA 的日期格式剛好是 YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TPE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** 'YYYY-MM-DD' 往回 n 天 */
export function daysBefore(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** ISO 時間 → '10/20 13:12'（台北時間）。純日期 '2026-10-19' → '10/19' */
export function when(iso) {
  if (!iso) return NA;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso.slice(5).replace('-', '/');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NA;
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: TPE, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

/** 'YYYY-MM-DD' → '10/23（五）' */
export function dayLabel(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return NA;
  return `${iso.slice(5).replace('-', '/')}（${'日一二三四五六'[new Date(iso + 'T00:00:00Z').getUTCDay()]}）`;
}

/** 營收期間標籤：(2026, 9) → '2026-09' */
export const period = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
