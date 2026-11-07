/**
 * 分析計算（純函式，不碰 DOM、不連網 → tests/js/analytics.test.mjs 可直接驗證）
 *
 * 輸入：FinMind 資料表 { cols: [...], rows: [[...], ...] }
 *       （預先抓好的追蹤清單檔案與網頁即時查詢，格式完全相同）
 * 輸出：給畫面、Claude 指令、CSV/Excel 共用的摘要物件
 *
 * 指標定義（台股常見慣例）：
 *   MA     簡單移動平均
 *   KD     RSV 9 日；K = 2/3·K前 + 1/3·RSV；D = 2/3·D前 + 1/3·K；起始 K=D=50
 *   RSI    14 日 Wilder 平滑
 *   MACD   EMA12 − EMA26 = DIF；DIF 的 EMA9 = DEA；柱狀 = DIF − DEA
 *   河流圖  每日隱含 EPS = 收盤 ÷ 本益比；以過去 3 年本益比的 10/25/50/75/90 百分位畫出價格帶
 */

import { isNum, period } from './format.js';

/* ───────────── 基本工具 ───────────── */

/** {cols, rows} → 物件陣列 */
export function rows(table) {
  if (!table || !Array.isArray(table.rows)) return [];
  const { cols } = table;
  return table.rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
}

const toNum = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(+v) ? +v : null);
const last = (a) => a[a.length - 1];
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sumOrNull = (a) => (a.length ? a.reduce((s, x) => s + x, 0) : null);

/** 排序後陣列的分位數（線性內插），p 介於 0–1 */
export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** v 在 values 中的百分位（0–100）：有多少比例 ≤ v */
export function percentileRank(values, v) {
  const xs = values.filter(isNum);
  if (!xs.length || !isNum(v)) return null;
  return (xs.filter((x) => x <= v).length / xs.length) * 100;
}

/* ───────────── 股價序列與技術指標 ───────────── */

/** FinMind TaiwanStockPrice 表 → 依日期排序的平行陣列（過濾停牌 / 無成交的 0 價） */
export function priceSeries(table) {
  const rs = rows(table)
    .map((r) => ({ d: r.date, o: toNum(r.open), h: toNum(r.max), l: toNum(r.min), c: toNum(r.close), v: toNum(r.Trading_Volume) }))
    .filter((r) => r.d && isNum(r.c) && r.c > 0)
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return {
    dates: rs.map((r) => r.d),
    open: rs.map((r) => r.o ?? r.c),
    high: rs.map((r) => r.h ?? r.c),
    low: rs.map((r) => r.l ?? r.c),
    close: rs.map((r) => r.c),
    volume: rs.map((r) => r.v ?? 0),
  };
}

