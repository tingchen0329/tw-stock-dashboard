/**
 * 選股條件回測（追蹤清單、每月換股、等權重）
 *
 * 1. buildPanel()：scripts/build_overview.mjs 在 GitHub Actions 用追蹤清單個股的歷史資料，
 *    逐月算出「換股當時已經公布」的選股欄位與下個月的報酬 → backtest.json（約 100 KB）
 *      月營收：M 月營收最晚 M+1 月 10 日公布 → 換股日只用 10 日已過的月份（用 revenue_year / revenue_month）
 *      季報：Q1 5/15、Q2 8/14、Q3 11/14、年報次年 3/31（一般產業法定期限）前公布 → 期限已過才使用
 *      本益比、股價淨值比、殖利率：證交所每日公布值（換股日前一個交易日）
 *      成交量：換股日前 20 個交易日平均（張）
 *      報酬：還原股價（含息、含減資 / 面額變更）從換股日收盤到下次換股日收盤
 * 2. runBacktest()：網頁依選股頁目前的門檻即時重算（不用重新下載），與「清單等權」「大盤報酬指數」比較
 *
 * 限制（畫面上會寫出來）：股票池是「現在的」追蹤清單 → 倖存者偏差 / 選擇偏差，報酬通常高估；
 * 樣本只有約兩年；以收盤價成交、未計滑價；選不到股票的月份視為持有現金。
 */
import { rows, priceSeries, adjustEvents, adjustedSeries, fundamentals } from './analytics.js';
import { isNum } from './format.js';

export const BT_COLS = ['revYoY', 'revCumYoY', 'eps', 'om', 'roe', 'pe', 'yield', 'volume'];
/** 手續費 0.1425%（未打折）；賣出另加證交稅 0.3% */
export const COST = { buy: 0.001425, sell: 0.001425 + 0.003 };
const OPS = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b };

const pad = (n) => String(n).padStart(2, '0');
const r2 = (v) => (isNum(v) ? Math.round(v * 100) / 100 : null);
const r5 = (v) => (isNum(v) ? Math.round(v * 1e5) / 1e5 : null);
const pos = (v) => (isNum(v) && v > 0 ? v : null);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(+v) ? +v : null);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** 季報公布期限：季底日期 → 期限日期（一般產業） */
export function quarterDeadline(qDate) {
  const md = String(qDate).slice(5, 10);
  const y = +String(qDate).slice(0, 4);
  return { '03-31': `${y}-05-15`, '06-30': `${y}-08-14`, '09-30': `${y}-11-14`, '12-31': `${y + 1}-03-31` }[md] ?? null;
}

/** 月營收公布期限：次月 10 日 */
export const revenueDeadline = (y, m) => (m === 12 ? `${y + 1}-01-10` : `${y}-${pad(m + 1)}-10`);

/** 每月 day 日（含）以後的第一個交易日 */
export function rebalanceDates(dates, day = 11) {
  const out = [];
  let ym = '';
  for (const d of dates) {
    if (d.slice(0, 7) !== ym && +d.slice(8, 10) >= day) { out.push(d); ym = d.slice(0, 7); }
  }
  return out;
}

