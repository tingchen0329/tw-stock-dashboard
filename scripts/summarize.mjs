#!/usr/bin/env node
/**
 * 命令列版個股摘要 —— 給 Claude Code（tw-stock-report skill）與自己在終端機使用
 *
 * 與網頁「完全相同」的計算程式（assets/js/analytics.js、prompt.js），
 * 所以終端機算出來的 KD、河流圖、營收年增率，和網頁上看到的一模一樣。
 *
 * 資料來源優先序：
 *   1. 本機 _site/data/（scripts/preview.sh --live 或 --build 產生的）
 *   2. 直接呼叫 FinMind（token 從環境變數 FINMIND_TOKEN 讀取，放在 Authorization header）
 *
 * 用法：
 *   node scripts/summarize.mjs 2330            # 輸出 JSON 摘要
 *   node scripts/summarize.mjs 台積電 --prompt  # 輸出分析指令全文（與網頁「產生分析指令」相同）
 *   node scripts/summarize.mjs 2330 --data path/to/data
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, marketRow, completeness } from '../assets/js/analytics.js';
import { buildPrompt } from '../assets/js/prompt.js';
import { buildIndex, resolveExact } from '../assets/js/search.js';
import { todayTPE, daysBefore } from '../assets/js/format.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const query = args.find((a) => !a.startsWith('--'));
const flag = (name) => args.includes(name);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const dataDir = resolve(opt('--data', resolve(ROOT, '_site/data')));

if (!query) {
  console.error('用法：node scripts/summarize.mjs <代號或名稱> [--prompt] [--data 資料夾]');
  process.exit(2);
}

const readLocal = (name) => {
  const f = resolve(dataDir, name);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
};

const TOKEN = process.env.FINMIND_TOKEN?.trim();
async function finmind(params) {
  const url = `https://api.finmindtrade.com/api/v4/data?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} });
  if (res.status === 402) throw new Error('FinMind 額度已用完（HTTP 402）');
  const body = await res.json();
  if (body.status !== 200) throw new Error(`FinMind ${params.dataset}: ${body.msg}`);
  return body.data || [];
}

const spec = Object.fromEntries(Object.entries(JSON.parse(readFileSync(resolve(ROOT, 'assets/datasets.json'), 'utf8'))).filter(([k]) => !k.startsWith('_')));
const keep = (r, s) => {
  if (!s.keep_types && !s.keep_origin) return true;
  const t = String(r.type ?? '');
  return !t.endsWith('_per') && ((s.keep_types || []).includes(t) || (s.keep_origin || []).some((o) => String(r.origin_name ?? '').includes(o)));
};
const toTable = (data, s) => ({ cols: s.fields, rows: data.filter((r) => keep(r, s)).map((r) => s.fields.map((c) => r[c] ?? null)) });

// 1. 解析代號 / 名稱
let stockRows = readLocal('stocks.json')?.rows;
if (!stockRows) {
  const info = await finmind({ dataset: 'TaiwanStockInfo' });
  const seen = new Map();
  for (const r of info) if (!seen.has(r.stock_id)) seen.set(r.stock_id, [r.stock_id, r.stock_name, r.type, r.industry_category]);
  stockRows = [...seen.values()];
}
const hit = resolveExact(buildIndex(stockRows), query);
const code = hit?.code ?? (/^\d{4,6}$/.test(query) ? query : null);
if (!code) {
  console.error(`找不到「${query}」或有多個可能，請改用股票代號`);
  process.exit(1);
}
const info = { code, name: hit?.name ?? '', market: hit?.market ?? '', industry: hit?.industry ?? '' };

// 2. 個股資料：本機檔案優先，否則 FinMind
let tables = readLocal(`stock/${code}.json`)?.tables;
const errors = {};
if (!tables) {
  tables = {};
  await Promise.all(Object.entries(spec).map(async ([k, s]) => {
    try {
      tables[k] = toTable(await finmind({ dataset: s.dataset, data_id: code, start_date: daysBefore(todayTPE(), s.days) }), s);
    } catch (e) { errors[k] = e.message; }
  }));
}

const market = readLocal('market.json');
const s = summarize({ info, mkt: marketRow(market, code), quote: readLocal('quotes.json')?.rows?.[code] ?? null, tables, asOf: market?.asOf ?? {} });
const meta = readLocal('meta.json') ?? { generatedAt: new Date().toISOString() };

if (flag('--prompt')) {
  console.log(buildPrompt(s, meta, readLocal('macro.json')?.items ?? []));
} else {
  // series（每日價格陣列）太長，JSON 摘要中省略；河流圖只留最新值
  const { series, river, tech, ...rest } = s;
  const out = {
    ...rest,
    tech: tech && { ...tech, maSeries: undefined },
    river: river && { ...river, dates: undefined, price: undefined, bands: undefined },
    completeness: completeness(s),
    errors,
    dataSource: readLocal(`stock/${code}.json`) ? `local:${dataDir}` : 'FinMind API',
  };
  console.log(JSON.stringify(out, null, 2));
}