/** 簡單移動平均；資料不足的位置為 null。O(n) 滑動視窗 */
export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** 指數移動平均：以前 n 筆的 SMA 作為起點（避免第一筆權重過大）；null 值會被跳過 */
export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  let seed = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isNum(v)) continue;
    if (prev === null) {
      seed.push(v);
      if (seed.length === n) { prev = mean(seed); out[i] = prev; seed = null; }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI（Wilder 平滑） */
export function rsi(close, n = 14) {
  const out = new Array(close.length).fill(null);
  if (close.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = close[i] - close[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** KD（隨機指標，台股常用 9,3,3） */
export function kd(high, low, close, n = 9) {
  const K = new Array(close.length).fill(null);
  const D = new Array(close.length).fill(null);
  let k = 50;
  let d = 50;
  for (let i = n - 1; i < close.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) { if (high[j] > hh) hh = high[j]; if (low[j] < ll) ll = low[j]; }
    const rsv = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
    k = (2 / 3) * k + rsv / 3;
    d = (2 / 3) * d + k / 3;
    K[i] = k; D[i] = d;
  }
  return { K, D };
}

/** MACD：DIF、DEA（訊號線）、柱狀 */
export function macd(close, fast = 12, slow = 26, signal = 9) {
  const ef = ema(close, fast);
  const es = ema(close, slow);
  const dif = close.map((_, i) => (isNum(ef[i]) && isNum(es[i]) ? ef[i] - es[i] : null));
  const dea = ema(dif, signal);
  const osc = dif.map((v, i) => (isNum(v) && isNum(dea[i]) ? v - dea[i] : null));
  return { dif, dea, osc };
}

/** 區間報酬率（%）：5/20/60 交易日、年初至今、近一年 */
export function returns(dates, close) {
  const n = close.length;
  if (!n) return {};
  const lastC = close[n - 1];
  const back = (k) => (n > k ? (lastC / close[n - 1 - k] - 1) * 100 : null);
  const lastDate = dates[n - 1];
  const yearStart = lastDate.slice(0, 4) + '-01-01';
  let ytdBase = null;
  for (let i = n - 1; i >= 0; i--) if (dates[i] < yearStart) { ytdBase = close[i]; break; }
  const oneYearAgo = String(+lastDate.slice(0, 4) - 1) + lastDate.slice(4);
  const i1y = dates.findIndex((d) => d >= oneYearAgo);
  return {
    d5: back(5), d20: back(20), d60: back(60),
    ytd: ytdBase ? (lastC / ytdBase - 1) * 100 : null,
    y1: i1y > 0 ? (lastC / close[i1y] - 1) * 100 : null,
  };
}

/**
 * 相對大盤與風險（參考 Finviz / Stock Analysis 的 Beta、波動度、相對報酬）
 * @param {{dates,close}} ps     個股（priceSeries）
 * @param {{label,dates,close}|null} bench  大盤（台股：加權指數；美股：S&P 500）
 * 只用兩邊都有收盤的日子對齊；不足 120 個共同交易日就回傳 null（數字不可靠）。
 *   Beta     近一年日報酬：cov(個股, 大盤) ÷ var(大盤)
 *   波動度    近一年日報酬標準差 × √252（年化，%）
 *   最大回撤  近一年從前高跌下來的最大幅度（%）
 */
export function riskStats(ps, bench) {
  if (!bench?.dates?.length || !ps?.dates?.length) return null;
  const bm = new Map(bench.dates.map((d, i) => [d, bench.close[i]]));
  const pts = ps.dates.map((d, i) => [d, ps.close[i], bm.get(d)]).filter(([, a, b]) => isNum(a) && isNum(b) && a > 0 && b > 0);
  if (pts.length < 120) return null;
  const win = pts.slice(-251);                          // 近一年（250 個報酬）
  const ra = []; const rb = [];
  for (let i = 1; i < win.length; i++) { ra.push(win[i][1] / win[i - 1][1] - 1); rb.push(win[i][2] / win[i - 1][2] - 1); }
  const ma = mean(ra); const mb = mean(rb);
  let cov = 0; let vb = 0; let va = 0;
  for (let i = 0; i < ra.length; i++) { cov += (ra[i] - ma) * (rb[i] - mb); vb += (rb[i] - mb) ** 2; va += (ra[i] - ma) ** 2; }
  const n1 = ra.length - 1;
  let peak = -Infinity; let mdd = 0;
  for (const [, c] of win) { peak = Math.max(peak, c); mdd = Math.min(mdd, (c / peak - 1) * 100); }
  const lastP = pts[pts.length - 1];
  const period = (k) => {
    if (pts.length <= k) return null;
    const a = (lastP[1] / pts[pts.length - 1 - k][1] - 1) * 100;
    const b = (lastP[2] / pts[pts.length - 1 - k][2] - 1) * 100;
    return { stock: a, bench: b, excess: a - b };
  };
  return {
    label: bench.label || '大盤',
    date: lastP[0],
    periods: { m1: period(21), m3: period(63), m6: period(126), y1: period(250) },
    beta: vb > 0 ? cov / vb : null,
    vol: n1 > 0 ? Math.sqrt(va / n1) * Math.sqrt(252) * 100 : null,
    benchVol: n1 > 0 ? Math.sqrt(vb / n1) * Math.sqrt(252) * 100 : null,
    mdd,
    days: ra.length,
  };
}

/** 均線排列判斷 */
export function maAlignment(m5, m20, m60, m240) {
  if (![m5, m20, m60].every(isNum)) return '資料不足';
  const longOk = !isNum(m240);
  if (m5 > m20 && m20 > m60 && (longOk || m60 > m240)) return isNum(m240) ? '多頭排列（5>20>60>240）' : '多頭排列（5>20>60）';
  if (m5 < m20 && m20 < m60 && (longOk || m60 < m240)) return isNum(m240) ? '空頭排列（5<20<60<240）' : '空頭排列（5<20<60）';
  return '均線糾結';
}

/** 技術面摘要 */
export function technicals(ps) {
  const { close, high, low, dates } = ps;
  const n = close.length;
  if (n < 30) return null;
  const ma = { 5: sma(close, 5), 20: sma(close, 20), 60: sma(close, 60), 240: sma(close, 240) };
  const { K, D } = kd(high, low, close);
  const r = rsi(close);
  const m = macd(close);
  const i = n - 1;
  const crossed = (a, b, look = 3) => {
    for (let j = i; j > i - look && j > 0; j--) {
      if (![a[j], b[j], a[j - 1], b[j - 1]].every(isNum)) continue;
      if (a[j - 1] <= b[j - 1] && a[j] > b[j]) return 'golden';
      if (a[j - 1] >= b[j - 1] && a[j] < b[j]) return 'dead';
    }
    return null;
  };
  const win = (k) => close.slice(Math.max(0, n - k));
  const lowWin = (k) => Math.min(...low.slice(Math.max(0, n - k)));
  const highWin = (k) => Math.max(...high.slice(Math.max(0, n - k)));
  const avgVol20 = mean(ps.volume.slice(-21, -1));
  return {
    date: dates[i],
    close: close[i],
    ma: { 5: ma[5][i], 20: ma[20][i], 60: ma[60][i], 240: ma[240][i] },
    maSeries: { 20: ma[20], 60: ma[60] },
    alignment: maAlignment(ma[5][i], ma[20][i], ma[60][i], ma[240][i]),
    k: K[i], d: D[i], kdCross: crossed(K, D),
    rsi: r[i],
    dif: m.dif[i], dea: m.dea[i], osc: m.osc[i], macdCross: crossed(m.dif, m.dea),
    returns: returns(dates, close),
    pct1y: percentileRank(win(250), close[i]),
    pct3y: percentileRank(close, close[i]),
    levels: {
      low20: lowWin(20), high20: highWin(20), low60: lowWin(60), high60: highWin(60),
      low250: lowWin(250), high250: highWin(250),
    },
    volRatio: avgVol20 ? ps.volume[i] / avgVol20 : null,   // 今日量 ÷ 前 20 日均量
  };
}

/* ───────────── 本益比河流圖 ───────────── */

const RIVER_P = [0.1, 0.25, 0.5, 0.75, 0.9];

export function peRiver(ps, perTable) {
  const perByDate = new Map();
  for (const r of rows(perTable)) {
    const pe = toNum(r.PER);
    if (isNum(pe) && pe > 0) perByDate.set(r.date, pe);
  }
  const dates = [];
  const price = [];
  const eps = [];
  const pes = [];
  ps.dates.forEach((d, i) => {
    const pe = perByDate.get(d);
    if (pe) { dates.push(d); price.push(ps.close[i]); eps.push(ps.close[i] / pe); pes.push(pe); }
  });
  if (pes.length < 60) return null;     // 虧損股或資料太短：河流圖沒有意義
  const sorted = [...pes].sort((a, b) => a - b);
  const mults = RIVER_P.map((p) => quantile(sorted, p));
  const curPE = last(pes);
  const curEPS = last(eps);
  const zone = curPE < mults[0] ? '極低' : curPE < mults[1] ? '偏低' : curPE <= mults[3] ? '合理' : curPE <= mults[4] ? '偏高' : '極高';
  return {
    dates, price,
    mults,
    bands: mults.map((m) => eps.map((e) => e * m)),
    currentPE: curPE,
    currentEPS: curEPS,           // 隱含近四季 EPS = 收盤 ÷ 本益比
    zone,
    percentile: percentileRank(pes, curPE),
    fair: { low: curEPS * mults[1], mid: curEPS * mults[2], high: curEPS * mults[3] },
  };
}

/* ───────────── 月營收 ─────────────
   重要：FinMind 的 date 是「次月 1 日」（例：2026-10-01 代表 9 月營收），
   月份必須用 revenue_year / revenue_month（舊版用 date，所以月份全部晚一個月）。 */

export function revenueStats(table) {
  const list = rows(table)
    .map((r) => ({ y: toNum(r.revenue_year), m: toNum(r.revenue_month), rev: toNum(r.revenue) }))
    .filter((r) => isNum(r.y) && isNum(r.m) && isNum(r.rev))
    .sort((a, b) => a.y * 12 + a.m - (b.y * 12 + b.m));
  if (!list.length) return null;
  const byKey = new Map(list.map((r) => [r.y * 12 + r.m, r.rev]));
  const items = list.map((r) => {
    const k = r.y * 12 + r.m;
    const ly = byKey.get(k - 12);
    const pm = byKey.get(k - 1);
    return {
      period: period(r.y, r.m), y: r.y, m: r.m, revenue: r.rev,
      yoy: ly ? (r.rev / ly - 1) * 100 : null,
      mom: pm ? (r.rev / pm - 1) * 100 : null,
    };
  });
  const latest = last(items);
  const ytdNow = list.filter((r) => r.y === latest.y && r.m <= latest.m);
  const ytdPrev = ytdNow.map((r) => byKey.get(r.y * 12 + r.m - 12));
  const ytdYoY = ytdPrev.every(isNum) && ytdPrev.length
    ? (sumOrNull(ytdNow.map((r) => r.rev)) / sumOrNull(ytdPrev) - 1) * 100 : null;
  const l12 = items.slice(-12);
  const p12 = items.slice(-24, -12);
  return {
    items,
    latest,
    avgYoY3: mean(items.slice(-3).map((x) => x.yoy).filter(isNum)),
    ytdYoY,
    ttmYoY: l12.length === 12 && p12.length === 12
      ? (sumOrNull(l12.map((x) => x.revenue)) / sumOrNull(p12.map((x) => x.revenue)) - 1) * 100 : null,
  };
}

/* ───────────── 籌碼 ───────────── */

/** FinMind 法人名稱 → 類別。Foreign_Dealer_Self（外資自營商）算外資 */
function instKind(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('foreign')) return 'foreign';
  if (n.includes('investment_trust')) return 'trust';
  if (n.includes('dealer')) return 'dealer';
  return null;
}

/** 三大法人：每日淨買賣（股）、近 5 / 20 日合計、外資連續買賣超天數 */
export function instStats(table) {
  const byDate = new Map();
  for (const r of rows(table)) {
    const kind = instKind(r.name);
    if (!kind) continue;
    const net = (toNum(r.buy) ?? 0) - (toNum(r.sell) ?? 0);
    if (!byDate.has(r.date)) byDate.set(r.date, { date: r.date, foreign: 0, trust: 0, dealer: 0 });
    byDate.get(r.date)[kind] += net;
  }
  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!days.length) return null;
  days.forEach((d) => { d.total = d.foreign + d.trust + d.dealer; });
  const sum = (k, n) => days.slice(-n).reduce((s, d) => s + d[k], 0);
  let streak = 0;
  const sign = Math.sign(last(days).foreign);
  for (let i = days.length - 1; i >= 0 && sign !== 0 && Math.sign(days[i].foreign) === sign; i--) streak++;
  return {
    days,
    latest: last(days),
    sum5: { foreign: sum('foreign', 5), trust: sum('trust', 5), dealer: sum('dealer', 5), total: sum('total', 5) },
    sum20: { foreign: sum('foreign', 20), trust: sum('trust', 20), dealer: sum('dealer', 20), total: sum('total', 20) },
    foreignStreak: sign * streak,        // +3 = 外資連 3 買；-2 = 連 2 賣
  };
}

/** 融資融券（單位：張） */
export function marginStats(table) {
  const rs = rows(table).sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!rs.length) return null;
  const cur = last(rs);
  const ref = rs[Math.max(0, rs.length - 21)];
  const m = toNum(cur.MarginPurchaseTodayBalance);
  const s = toNum(cur.ShortSaleTodayBalance);
  const m0 = toNum(ref.MarginPurchaseTodayBalance);
  const s0 = toNum(ref.ShortSaleTodayBalance);
  return {
    date: cur.date,
    margin: m, short: s,
    shortRatio: isNum(m) && m > 0 && isNum(s) ? (s / m) * 100 : null,   // 券資比
    marginChg20: isNum(m) && isNum(m0) ? m - m0 : null,
    shortChg20: isNum(s) && isNum(s0) ? s - s0 : null,
  };
}