/** 排序陣列中最後一個 ≤ x 的位置（沒有回傳 -1） */
export function idxLE(arr, x) {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;

/** 一檔股票在換股日 t（訊號日 s = 前一個交易日）的選股欄位 */
export function factorsAt(st, t, s) {
  const out = {};
  // 本益比 / 股價淨值比 / 殖利率：訊號日（含）以前最近一筆，超過 10 天視為缺資料（停牌等）
  const j = idxLE(st.per.dates, s);
  if (j >= 0 && daysBetween(st.per.dates[j], s) <= 10) {
    out.pe = pos(st.per.pe[j]);
    const pb = pos(st.per.pb[j]);
    out.yield = isNum(st.per.yld[j]) && st.per.yld[j] >= 0 ? st.per.yld[j] : null;
    out.roe = out.pe && pb ? (pb / out.pe) * 100 : null;                  // 與選股頁相同的推估法
  }
  // 成交量：訊號日以前 20 個交易日平均（張）
  const k = idxLE(st.ps.dates, s);
  if (k >= 19 && daysBetween(st.ps.dates[k], s) <= 10) out.volume = mean(st.ps.volume.slice(k - 19, k + 1)) / 1000;
  // 月營收：公布期限已過的最新月份
  const L = [...st.rev].reverse().find((r) => revenueDeadline(r.y, r.m) < t);
  if (L) {
    const get = (y, m) => st.revMap.get(y * 12 + m);
    const ly = get(L.y - 1, L.m);
    out.revYoY = isNum(ly) && ly > 0 ? (L.rev / ly - 1) * 100 : null;
    const ms = Array.from({ length: L.m }, (_, i) => i + 1);
    const cur = ms.map((m) => get(L.y, m));
    const prev = ms.map((m) => get(L.y - 1, m));
    const sc = cur.every(isNum) ? cur.reduce((a, b) => a + b, 0) : null;
    const sp = prev.every(isNum) ? prev.reduce((a, b) => a + b, 0) : null;
    out.revCumYoY = isNum(sc) && sp > 0 ? (sc / sp - 1) * 100 : null;
    if (daysBetween(revenueDeadline(L.y, L.m), t) > 70) { out.revYoY = null; out.revCumYoY = null; }   // 資料斷掉兩個月以上
  }
  // 季報：公布期限已過的最新一季 → 今年累計 EPS 與營業利益率（要有同年每一季）
  const avail = st.quarters.filter((q) => { const d = quarterDeadline(q.date); return d && d < t; });
  const q = avail[avail.length - 1];
  if (q && daysBetween(quarterDeadline(q.date), t) <= 200) {
    const y = q.date.slice(0, 4);
    const n = Math.round(+q.date.slice(5, 7) / 3);
    const ytd = avail.filter((x) => x.date.slice(0, 4) === y && x.date <= q.date);
    if (ytd.length === n) {
      out.eps = ytd.every((x) => isNum(x.eps)) ? ytd.reduce((a, x) => a + x.eps, 0) : null;
      const okOm = ytd.every((x) => isNum(x.op) && isNum(x.revenue));
      const rv = okOm ? ytd.reduce((a, x) => a + x.revenue, 0) : null;
      out.om = okOm && rv > 0 ? ytd.reduce((a, x) => a + (x.op / 100) * x.revenue, 0) / rv * 100 : null;
    }
  }
  return out;
}

/** 個股資料表 → 回測需要的序列 */
export function prepStock({ tables = {}, actions = null }) {
  const ps = priceSeries(tables.price);
  const adj = adjustedSeries(ps, adjustEvents(ps, { divResult: tables.divResult, actions }));
  const per = rows(tables.per).filter((r) => r.date).sort((a, b) => (a.date < b.date ? -1 : 1));
  const rev = rows(tables.revenue)
    .map((r) => ({ y: num(r.revenue_year), m: num(r.revenue_month), rev: num(r.revenue) }))
    .filter((r) => isNum(r.y) && isNum(r.m) && isNum(r.rev))
    .sort((a, b) => a.y * 12 + a.m - (b.y * 12 + b.m));
  return {
    ps, adj: adj.close, adjusted: !!tables.divResult,
    per: { dates: per.map((r) => r.date), pe: per.map((r) => num(r.PER)), pb: per.map((r) => num(r.PBR)), yld: per.map((r) => num(r.dividend_yield)) },
    rev, revMap: new Map(rev.map((r) => [r.y * 12 + r.m, r.rev])),
    quarters: fundamentals(tables.income, null)?.quarters ?? [],
  };
}

/**
 * @param {{code,name,industry,tables,actions}[]} stocks  追蹤清單個股（ETF 會略過）
 * @param {{dates:string[], close:number[], label?:string, kind?:string}} bench  大盤（交易日曆也用它）
 */
export function buildPanel(stocks, bench, { day = 11, generatedAt = null } = {}) {
  const cal = bench?.dates ?? [];
  if (cal.length < 60) return null;
  const rd = rebalanceDates(cal, day).filter((d) => d > cal[0]);
  const end = cal[cal.length - 1];
  const dates = rd.filter((d) => d < end);
  if (dates.length < 2) return null;
  const pts = [...dates, end];
  const bAt = (d) => bench.close[idxLE(cal, d)];
  const prevDay = (d) => cal[Math.max(0, idxLE(cal, d) - 1)];
  const out = [];
  for (const s of stocks) {
    if (String(s.code).startsWith('00')) continue;
    const st = prepStock(s);
    if (st.ps.dates.length < 2) continue;
    const rowsOut = dates.map((t, i) => {
      const k0 = idxLE(st.ps.dates, t);
      // 換股日沒有股價（尚未上市）或股價停在 10 天以前（停牌）→ 這期不在股票池
      if (k0 < 0 || daysBetween(st.ps.dates[k0], t) > 10) return null;
      const k1 = idxLE(st.ps.dates, pts[i + 1]);
      const ret = st.adj[k1] / st.adj[k0] - 1;
      const f = factorsAt(st, t, prevDay(t));
      return [...BT_COLS.map((c) => r2(f[c])), r5(ret)];
    });
    if (rowsOut.some(Boolean)) out.push({ code: s.code, name: s.name || '', industry: s.industry || '', adjusted: st.adjusted, rows: rowsOut });
  }
  return {
    version: 1, generatedAt, day, dates, end,
    cols: [...BT_COLS, 'ret'],
    bench: { label: bench.label || '大盤', kind: bench.kind || 'price', ret: dates.map((t, i) => r5(bAt(pts[i + 1]) / bAt(t) - 1)) },
    stocks: out,
  };
}

function curveStats(rets, start, end) {
  const curve = [1];
  for (const r of rets) curve.push(curve[curve.length - 1] * (1 + (isNum(r) ? r : 0)));
  let peak = 1;
  let mdd = 0;
  for (const v of curve) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
  const years = daysBetween(start, end) / 365.25;
  const lastV = curve[curve.length - 1];
  const cagr = years >= 0.9 ? (lastV ** (1 / years) - 1) * 100 : null;
  // 年化波動度：月報酬標準差 × √12（每月換股一次）；報酬 / 風險 = 年化報酬 ÷ 年化波動度（未扣無風險利率）
  const xs = rets.map((r) => (isNum(r) ? r : 0));
  const m = mean(xs);
  const sd = xs.length > 2 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : null;
  const vol = isNum(sd) ? sd * Math.sqrt(12) * 100 : null;
  return { curve, total: (lastV - 1) * 100, cagr, mdd: mdd * 100, vol, ratio: isNum(cagr) && vol > 0 ? cagr / vol : null };
}

/** 可重現的亂數（mulberry32）：同一組條件每次重算的隨機基準都一樣 */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 換股成本：權重變化（買進部分 × 買進成本 + 賣出部分 × 賣出成本） */
function turnoverFee(w, nw, cost) {
  let buys = 0;
  let sells = 0;
  for (const [c, x] of nw) buys += Math.max(0, x - (w.get(c) || 0));
  for (const [c, x] of w) sells += Math.max(0, x - (nw.get(c) || 0));
  return buys * cost.buy + sells * cost.sell;
}

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
};

