#!/usr/bin/env node
/**
 * 追蹤清單總覽表：把每檔的 summarize() 結果濃縮成一列，寫成 <data>/overview.json
 *
 * 在 GitHub Actions 的 fetch_data.py 之後執行（每種更新模式都跑，純本機計算、不連網）。
 * 用和網頁完全相同的 analytics.js，所以總覽表的數字與個股頁一致。
 * 網頁只讀這一個小檔（約 50 KB），不必下載 60 多檔個股資料。
 *
 * 用法：node scripts/build_overview.mjs _site/data
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarize, marketRow, overviewRow, usMarketRow } from '../assets/js/analytics.js';

const dir = resolve(process.argv[2] || '_site/data');
const read = (name) => {
  const f = resolve(dir, name);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
};

const meta = read('meta.json');
if (!meta) {
  console.error(`找不到 ${dir}/meta.json，請先執行 scripts/fetch_data.py`);
  process.exit(1);
}
const market = read('market.json');
const quotes = read('quotes.json')?.rows ?? {};
const bench = read('macro.json')?.bench ?? {};      // 相對大盤：台股比加權指數、美股比 S&P 500
const byCode = new Map((read('stocks.json')?.rows ?? []).map((r) => [r[0], r]));

const rows = [];
const missing = [];
for (const code of meta.watchlist ?? []) {
  const r = byCode.get(code);
  const info = { code, name: r?.[1] ?? '', market: r?.[2] ?? '', industry: r?.[3] ?? '' };
  const detail = read(`stock/${code}.json`);
  if (!detail) missing.push(code);
  try {
    rows.push(overviewRow(summarize({
      info, mkt: marketRow(market, code), quote: quotes[code] ?? null, tables: detail?.tables ?? {}, asOf: market?.asOf ?? {}, bench: bench.tw,
    })));
  } catch (e) {
    // 單一檔資料異常不能讓整個部署失敗：這一列只顯示代號名稱，其餘 N/A
    console.warn(`::warning title=總覽表::${code} 計算失敗：${e.message}`);
    rows.push(overviewRow({ info }));
  }
}

const body = JSON.stringify({ generatedAt: meta.generatedAt, dataDay: meta.market?.lastTradingDay ?? null, rows });
writeFileSync(resolve(dir, 'overview.json'), body);
// 記進 meta.bytes：夜間 / 增量模式取回上一份資料時會一起取回
meta.bytes = { ...(meta.bytes || {}), 'overview.json': Buffer.byteLength(body) };

// ── 美股總覽（us/overview.json）──
const usRows = [];
let usDay = null;
for (const code of meta.usWatchlist ?? []) {
  const detail = read(`us/stock/${code}.json`);
  const hasFin = (detail?.tables?.income?.rows ?? []).length > 0;
  const info = { code, name: detail?.name ?? '', market: 'us', industry: detail?.exchange ?? '',
    etf: !hasFin && /ETF|Trust|Fund|Index/i.test(detail?.name ?? '') };
  try {
    const mkt = usMarketRow(detail);
    if (mkt?.date && (!usDay || mkt.date > usDay)) usDay = mkt.date;
    usRows.push(overviewRow(summarize({ info, mkt, quote: null, tables: detail?.tables ?? {}, asOf: { twse: mkt?.date }, bench: bench.us })));
  } catch (e) {
    console.warn(`::warning title=美股總覽::${code} 計算失敗：${e.message}`);
    usRows.push(overviewRow({ info }));
  }
}
if (usRows.length) {
  const usBody = JSON.stringify({ generatedAt: meta.usAt ?? meta.generatedAt, dataDay: usDay, rows: usRows });
  writeFileSync(resolve(dir, 'us/overview.json'), usBody);
  meta.bytes['us/overview.json'] = Buffer.byteLength(usBody);
  console.log(`us/overview.json: ${usRows.length} 檔`);
}
writeFileSync(resolve(dir, 'meta.json'), JSON.stringify(meta));
console.log(`overview.json: ${rows.length} 檔，${(Buffer.byteLength(body) / 1024).toFixed(0)} KB`
  + (missing.length ? `；缺個股資料：${missing.join(', ')}` : ''));