/** 外資持股比例 */
export function holdingStats(table) {
  const rs = rows(table)
    .map((r) => ({ d: r.date, v: toNum(r.ForeignInvestmentSharesRatio) }))
    .filter((r) => isNum(r.v))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  if (!rs.length) return null;
  const cur = last(rs);
  const at = (k) => rs[Math.max(0, rs.length - 1 - k)].v;
  return { date: cur.d, ratio: cur.v, chg20: cur.v - at(20), chg60: cur.v - at(60) };
}

/* ───────────── 基本面（財報）─────────────
   會計科目名稱以「type 優先、中文名稱備援」比對，FinMind 改名時仍能抓到。 */

const ACCOUNTS = {
  eps: { types: ['EPS'], origin: ['每股盈餘'] },
  revenue: { types: ['Revenue'], origin: ['營業收入'] },
  gross: { types: ['GrossProfit'], origin: ['營業毛利'] },
  op: { types: ['OperatingIncome'], origin: ['營業利益'] },
  ni: { types: ['IncomeAfterTaxes', 'IncomeAfterTax', 'NetIncome'], origin: ['本期淨利', '本期稅後淨利'] },
  assets: { types: ['TotalAssets'], origin: ['資產總計', '資產總額'] },
  liab: { types: ['Liabilities'], origin: ['負債總計', '負債總額'] },
  equity: { types: ['Equity', 'EquityAttributableToOwnersOfParent'], origin: ['權益總計', '權益總額'] },
  ca: { types: ['CurrentAssets'], origin: ['流動資產合計'] },
  cl: { types: ['CurrentLiabilities'], origin: ['流動負債合計'] },
  ocf: { types: ['OperatingCashFlow'], origin: [] },
  capex: { types: ['Capex'], origin: [] },
};

