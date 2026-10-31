/**
 * 資料載入
 *
 * 兩條路徑，輸出格式相同（{cols, rows} 資料表），analytics.js 不用分辨來源：
 *
 *  A. 追蹤清單內的股票 → 讀 data/stock/<代號>.json
 *     由 GitHub Actions 用 FinMind token 預先抓好（token 存在 GitHub Secrets，網頁看不到）
 *
 *  B. 追蹤清單外的股票 → 瀏覽器直接呼叫 FinMind「不帶 token」
 *     FinMind 免 token 額度：每個 IP 每小時 300 次；一檔約 8 次 → 每小時可查約 35 檔
 *     第一波（股價、本益比、月營收、法人）先回來就先畫；第二波（融資券、持股、財報）背景補齊
 *
 * 全市場行情（market.json）兩條路徑都會用到，確保任何股票都有當日價格、本益比、法人。
 */

import { fetchJSON, HttpError } from './net.js';
import { todayTPE, daysBefore } from './format.js';

const DATA = './data/';
const FINMIND = 'https://api.finmindtrade.com/api/v4/data';
const DAY = 24 * 3600 * 1000;

let version = '';          // 以 meta.generatedAt 當版本號：資料更新時網址改變 → 瀏覽器自動抓新的
const v = (path, ver = version) => `${DATA}${path}${ver ? `?v=${encodeURIComponent(ver)}` : ''}`;
let macroVersion = '';     // 夜間只更新總經：macro.json 用 meta.macroAt，其餘檔案沿用 generatedAt

/**
 * 首次載入：meta 先抓（不走瀏覽器快取），其餘 5 個檔案平行抓。
 * 任何一個檔案失敗都不會讓整頁掛掉，只是對應區塊顯示「無資料」。
 */
export async function loadBootstrap() {
  let meta = null;
  try {
    meta = await fetchJSON(DATA + 'meta.json', { cache: 'no-cache', timeout: 8000 });
    version = meta.generatedAt || '';
    macroVersion = meta.macroAt || version;
  } catch {
    return { meta: null };          // 還沒部署過資料（或本機直接開檔案）→ 顯示設定說明
  }
  const opt = { ttl: 10 * 60 * 1000, persist: true, timeout: 15000 };
  const settle = (p) => p.then((x) => x, () => null);
  const [stocks, market, macro, quotes, spec, overview] = await Promise.all([
    settle(fetchJSON(v('stocks.json'), opt)),
    settle(fetchJSON(v('market.json'), opt)),
    settle(fetchJSON(v('macro.json', macroVersion), opt)),
    settle(fetchJSON(v('quotes.json'), opt)),
    settle(fetchJSON(v('datasets.json'), { ...opt, ttl: DAY })),
    settle(fetchJSON(v('overview.json'), opt)),
  ]);
  return { meta, stocks, market, macro, quotes, spec: stripComments(spec), overview };
}

/** 全市場選股資料（約 250 KB，壓縮後約 70 KB）：第一次打開選股頁才下載 */
export const loadScreen = () => fetchJSON(v('screen.json'), { ttl: 10 * 60 * 1000, persist: true, timeout: 20000 });

const stripComments = (o) => (o ? Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_'))) : {});

/* ───────── FinMind 即時查詢（免 token）───────── */

/** 和 Python 版 keep_row 相同規則：財報只留需要的科目 */
function keepRow(row, spec) {
  const types = spec.keep_types;
  const origins = spec.keep_origin;
  if (!types && !origins) return true;
  const t = String(row.type ?? '');
  if (t.endsWith('_per')) return false;
  const o = String(row.origin_name ?? '');
  return (types || []).includes(t) || (origins || []).some((s) => o.includes(s));
}

/** FinMind 物件陣列 → {cols, rows}（與 Python to_table 相同） */
export function toTable(data, spec) {
  const cols = spec.fields;
  return { cols, rows: data.filter((r) => keepRow(r, spec)).map((r) => cols.map((c) => r[c] ?? null)) };
}

async function finmindTable(code, spec, signal) {
  const start = daysBefore(todayTPE(), spec.days);
  const qs = new URLSearchParams({ dataset: spec.dataset, data_id: code, start_date: start });
  const res = await fetchJSON(`${FINMIND}?${qs}`, { signal, ttl: 15 * 60 * 1000, persist: true, timeout: 20000 });
  if (res.status !== undefined && res.status !== 200) throw new Error(res.msg || `FinMind status ${res.status}`);
  return toTable(res.data || [], spec);
}

/**
 * 取得個股資料表
 * @param {string} code
 * @param {object} ctx  { meta, spec, signal, onUpdate(tables, {done, errors, source}) }
 */
/** 台股 ETF 代號一律 00 開頭 */
export const isEtf = (code) => code.startsWith('00');

export async function loadStock(code, { meta, spec, signal, onUpdate }) {
  // A. 追蹤清單：一個檔案搞定
  if (meta?.watchlist?.includes(code)) {
    try {
      const d = await fetchJSON(v(`stock/${code}.json`), { signal, ttl: 10 * 60 * 1000, persist: true });
      onUpdate(d.tables || {}, { done: true, errors: d.errors || {}, source: 'prefetched', fetchedAt: d.fetchedAt });
      return;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // 檔案不存在（例如剛加入清單、尚未部署）→ 改走 B
    }
  }

  // B. 即時查詢 FinMind（免 token），分兩波
  const tables = {};
  const errors = {};
  const entries = Object.entries(spec).filter(([, s]) => !(s.skipEtf && isEtf(code)));   // ETF 沒有本益比、營收、財報
  for (const wave of [1, 2]) {
    const jobs = entries.filter(([, s]) => (s.wave ?? 1) === wave);
    await Promise.all(jobs.map(async ([key, s]) => {
      try {
        tables[key] = await finmindTable(code, s, signal);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        errors[key] = e instanceof HttpError && e.status === 402
          ? 'FinMind 免費額度已用完（每小時 300 次），請稍後再試或把這檔加入追蹤清單'
          : String(e.message || e);
      }
    }));
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    onUpdate({ ...tables }, { done: wave === 2, errors: { ...errors }, source: 'live' });
  }
}