/**
 * 隨機選股基準（蒙地卡羅）：每一期從同一個股票池「隨機」挑出與策略相同的檔數，同樣扣成本，重複 runs 次。
 * 策略贏過大多數隨機組合，才代表條件本身有選股能力，而不只是股票池（追蹤清單）本來就好。
 * @returns {{runs, p5, p50, p95, beat, curve}}  p* 為累積報酬 %；beat = 策略累積報酬勝過的比例 %；curve = 中位數路徑（每期各自取中位數）
 */
export function randomBaseline(panel, periods, { runs = 500, seed = 20260101, cost = COST } = {}) {
  if (!periods.some((p) => p.n)) return null;
  const ri = panel.cols.indexOf('ret');
  const pools = panel.dates.map((t, i) => panel.stocks.filter((s) => s.rows[i] && isNum(s.rows[i][ri])));
  const next = rng(seed);
  const totals = [];
  const paths = periods.map(() => []);
  for (let k = 0; k < runs; k++) {
    let w = new Map();
    let v = 1;
    periods.forEach((p, i) => {
      const pool = pools[i];
      const n = Math.min(p.n, pool.length);
      const idx = pool.map((_, j) => j);
      for (let j = 0; j < n; j++) {                 // 部分 Fisher–Yates：不重複抽 n 檔
        const r = j + Math.floor(next() * (idx.length - j));
        [idx[j], idx[r]] = [idx[r], idx[j]];
      }
      const picks = idx.slice(0, n).map((j) => pool[j]);
      const nw = new Map(picks.map((s) => [s.code, 1 / n]));
      const fee = turnoverFee(w, nw, cost);
      const gross = n ? mean(picks.map((s) => s.rows[i][ri])) : 0;
      w = nw;
      v *= (1 - fee) * (1 + gross);
      paths[i].push(v);
    });
    totals.push((v - 1) * 100);
  }
  const sorted = [...totals].sort((a, b) => a - b);
  const strat = periods.reduce((a, p) => a * (1 + p.ret), 1) * 100 - 100;
  return {
    runs,
    p5: quantile(sorted, 0.05), p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95),
    beat: (totals.filter((x) => strat > x + 1e-9).length / runs) * 100,
    curve: [1, ...paths.map((xs) => quantile([...xs].sort((a, b) => a - b), 0.5))],
  };
}