function byQuarter(table, keys) {
  const q = new Map();
  for (const r of rows(table)) {
    const t = String(r.type || '');
    if (t.endsWith('_per')) continue;
    const v = toNum(r.value);
    if (!isNum(v) || !r.date) continue;
    if (!q.has(r.date)) q.set(r.date, { date: r.date, _src: {} });
    const rec = q.get(r.date);
    for (const k of keys) {
      const acc = ACCOUNTS[k];
      const byType = acc.types.includes(t);
      const byOrigin = acc.origin.some((o) => String(r.origin_name || '').includes(o));
      // type 完全相符優先；中文名稱只在還沒有值時補上
      if (byType && rec._src[k] !== 'type') { rec[k] = v; rec._src[k] = 'type'; }
      else if (byOrigin && rec[k] === undefined) { rec[k] = v; rec._src[k] = 'origin'; }
    }
  }
  return [...q.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 台股現金流量表（FinMind TaiwanStockCashFlowsStatement）→ 單季 {date, ocf, capex} 的 income 格式列
 * 台灣財報的現金流量表是「年初至今累計」：Q1 = 1–3 月、Q2 = 1–6 月 … → 單季 = 本期 − 同年上一期。
 * 同年缺上一期（例如只有 6 月沒有 3 月）時無法拆，該季略過（寧缺勿錯）。
 * 資本支出（取得不動產、廠房及設備）在報表上是負數 → 一律轉正，FCF = 營業現金流 − 資本支出。
 */
export function twCashflowRows(table) {
  const ytd = new Map();      // date → {ocf, capex}
  for (const r of rows(table)) {
    const v = toNum(r.value);
    if (!isNum(v) || !r.date) continue;
    const t = String(r.type || '');
    const o = String(r.origin_name || '');
    const rec = ytd.get(r.date) || {};
    if (['CashFlowsFromOperatingActivities', 'NetCashInflowFromOperatingActivities'].includes(t) || (o.includes('營業活動之淨現金') && rec.ocf === undefined)) rec.ocf = v;
    if ((t === 'PropertyAndPlantAndEquipment' || (o.startsWith('取得不動產、廠房及設備') && !o.includes('預付'))) && rec.capex === undefined) rec.capex = Math.abs(v);
    ytd.set(r.date, rec);
  }
  const dates = [...ytd.keys()].sort();
  const out = [];
  for (const d of dates) {
    const m = +d.slice(5, 7);
    const cur = ytd.get(d);
    let q;
    if (m <= 3) q = cur;
    else {
      const pd = dates.filter((x) => x.slice(0, 4) === d.slice(0, 4) && x < d).pop();
      const pm = pd ? +pd.slice(5, 7) : 0;
      if (!pd || m - pm !== 3) continue;
      const prev = ytd.get(pd);
      q = { ocf: isNum(cur.ocf) && isNum(prev.ocf) ? cur.ocf - prev.ocf : undefined, capex: isNum(cur.capex) && isNum(prev.capex) ? cur.capex - prev.capex : undefined };
    }
    if (isNum(q.ocf)) out.push([d, 'OperatingCashFlow', q.ocf, '營業活動現金流（單季）']);
    if (isNum(q.capex)) out.push([d, 'Capex', q.capex, '資本支出（單季）']);
  }
  return out;
}

/** income 表接上現金流列（台股用；美股的 SEC 資料已經是單季並放在 income 表） */
function withCashflow(incomeTable, cashflowTable) {
  const extra = twCashflowRows(cashflowTable);
  if (!extra.length) return incomeTable;
  const cols = incomeTable?.cols || ['date', 'type', 'value', 'origin_name'];
  const idx = (c) => cols.indexOf(c);
  const mk = ([d, t, v, o]) => { const r = cols.map(() => null); r[idx('date')] = d; r[idx('type')] = t; r[idx('value')] = v; if (idx('origin_name') >= 0) r[idx('origin_name')] = o; return r; };
  return { cols, rows: [...(incomeTable?.rows || []), ...extra.map(mk)] };
}

/** 民國或西元年 → 西元年（"113年" → 2024、"113年第2季" → 2024、"2024" → 2024） */
function adYear(text) {
  const n = parseInt(String(text ?? '').replace(/\D.*$/, ''), 10);
  if (!Number.isFinite(n)) return null;
  return n < 1911 ? n + 1911 : n;
}

/**
 * 股利政策與填息（參考 Goodinfo 股利政策、財報狗填息天數）
 * @param dividendTable  FinMind TaiwanStockDividend（每次董事會 / 股東會決議一列；季配息公司一年多列）
 * @param resultTable    FinMind TaiwanStockDividendResult（每次除權息一列：除權息前收盤 before_price）
 * @param ps             priceSeries（判斷填息：除息日起，收盤 ≥ 除息前收盤的第一天）
 * @param quarters       fundamentals().quarters（算配發率：現金股利 ÷ 該年度 EPS）
 */
export function dividendStats(dividendTable, resultTable, ps, quarters = []) {
  const pol = rows(dividendTable);
  const res = rows(resultTable);
  if (!pol.length && !res.length) return null;
  // 年度政策：盈餘年度（year 欄）彙總現金 / 股票股利
  const years = new Map();
  for (const r of pol) {
    const y = adYear(r.year) ?? (r.date ? +r.date.slice(0, 4) - 1 : null);
    if (!y) continue;
    const rec = years.get(y) || { year: y, cash: 0, stock: 0, times: 0 };
    rec.cash += (toNum(r.CashEarningsDistribution) || 0) + (toNum(r.CashStatutorySurplus) || 0);
    rec.stock += (toNum(r.StockEarningsDistribution) || 0) + (toNum(r.StockStatutorySurplus) || 0);
    rec.times += 1;
    years.set(y, rec);
  }
  const epsYear = new Map();
  for (const q of quarters) {
    if (!isNum(q.eps)) continue;
    const y = +q.date.slice(0, 4);
    const e = epsYear.get(y) || { sum: 0, n: 0 };
    e.sum += q.eps; e.n += 1; epsYear.set(y, e);
  }
  const policy = [...years.values()].sort((a, b) => a.year - b.year).map((r) => {
    const e = epsYear.get(r.year);
    return { ...r, cash: +r.cash.toFixed(4), stock: +r.stock.toFixed(4), eps: e && e.n === 4 ? e.sum : null,
      payout: e && e.n === 4 && e.sum > 0 ? (r.cash / e.sum) * 100 : null };
  });
  // 連續發放現金股利年數（從最近一年往回數）
  let streak = 0;
  for (let i = policy.length - 1; i >= 0 && policy[i].cash > 0; i--) streak++;

  // 填息天數：除息日當天算第 1 個交易日
  const idx = new Map(ps.dates.map((d, i) => [d, i]));
  const events = res.filter((r) => r.date && isNum(toNum(r.before_price))).sort((a, b) => (a.date < b.date ? -1 : 1)).map((r) => {
    const before = toNum(r.before_price);
    let i0 = idx.get(r.date);
    if (i0 === undefined) i0 = ps.dates.findIndex((d) => d >= r.date);
    let fillDays = null;
    let fillDate = null;
    if (i0 >= 0) {
      for (let i = i0; i < ps.close.length; i++) if (ps.close[i] >= before) { fillDays = i - i0 + 1; fillDate = ps.dates[i]; break; }
    }
    const since = i0 >= 0 ? ps.close.length - i0 : null;
    const lastClose = ps.close.length ? ps.close[ps.close.length - 1] : null;
    return {
      date: r.date, kind: r.stock_or_cache_dividend || '', dividend: toNum(r.stock_and_cache_dividend),
      before, after: toNum(r.after_price), fillDays, fillDate, filled: fillDays !== null,
      inData: i0 >= 0, tradingDaysSince: since,
      gap: fillDays === null && isNum(lastClose) && before ? ((lastClose / before) - 1) * 100 : null,
    };
  });
  const known = events.filter((e) => e.inData);
  const filled = known.filter((e) => e.filled);
  const recent = filled.slice(-5);
  return {
    policy,
    streak,
    events,
    fillRate: known.length ? (filled.length / known.length) * 100 : null,
    avgFillDays: recent.length ? recent.reduce((a, e) => a + e.fillDays, 0) / recent.length : null,
    last: events[events.length - 1] || null,
  };
}

/** 美股內部人交易（SEC Form 4）。代碼：P 公開市場買進、S 賣出、A 獎酬、M 行使、F 繳稅扣股、G 贈與 */
export const INSIDER_CODES = { P: '公開市場買進', S: '公開市場賣出', A: '獎酬配股', M: '行使選擇權', F: '繳稅扣股', G: '贈與', D: '返還公司', C: '轉換', X: '行使權證', J: '其他' };

export function insiderStats(insider, days = 180, asOf = null) {
  const fs = Object.values(insider?.filings || {});
  if (!fs.length && !insider) return null;
  const txs = fs.flatMap((f) => (f.tx || []).map((t) => ({ ...t, filed: f.filed })))
    .filter((t) => t.date)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const end = asOf || txs[0]?.date || null;
  const since = end ? new Date(Date.parse(end) - days * 864e5).toISOString().slice(0, 10) : null;
  const win = txs.filter((t) => !since || t.date >= since);
  const agg = (code) => {
    const xs = win.filter((t) => t.code === code);
    const value = xs.reduce((a, t) => a + (isNum(t.price) ? t.shares * t.price : 0), 0);
    return { n: xs.length, people: new Set(xs.map((t) => t.owner)).size, shares: xs.reduce((a, t) => a + t.shares, 0), value, plan: xs.filter((t) => t.plan).length };
  };
  const buy = agg('P');
  const sell = agg('S');
  return {
    since, end, filings: fs.length, buy, sell,
    net: buy.value - sell.value,
    recent: txs.slice(0, 20),
  };
}

/**
 * 同業比較：同產業（台股：證交所產業別；美股：GICS 產業）的本益比、營收年增、ROE、殖利率排名
 * @param screen  screen.json / us/screen.json（{cols, rows}）
 * @returns {null | {industry, n, me, ranks:{pe,revYoY,roe,yield}: {rank, of, median}, peers:[row]}}
 */
export function peerStats(screen, code, key = 'industry') {
  const list = rows(screen);
  const me = list.find((r) => r.code === code);
  if (!me || !me[key]) return null;
  const peers = list.filter((r) => r[key] === me[key]);
  if (peers.length < 2) return null;
  const rank = (field, asc) => {
    const xs = peers.filter((r) => isNum(r[field]) && (field !== 'pe' || r[field] > 0));
    if (!isNum(me[field]) || (field === 'pe' && me[field] <= 0)) return { rank: null, of: xs.length, median: median(xs.map((r) => r[field])) };
    const sorted = [...xs].sort((a, b) => (asc ? a[field] - b[field] : b[field] - a[field]));
    return { rank: sorted.findIndex((r) => r.code === code) + 1, of: xs.length, median: median(xs.map((r) => r[field])) };
  };
  return {
    industry: me[key], n: peers.length, me,
    ranks: { pe: rank('pe', true), revYoY: rank('revYoY', false), roe: rank('roe', false), yield: rank('yield', false) },
    peers,
  };
}

function median(xs) {
  const v = xs.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function fundamentals(incomeTable, balanceTable) {
  const inc = byQuarter(incomeTable, ['eps', 'revenue', 'gross', 'op', 'ni', 'ocf', 'capex']);
  const bal = byQuarter(balanceTable, ['assets', 'liab', 'equity', 'ca', 'cl']);
  if (!inc.length && !bal.length) return null;

  const ratio = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? (a / b) * 100 : null);
  const margins = (q) => q && { gross: ratio(q.gross, q.revenue), op: ratio(q.op, q.revenue), net: ratio(q.ni, q.revenue) };
  const lastQ = last(inc);
  const sameQLastYear = lastQ && inc.find((q) => q.date === String(+lastQ.date.slice(0, 4) - 1) + lastQ.date.slice(4));

  const epsList = inc.filter((q) => isNum(q.eps));
  const eps4 = epsList.length >= 4 ? sumOrNull(epsList.slice(-4).map((q) => q.eps)) : null;
  const epsPrev4 = epsList.length >= 8 ? sumOrNull(epsList.slice(-8, -4).map((q) => q.eps)) : null;

  const niList = inc.filter((q) => isNum(q.ni));
  const ni4 = niList.length >= 4 ? sumOrNull(niList.slice(-4).map((q) => q.ni)) : null;
  const lastB = last(bal);
  const prevB = bal.length >= 5 ? bal[bal.length - 5] : bal[0];
  const avg = (k) => (lastB && isNum(lastB[k]) && prevB && isNum(prevB[k]) ? (lastB[k] + prevB[k]) / 2 : null);

  return {
    quarters: inc.map((q) => {
      const ly = inc.find((x) => x.date === String(+q.date.slice(0, 4) - 1) + q.date.slice(4));
      return {
        date: q.date, eps: q.eps ?? null, revenue: q.revenue ?? null, ...margins(q),
        revYoY: ly && isNum(q.revenue) && isNum(ly.revenue) && ly.revenue ? ((q.revenue - ly.revenue) / Math.abs(ly.revenue)) * 100 : null,
        fcf: isNum(q.ocf) && isNum(q.capex) ? q.ocf - q.capex : null,
      };
    }),
    // 自由現金流 = 營業現金流 − 資本支出（目前只有美股 SEC 財報有現金流量表）
    fcf4: (() => { const xs = inc.filter((q) => isNum(q.ocf) && isNum(q.capex)).slice(-4); return xs.length === 4 ? sumOrNull(xs.map((q) => q.ocf - q.capex)) : null; })(),
    ni4,
    latestQuarter: lastQ?.date ?? null,
    eps4, epsPrev4,
    eps4YoY: isNum(eps4) && isNum(epsPrev4) && epsPrev4 !== 0 ? ((eps4 - epsPrev4) / Math.abs(epsPrev4)) * 100 : null,
    margins: margins(lastQ),
    marginsLastYear: margins(sameQLastYear),
    revYoY: lastQ && sameQLastYear && isNum(lastQ.revenue) && isNum(sameQLastYear.revenue) && sameQLastYear.revenue
      ? ((lastQ.revenue - sameQLastYear.revenue) / Math.abs(sameQLastYear.revenue)) * 100 : null,
    roe: ratio(ni4, avg('equity')),
    roa: ratio(ni4, avg('assets')),
    debtRatio: lastB ? ratio(lastB.liab, lastB.assets) : null,
    currentRatio: lastB ? ratio(lastB.ca, lastB.cl) : null,
    balanceDate: lastB?.date ?? null,
  };
}

/* ───────────── 總整理 ───────────── */

const MCOLS = ['close', 'change', 'open', 'high', 'low', 'volume', 'pe', 'pb', 'yield', 'foreign', 'trust', 'dealer', 'inst'];

/** market.json 的一列陣列 → 物件 */
export function marketRow(market, code) {
  const r = market?.rows?.[code];
  if (!r) return null;
  const cols = market.cols || MCOLS;
  return Object.fromEntries(cols.map((c, i) => [c, r[i]]));
}

/**
 * 組合所有資料成單一摘要
 * @param {object} p
 * @param {{code,name,market,industry}} p.info
 * @param {object|null} p.mkt     marketRow() 結果（全市場官方資料，收盤後）
 * @param {object|null} p.quote   Yahoo 盤中價（只有追蹤清單）
 * @param {object} p.tables       FinMind 個股資料表
 * @param {object} p.asOf         market.json 的 asOf
 */
const SOURCE = { twse: '證交所', tpex: '櫃買中心', us: 'Yahoo + SEC 推算' };

export function summarize({ info, mkt, quote, tables = {}, asOf = {}, bench = null }) {
  const ps = priceSeries(tables.price);
  const tech = technicals(ps);
  const fmLast = ps.close.length ? { date: last(ps.dates), close: last(ps.close), prev: ps.close[ps.close.length - 2] } : null;
  const per = rows(tables.per);
  const perLast = per.length ? per[per.length - 1] : null;

  // 價格優先序：盤中報價（比官方收盤新時）→ 官方收盤 → FinMind 收盤
  const officialDate = info.market === 'tpex' ? asOf.tpex : asOf.twse;
  let px = null;
  if (mkt && isNum(mkt.close)) {
    const chg = isNum(mkt.change) ? mkt.change : null;
    px = { price: mkt.close, change: chg, changePct: isNum(chg) && mkt.close - chg ? (chg / (mkt.close - chg)) * 100 : null, asOf: officialDate, source: info.market === 'us' ? 'Yahoo' : SOURCE[info.market] ?? '證交所', kind: '收盤' };
  } else if (fmLast) {
    const chg = isNum(fmLast.prev) ? fmLast.close - fmLast.prev : null;
    px = { price: fmLast.close, change: chg, changePct: isNum(chg) ? (chg / fmLast.prev) * 100 : null, asOf: fmLast.date, source: 'FinMind', kind: '收盤' };
  }
  if (quote && isNum(quote.value) && (!px || (quote.time || '').slice(0, 10) > (px.asOf || ''))) {
    px = { price: quote.value, change: quote.change, changePct: quote.changePct, asOf: quote.time, source: 'Yahoo（約延遲 20 分）', kind: '盤中' };
  }

  const pos = (v) => (isNum(v) && v > 0 ? v : null);   // 虧損公司本益比為 0 → 缺資料，不顯示 0 倍
  const valuation = {
    pe: pos(mkt?.pe) ?? pos(toNum(perLast?.PER)),
    pb: pos(mkt?.pb) ?? pos(toNum(perLast?.PBR)),
    yield: mkt?.yield ?? toNum(perLast?.dividend_yield),
    source: isNum(mkt?.pe) || isNum(mkt?.pb) ? (SOURCE[info.market] ?? '證交所') : perLast ? 'FinMind' : null,
    asOf: isNum(mkt?.pe) || isNum(mkt?.pb) ? officialDate : perLast?.date ?? null,
  };

  const inst = instStats(tables.inst);
  const fund = fundamentals(withCashflow(tables.income, tables.cashflow), tables.balance);
  // 上市股的法人資料來自證交所 T86（有自己的日期）；上櫃股來自櫃買中心（與行情同日）
  const today = mkt && isNum(mkt.foreign)
    ? info.market === 'tpex'
      ? { foreign: mkt.foreign, trust: mkt.trust, dealer: mkt.dealer, total: mkt.inst, date: officialDate, source: '櫃買中心' }
      : { foreign: mkt.foreign, trust: mkt.trust, dealer: mkt.dealer, total: mkt.inst, date: asOf.inst || officialDate, source: '證交所 T86' }
    : inst ? { ...inst.latest, source: 'FinMind' } : null;

  return {
    info,
    price: px,
    valuation,
    instToday: today,
    inst,
    tech,
    river: ps.close.length ? peRiver(ps, tables.per) : null,
    revenue: revenueStats(tables.revenue),
    margin: marginStats(tables.margin),
    holding: holdingStats(tables.holding),
    fundamentals: fund,
    dividends: dividendStats(tables.dividend, tables.divResult, ps, fund?.quarters),
    risk: riskStats(ps, bench),
    shares: info.shares ?? null,
    series: ps,
  };
}

/** 資料完整度：對照「七段分析」需要的欄位，列出缺哪些 */
export function completeness(s) {
  const f = s.fundamentals;
  const us = s.info?.market === 'us';
  // ETF 沒有本益比、營收、財報；美股沒有殖利率、法人、融資券、月營收、本益比歷史 → 不列入完整度
  const etf = us ? !!s.info?.etf : String(s.info?.code ?? '').startsWith('00');
  const checks = [
    ['股價', isNum(s.price?.price)],
    ['本益比', isNum(s.valuation?.pe), 'stock'],
    ['股價淨值比', isNum(s.valuation?.pb), 'stock'],
    ['殖利率', isNum(s.valuation?.yield), 'stock', 'tw'],
    ['三大法人（當日）', isNum(s.instToday?.foreign), 'tw'],
    ['三大法人（20 日）', !!s.inst, 'tw'],
    ['外資持股比例', isNum(s.holding?.ratio), 'tw'],
    ['融資融券', isNum(s.margin?.margin), 'tw'],
    ['月營收年增率', isNum(s.revenue?.latest?.yoy), 'stock', 'tw'],
    ['近四季 EPS', isNum(f?.eps4), 'stock'],
    ['毛利率 / 營益率', isNum(f?.margins?.gross), 'stock'],
    ['ROE', isNum(f?.roe), 'stock'],
    ['負債比', isNum(f?.debtRatio), 'stock'],
    ['均線', isNum(s.tech?.ma?.[60])],
    ['KD / RSI / MACD', isNum(s.tech?.k) && isNum(s.tech?.rsi) && isNum(s.tech?.dif)],
    ['本益比河流圖', !!s.river, 'stock', 'tw'],
    ['一年價格位階', isNum(s.tech?.pct1y)],
  ].filter(([, , only, tw]) => !(etf && only === 'stock') && !(us && (only === 'tw' || tw === 'tw')));
  const ok = checks.filter(([, v]) => v).length;
  return { pct: Math.round((ok / checks.length) * 100), missing: checks.filter(([, v]) => !v).map(([k]) => k), total: checks.length, ok };
}

/**
 * 追蹤清單總覽表的一列（summarize() 結果 → 精簡欄位）。
 * 由 scripts/build_overview.mjs 在 GitHub Actions 預先算好寫成 overview.json，網頁只負責顯示。
 */
export function overviewRow(s) {
  const t = s.tech;
  const f = s.fundamentals;
  const align = t?.alignment ?? '';
  const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
  return {
    code: s.info.code,
    name: s.info.name,
    industry: s.info.industry || '',
    etf: s.info.market === 'us' ? !!s.info.etf : s.info.code.startsWith('00'),
    price: r2(s.price?.price),
    chgPct: r2(s.price?.changePct),
    priceKind: s.price?.kind ?? null,
    spark: (s.series?.close ?? []).slice(-60).map(r2),
    r20: r2(t?.returns?.d20),
    rel1y: r2(s.risk?.periods?.y1?.excess),
    pe: r2(s.valuation?.pe),
    riverPct: r2(s.river?.percentile),
    zone: s.river?.zone ?? null,
    revYoY: r2(s.revenue?.latest?.yoy ?? f?.revYoY),   // 台股：月營收；美股：最新一季營收
    epsYoY: r2(f?.eps4YoY),
    roe: r2(f?.roe),
    f20: s.inst?.sum20?.foreign ?? null,
    t20: s.inst?.sum20?.trust ?? null,
    trend: align.startsWith('多頭') ? 1 : align.startsWith('空頭') ? -1 : align === '均線糾結' ? 0 : null,
    k: r2(t?.k),
    rsi: r2(t?.rsi),
  };
}

/**
 * 美股：用 Yahoo 日線與 SEC 財報組出與台股 market.json 列相同形狀的資料（收盤、漲跌、本益比、股價淨值比），
 * 讓 summarize() 不用分辨台美股。本益比 = 收盤 ÷ 近四季 EPS；股價淨值比 = 收盤 ÷（權益 ÷ 流通股數）。
 * @param {object} detail  us/stock/<代號>.json
 */
export function usMarketRow(detail) {
  const ps = priceSeries(detail?.tables?.price);
  const n = ps.close.length;
  if (!n) return null;
  const close = ps.close[n - 1];
  const prev = n > 1 ? ps.close[n - 2] : null;
  const f = fundamentals(detail.tables.income, detail.tables.balance);
  const lastEquity = [...rows(detail.tables.balance)].reverse().find((r) => r.type === 'Equity');
  const bvps = lastEquity && isNum(detail.shares) && detail.shares > 0 ? toNum(lastEquity.value) / detail.shares : null;
  return {
    close,
    change: isNum(prev) ? close - prev : null,
    pe: isNum(f?.eps4) && f.eps4 > 0 ? close / f.eps4 : null,
    pb: isNum(bvps) && bvps > 0 ? close / bvps : null,
    yield: null, volume: ps.volume?.[n - 1] ?? null,
    date: ps.dates[n - 1],
  };
}
