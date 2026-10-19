// 搜尋：代號 / 名稱 / 產業都找得到，排序合理
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, buildIndex, search, resolveExact, highlightParts } from '../../assets/js/search.js';

const ROWS = [
  ['2330', '台積電', 'twse', '半導體業'],
  ['2303', '聯電', 'twse', '半導體業'],
  ['2317', '鴻海', 'twse', '其他電子業'],
  ['3443', '創意', 'twse', '半導體業'],
  ['5289', '宜鼎', 'tpex', '電腦及週邊設備業'],
  ['0050', '元大台灣50', 'twse', 'ETF'],
  ['6669', '緯穎', 'twse', '電腦及週邊設備業'],
  ['7610', '聯友金屬-創', 'twse', '綠能環保'],
  ['6999', '台積測試', 'emerging', '測試'],
];
const idx = buildIndex(ROWS, ['6669']);
const codes = (q, n = 8) => search(idx, q, n).map((r) => r.item.code);

test('normalize：全形、臺、空白、Yahoo 後綴', () => {
  assert.equal(normalize('２３３０'), '2330');
  assert.equal(normalize('臺積電'), '台積電');
  assert.equal(normalize(' 2330.TW '), '2330');
  assert.equal(normalize('5289.two'), '5289');
});

test('代號完全相符排第一', () => {
  assert.equal(codes('2330')[0], '2330');
  assert.equal(codes('２３３０')[0], '2330');
});

test('代號開頭', () => {
  assert.deepEqual(codes('23').slice(0, 3).sort(), ['2303', '2317', '2330']);
});

test('名稱：開頭、包含、臺/台、模糊（字元依序）', () => {
  assert.equal(codes('台積')[0], '2330');
  assert.equal(codes('臺積電')[0], '2330');
  assert.ok(codes('台灣').includes('0050'));       // 包含
  assert.ok(codes('聯金屬').includes('7610'));      // 字元依序出現
});

test('上市櫃排在興櫃之前（同樣相符時）', () => {
  const r = codes('台積');
  assert.ok(r.indexOf('2330') < r.indexOf('6999'));
});

test('代號 + 名稱一起輸入', () => {
  assert.deepEqual(codes('2330 台積電'), ['2330']);
  assert.deepEqual(codes('2330 鴻海'), []);         // 代號對、名稱錯 → 不相符
});

test('產業別也能搜', () => {
  const r = codes('半導體');
  assert.ok(['2330', '2303', '3443'].every((c) => r.includes(c)));
});

test('找不到時回傳空陣列，空字串不搜尋', () => {
  assert.deepEqual(codes('不存在的公司xyz'), []);
  assert.deepEqual(codes('   '), []);
});

test('resolveExact：只有確定時才自動開啟', () => {
  assert.equal(resolveExact(idx, '2330').code, '2330');
  assert.equal(resolveExact(idx, '宜鼎').code, '5289');
  assert.equal(resolveExact(idx, '23'), null);       // 多筆候選 → 不猜
});

test('highlightParts 切出相符片段（交給 textContent，不產生 HTML）', () => {
  assert.deepEqual(highlightParts('台積電', '積'), ['台', '積', '電']);
  assert.deepEqual(highlightParts('台積電', '2330'), ['台積電', '', '']);
});

test('效能：3,000 檔單次搜尋 < 5 ms', () => {
  const big = buildIndex(Array.from({ length: 3000 }, (_, i) => [String(1000 + i), `測試公司${i}`, 'twse', '測試']));
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) search(big, '測試公司29');
  assert.ok((performance.now() - t0) / 100 < 5);
});