/**
 * 依條件回測
 * @param {object} panel   buildPanel() 結果（backtest.json）
 * @param {{key, op, value}[]} criteria  選股頁目前的條件（value 非數字 = 不使用）
 * @param {object} [o]
 * @param {number} [o.maxN]    最多持有幾檔（依 rank 排序取前 N；不填 = 符合的全部持有）
 * @param {{key:string, dir:1|-1}} [o.rank]  排序欄位（缺值排最後）
 * @param {number} [o.runs]    隨機選股基準的模擬次數（0 = 不算）
 */
export function runBacktest(panel, criteria, { cost = COST, maxN = null, rank = null, runs = 500 } = {}) {
  if (!panel?.dates?.length) return null;
  const idx = Object.fromEntries(panel.cols.map((c, i) => [c, i]));
  const used = criteria.filter((c) => isNum(c.value));
  const active = used.filter((c) => c.key in idx && c.key !== 'ret' && OPS[c.op]);
  const skipped = used.filter((c) => !active.includes(c));
  const pass = (row) => active.every((c) => isNum(row[idx[c.key]]) && OPS[c.op](row[idx[c.key]], c.value));
  const rk = rank && rank.key in idx ? idx[rank.key] : null;
  const limit = isNum(maxN) && maxN > 0 ? Math.floor(maxN) : null;
  let w = new Map();
  const periods = panel.dates.map((t, i) => {
    const univ = panel.stocks.filter((s) => s.rows[i] && isNum(s.rows[i][idx.ret]));
    let picks = univ.filter((s) => pass(s.rows[i]));
    const matched = picks.length;
    if (limit && picks.length > limit) {
      const dir = rank?.dir ?? -1;
      // 依排序欄位取前 N（缺值排最後；同值依代號，結果固定）
      picks = [...picks].sort((a, b) => {
        const x = rk === null ? null : a.rows[i][rk];
        const y = rk === null ? null : b.rows[i][rk];
        if (!isNum(x) || !isNum(y)) return (!isNum(x)) - (!isNum(y)) || a.code.localeCompare(b.code);
        return (x - y) * dir || a.code.localeCompare(b.code);
      }).slice(0, limit);
    }
    const nw = new Map(picks.map((s) => [s.code, 1 / picks.length]));
    const fee = turnoverFee(w, nw, cost);
    const gross = picks.length ? mean(picks.map((s) => s.rows[i][idx.ret])) : 0;
    w = nw;
    return {
      date: t, end: panel.dates[i + 1] ?? panel.end, picks: picks.map((s) => s.code), n: picks.length, matched, universe: univ.length,
      gross, fee, ret: (1 - fee) * (1 + gross) - 1,
      univ: univ.length ? mean(univ.map((s) => s.rows[i][idx.ret])) : null,
      bench: panel.bench.ret[i],
    };
  });
  const start = panel.dates[0];
  const S = curveStats(periods.map((p) => p.ret), start, panel.end);
  const U = curveStats(periods.map((p) => p.univ), start, panel.end);
  const B = curveStats(periods.map((p) => p.bench), start, panel.end);
  const cmp = periods.filter((p) => isNum(p.bench));
  const random = runs > 0 ? randomBaseline(panel, periods, { runs, cost }) : null;
  return {
    periods, active, skipped, maxN: limit, rank: limit ? rank : null, random,
    curve: { dates: [...panel.dates, panel.end], strat: S.curve, univ: U.curve, bench: B.curve, random: random?.curve ?? null },
    stats: {
      strat: { ...S, curve: undefined, win: cmp.length ? (cmp.filter((p) => p.ret > p.bench).length / cmp.length) * 100 : null, avgPicks: mean(periods.map((p) => p.n)), empty: periods.filter((p) => !p.n).length, fees: periods.reduce((a, p) => a + p.fee, 0) * 100 },
      univ: { ...U, curve: undefined, win: cmp.length ? (cmp.filter((p) => p.univ > p.bench).length / cmp.length) * 100 : null, avgPicks: mean(periods.map((p) => p.universe)) },
      bench: { ...B, curve: undefined },
    },
    start, end: panel.end, months: periods.length,
  };
}
