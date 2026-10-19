// 搜尋效能與涵蓋率：舊版（手打 110 檔清單）vs 新版（全市場清單）
// 用法：node tests/bench/search_bench.mjs <stocks.json>   （stocks.json 由 scripts/preview.sh --build 產生在 _site/data/）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildIndex, search } from '../../assets/js/search.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const legacyHtml = readFileSync(here + 'legacy/index.html', 'utf8');
const LEGACY_DB = [...legacyHtml.matchAll(/\['(\w+)','([^']+)'\]/g)].map((m) => [m[1], m[2]]);

// 舊版的搜尋函式（原封不動抄自 v5.1）
function legacyFind(query) {
  const q = query.trim().toLowerCase();
  const isCode = /^\d/.test(q);
  return LEGACY_DB.filter(([code, name]) => (isCode ? code.startsWith(q) : name.includes(query.trim()) || name.toLowerCase().includes(q))).slice(0, 8);
}

const stocks = JSON.parse(readFileSync(process.argv[2] || '_site/data/stocks.json', 'utf8')).rows;
const idx = buildIndex(stocks);

const queries = ['2330', '23', '台積', '臺積電', '２４５４', '宜鼎', '半導體', '2330.TW', '聯友', '上市測試5'];
const time = (fn, n = 2000) => { const t = performance.now(); for (let i = 0; i < n; i++) fn(); return ((performance.now() - t) / n) * 1000; };

const dupes = LEGACY_DB.length - new Set(LEGACY_DB.map((r) => r[0])).size;
console.log(`舊版清單：${LEGACY_DB.length} 筆（重複 ${dupes} 筆）；新版清單：${stocks.length} 檔`);
console.log('查詢\t舊版 µs\t新版 µs\t舊版結果數\t新版結果數');
for (const q of queries) {
  console.log([q, time(() => legacyFind(q)).toFixed(1), time(() => search(idx, q)).toFixed(1), legacyFind(q).length, search(idx, q).length].join('\t'));
}
// 涵蓋率：隨機抽 200 檔，用「名稱」搜尋，第一筆是否就是那一檔
const sample = stocks.filter((_, i) => i % Math.max(1, Math.floor(stocks.length / 200)) === 0).slice(0, 200);
const hitNew = sample.filter(([code, name]) => search(idx, name, 1)[0]?.item.code === code).length;
const hitOld = sample.filter(([code, name]) => legacyFind(name)[0]?.[0] === code).length;
console.log(`以名稱搜尋 ${sample.length} 檔，第一筆即正確：舊版 ${hitOld}，新版 ${hitNew}`);
