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
import { summarize, marketRow, overviewRow, usMarketRow, insiderStats } from '../assets/js/analytics.js';
import { checkStock, countChecks, screenIndex } from '../assets/js/checks.js';

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
const screen = screenIndex(read('screen.json'));     // 交叉比對：官方月營收 / EPS 彙總表
const checks = [];                                   // [{ code, name, market, items }]
const adjCount = { tw: 0, us: 0 };

const rows = [];
const missing = [];
const cover = { fcf: 0, div: 0, divRaw: 0, cfRaw: 0, ins: 0, insTx: 0 };   // 新資料集的涵蓋率（寫進 log，確認正式資料欄位對得上）
for (const code of meta.watchlist ?? []) {
  const r = byCode.get(code);
  const info = { code, name: r?.[1] ?? '', market: r?.[2] ?? '', industry: r?.[3] ?? '' };
  const detail = read(`stock/${code}.json`);
  if (!detail) missing.push(code);
  try {
    const s = summarize({
      info, mkt: marketRow(market, code), quote: quotes[code] ?? null, tables: detail?.tables ?? {}, asOf: market?.asOf ?? {}, bench: bench.tw,
    });
    rows.push(overviewRow(s));
    if (s.adjusted?.available) adjCount.tw++;
    checks.push({ code, name: info.name, market: 'tw', items: checkStock({
      info, mkt: marketRow(market, code), asOf: market?.asOf ?? {}, quote: quotes[code] ?? null, tables: detail?.tables ?? {}, screen: screen.get(code) ?? null,
    }) });
    if (detail?.tables?.cashflow?.rows?.length) cover.cfRaw++;
    if (detail?.tables?.dividend?.rows?.length) cover.divRaw++;
    if (Number.isFinite(s.fundamentals?.fcf4)) cover.fcf++;
    if (s.dividends?.policy?.length) cover.div++;
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
    const us = summarize({ info, mkt, quote: null, tables: detail?.tables ?? {}, asOf: { twse: mkt?.date }, bench: bench.us, dividends: detail?.dividends ?? null });
    usRows.push(overviewRow(us));
    if (us.adjusted?.applied) adjCount.us++;
    checks.push({ code, name: info.name, market: 'us', items: checkStock({ info, tables: detail?.tables ?? {}, today: null }) });
    const ins = insiderStats(detail?.insider);
    if (ins?.filings) { cover.ins++; cover.insTx += ins.buy.n + ins.sell.n; }
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
// ── 資料驗證：checks.json（個股頁讀）＋ meta.checks 摘要（頁首資料來源清單顯示）──
const total = { ok: 0, warn: 0, info: 0 };
const warnList = [];
for (const c of checks) {
  const n = countChecks(c.items);
  for (const k of Object.keys(total)) total[k] += n[k] || 0;
  for (const x of c.items.filter((i) => i.level === 'warn')) {
    warnList.push({ code: c.code, name: c.name, market: c.market, label: x.label, msg: x.msg });
    // GitHub Actions 的執行頁面會把 ::warning:: 顯示成黃色提示
    console.log(`::warning title=資料驗證 ${c.code}::${x.label}：${x.msg}`);
  }
}
const checksBody = JSON.stringify({ generatedAt: meta.generatedAt, stocks: Object.fromEntries(checks.map((c) => [`${c.market === 'us' ? 'US:' : ''}${c.code}`, c.items])) });
writeFileSync(resolve(dir, 'checks.json'), checksBody);
meta.bytes['checks.json'] = Buffer.byteLength(checksBody);
meta.checks = { stocks: checks.length, ...total, warnStocks: new Set(warnList.map((w) => w.code)).size, warns: warnList.slice(0, 30) };
writeFileSync(resolve(dir, 'meta.json'), JSON.stringify(meta));
console.log(`overview.json: ${rows.length} 檔，${(Buffer.byteLength(body) / 1024).toFixed(0)} KB`
  + (missing.length ? `；缺個股資料：${missing.join(', ')}` : ''));
console.log(`資料驗證：${checks.length} 檔，一致 ${total.ok} 項、需確認 ${total.warn} 項（${meta.checks.warnStocks} 檔）、無法比對 ${total.info} 項；`
  + `還原股價：台股 ${adjCount.tw} 檔、美股 ${adjCount.us} 檔有除權息資料`);
console.log(`新資料涵蓋：現金流量表 ${cover.cfRaw} 檔（算出自由現金流 ${cover.fcf} 檔）、股利 ${cover.divRaw} 檔（股利政策 ${cover.div} 檔）、`
  + `美股內部人 ${cover.ins} 檔（近 6 個月公開市場買賣 ${cover.insTx} 筆）`);
