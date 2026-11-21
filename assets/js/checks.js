/**
 * 資料驗證（純計算，網頁與 scripts/build_overview.mjs 共用）
 *
 * 1. 跨來源交叉比對：同一個數字從不同來源各抓一次，對不上就標示 ⚠
 *      收盤價   證交所 / 櫃買中心（全市場收盤） ↔ FinMind 個股日線 ↔ Yahoo 報價
 *      月營收   FinMind 月營收算出的年增率 ↔ 證交所 / 櫃買 t187ap05（screen.json）
 *      EPS     FinMind 單季 EPS 加總 ↔ 證交所 / 櫃買 t187ap06 的年度累計 EPS（screen.json）
 * 2. 異常值規則（同一來源內部不合理）
 *      台股一般股票單日漲跌幅限制 10%：超過且當天不是除權息日 → 可能是減資、分割或資料錯誤
 *      最高價低於開盤 / 收盤、最低價高於開盤 / 收盤；日期重複；成交量 0；資料停更
 *
 * 每一項回傳 { level: 'ok' | 'warn' | 'info', key, label, msg }：
 *   ok   比對一致
 *   warn 數字對不上或明顯錯誤（需要人工確認）
 *   info 無法比對（來源還沒更新、缺資料）或值得注意但不一定是錯
 */
import { priceSeries, revenueStats, fundamentals } from './analytics.js';
import { isNum } from './format.js';

const pctDiff = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? Math.abs(a / b - 1) * 100 : null);
const f2 = (v) => (isNum(v) ? (Math.round(v * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) : 'N/A');
const rowsOf = (t) => (t?.rows || []).map((r) => Object.fromEntries((t.cols || []).map((c, i) => [c, r[i]])));

/** 台股一般股票漲跌幅限制 10%（加一點容許誤差：漲停價有升降單位進位） */
export const TW_LIMIT_PCT = 10.5;

/**
 * @param {object} p
 * @param {{code,name,market}} p.info
 * @param {object|null} p.mkt       marketRow()：全市場官方收盤（含 close）
 * @param {object} p.asOf          market.json 的 asOf（twse / tpex 日期）
 * @param {object|null} p.quote    Yahoo 報價（quotes.json）
 * @param {object} p.tables        個股資料表（price、revenue、income、divResult…）
 * @param {object|null} p.screen   screen.json 這一檔的列（物件）
 * @param {string|null} p.today    台北日期（判斷資料是否停更），預設用股價最後一天
 * @param {Array|null} p.actions   actions.json 這一檔的減資 / 變更面額 / 分割事件（恢復買賣日不算異常）
 */
export function checkStock({ info, mkt = null, asOf = {}, quote = null, tables = {}, screen = null, today = null, actions = null }) {
  const out = [];
  const add = (level, key, label, msg) => out.push({ level, key, label, msg });
  const us = info.market === 'us';
  const etf = us ? false : String(info.code).startsWith('00');
  const ps = priceSeries(tables.price);
  const n = ps.dates.length;

  if (!n) return out;                     // 還在載入或沒有日線：不顯示（避免畫面閃一下「無法檢查」）

  /* ── 1a. 收盤價：官方收盤 ↔ FinMind（台股） ── */
  if (!us) {
    const offDate = info.market === 'tpex' ? asOf.tpex : asOf.twse;
    const src = info.market === 'tpex' ? '櫃買中心' : '證交所';
    if (mkt && isNum(mkt.close) && offDate) {
      const i = ps.dates.lastIndexOf(offDate);
      if (i >= 0) {
        const d = pctDiff(ps.close[i], mkt.close);
        if (d !== null && d > 0.1) add('warn', 'close', '收盤價', `${offDate} ${src} ${f2(mkt.close)} ≠ FinMind ${f2(ps.close[i])}（差 ${f2(d)}%）`);
        else add('ok', 'close', '收盤價', `${offDate} ${src} 與 FinMind 一致（${f2(mkt.close)}）`);
      } else if (ps.dates[n - 1] < offDate) {
        add('info', 'close', '收盤價', `FinMind 尚未更新到 ${offDate}（最新 ${ps.dates[n - 1]}），以${src}收盤為準`);
      }
    }
    /* ── 1b. Yahoo 報價（只在同一天、已收盤時比） ── */
    if (quote && isNum(quote.value) && mkt && isNum(mkt.close) && offDate && String(quote.time || '').slice(0, 10) === offDate
        && String(quote.time).slice(11, 16) >= '13:30') {
      const d = pctDiff(quote.value, mkt.close);
      if (d !== null && d > 0.5) add('warn', 'quote', 'Yahoo 報價', `Yahoo ${f2(quote.value)} 與${src}收盤 ${f2(mkt.close)} 差 ${f2(d)}%`);
      else add('ok', 'quote', 'Yahoo 報價', `與${src}收盤一致`);
    }
  }

  /* ── 1c. 月營收年增率：FinMind ↔ 證交所 / 櫃買（screen.json） ── */
  if (!us && !etf && screen && isNum(screen.revYoY) && screen.revYm) {
    const rv = revenueStats(tables.revenue);
    const item = rv?.items?.find((x) => `${x.y}-${String(x.m).padStart(2, '0')}` === screen.revYm);
    if (!rv) add('info', 'revenue', '月營收', 'FinMind 沒有月營收資料，無法比對');
    else if (!item) add('info', 'revenue', '月營收', `FinMind 尚無 ${screen.revYm} 營收（最新 ${rv.latest.period}）`);
    else if (!isNum(item.yoy)) add('info', 'revenue', '月營收', `${screen.revYm} 缺去年同月營收，無法算年增率`);
    else if (Math.abs(item.yoy - screen.revYoY) > 0.5) {
      // 金融業（金控、銀行、保險）月營收的認列口徑兩個來源不同，差異屬正常 → 只提示
      const fin = /金融|保險|銀行|證券/.test(String(screen.industry || info.industry || ''));
      add(fin ? 'info' : 'warn', 'revenue', '月營收', `${screen.revYm} 年增率：官方 ${f2(screen.revYoY)}% ≠ FinMind ${f2(item.yoy)}%`
        + (fin ? '（金融業營收口徑不同，僅供參考）' : ''));
    } else add('ok', 'revenue', '月營收', `${screen.revYm} 年增率與官方一致（${f2(screen.revYoY)}%）`);
    const latestYoY = rv?.latest?.yoy;
    if (isNum(latestYoY) && (latestYoY > 1000 || latestYoY < -95)) {
      add('info', 'revenueOutlier', '營收年增極端', `${rv.latest.period} 年增 ${f2(latestYoY)}%：可能是基期過低、併購或事業轉型，請看原始公告`);
    }
  }

  /* ── 1d. EPS：FinMind 單季加總 ↔ 官方年度累計 ── */
  if (!us && !etf && screen && isNum(screen.eps) && /^\d{4}Q[1-4]$/.test(screen.epsPeriod || '')) {
    const y = screen.epsPeriod.slice(0, 4);
    const q = +screen.epsPeriod.slice(5);
    const qs = (fundamentals(tables.income, tables.balance)?.quarters || []).filter((x) => x.date.startsWith(y) && isNum(x.eps));
    const need = Array.from({ length: q }, (_, k) => `${y}-${['03-31', '06-30', '09-30', '12-31'][k]}`);
    const have = need.filter((d) => qs.some((x) => x.date === d));
    if (have.length < need.length) {
      add('info', 'eps', 'EPS', `FinMind 尚無 ${screen.epsPeriod} 完整財報（缺 ${need.length - have.length} 季），無法比對`);
    } else {
      const sum = qs.filter((x) => need.includes(x.date)).reduce((a, x) => a + x.eps, 0);
      const diff = Math.abs(sum - screen.eps);
      if (diff > Math.max(0.02, Math.abs(screen.eps) * 0.02)) {
        add('warn', 'eps', 'EPS', `${screen.epsPeriod} 累計：官方 ${f2(screen.eps)} 元 ≠ FinMind 加總 ${f2(sum)} 元`);
      } else add('ok', 'eps', 'EPS', `${screen.epsPeriod} 累計 EPS 與官方一致（${f2(screen.eps)} 元）`);
    }
  }

  /* ── 2a. 單日漲跌超過限制（台股） ── */
  const exDates = new Set([...rowsOf(tables.divResult).map((r) => r.date), ...(actions || []).map((a) => a[0])]);
  const limit = us ? 40 : TW_LIMIT_PCT;
  const jumps = [];
  for (let i = 1; i < n; i++) {
    const p = ps.close[i - 1];
    const chg = p ? (ps.close[i] / p - 1) * 100 : 0;
    if (Math.abs(chg) > limit && !exDates.has(ps.dates[i])) jumps.push(`${ps.dates[i]}（${chg > 0 ? '+' : ''}${f2(chg)}%）`);
  }
  if (jumps.length) {
    // ETF（含海外成分，無漲跌幅限制）、股利資料還沒載入、美股 → 只提示；一般台股 → 警告
    const level = us || etf || !tables.divResult ? 'info' : 'warn';
    add(level, 'jump', '單日漲跌異常', `${jumps.length} 天單日漲跌超過 ${limit}%：${jumps.slice(-3).join('、')}。`
      + (us ? '可能是財報或重大消息，請確認。' : '不是除權息日：可能是興櫃期間或新上市前 5 日（無漲跌幅限制）、減資、恢復買賣，或資料錯誤。'));
  } else add('ok', 'jump', '單日漲跌', `近 ${n} 個交易日沒有超過 ${limit}% 的異常跳動${us ? '' : '（已排除除權息日）'}`);

  /* ── 2b. OHLC 一致性、重複日期、成交量 0 ── */
  const bad = [];
  for (let i = 0; i < n; i++) {
    const [o, hi, lo, c] = [ps.open[i], ps.high[i], ps.low[i], ps.close[i]];
    if ([o, hi, lo, c].every(isNum) && (hi + 1e-9 < Math.max(o, c) || lo - 1e-9 > Math.min(o, c) || lo <= 0)) bad.push(ps.dates[i]);
  }
  if (bad.length) add('warn', 'ohlc', '開高低收', `${bad.length} 天的最高 / 最低價與開盤、收盤矛盾：${bad.slice(-3).join('、')}`);
  else add('ok', 'ohlc', '開高低收', '每日最高 ≥ 開盤、收盤 ≥ 最低');

  const dup = ps.dates.filter((d, i) => i && d === ps.dates[i - 1]);
  if (dup.length) add('warn', 'dup', '日期重複', `${dup.length} 個日期重複：${dup.slice(-3).join('、')}`);

  const zeroVol = ps.dates.slice(-250).filter((_, k) => ps.volume[Math.max(0, n - 250) + k] === 0).length;
  if (zeroVol) add('info', 'volume', '成交量', `近一年有 ${zeroVol} 天成交量為 0（流動性低或停牌）`);

  /* ── 2c. 資料停更 ── */
  const ref = today || (us ? null : (info.market === 'tpex' ? asOf.tpex : asOf.twse));
  if (ref && ps.dates[n - 1] < ref) {
    const gap = (Date.parse(ref) - Date.parse(ps.dates[n - 1])) / 864e5;
    if (gap > 7) add('warn', 'stale', '資料停更', `股價最後一天是 ${ps.dates[n - 1]}，落後 ${Math.round(gap)} 天（可能停牌、下市或來源停更）`);
  }
  return out;
}

/** 計數：{ ok, warn, info } */
export function countChecks(list) {
  const c = { ok: 0, warn: 0, info: 0 };
  for (const x of list || []) c[x.level] = (c[x.level] || 0) + 1;
  return c;
}

/** screen.json（{cols, rows}）→ Map(代號 → 列物件) */
export function screenIndex(screen) {
  const cols = screen?.cols || [];
  return new Map((screen?.rows || []).map((r) => {
    const o = Object.fromEntries(cols.map((c, i) => [c, r[i]]));
    return [o.code, o];
  }));
}
