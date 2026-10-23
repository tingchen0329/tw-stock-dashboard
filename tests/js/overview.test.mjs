// 追蹤清單總覽：資料列與排序（顯示部分由 e2e 測試涵蓋）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overviewRow } from '../../assets/js/analytics.js';
import { sortRows } from '../../assets/js/overview.js';

const base = {
  info: { code: '2330', name: '台積電', market: 'twse', industry: '半導體業' },
  price: { price: 1000, changePct: 1.234567, kind: '收盤' },
  valuation: { pe: 25.123 },
  tech: { returns: { d20: 7.8 }, alignment: '多頭排列（5>20>60>240）', k: 67.25, rsi: 64.3 },
  river: { percentile: 88, zone: '偏高' },
  revenue: { latest: { yoy: 25.1 } },
  fundamentals: { eps4YoY: 5.8, roe: 25.9 },
  inst: { sum20: { foreign: -24145, trust: 300 } },
  series: { close: Array.from({ length: 80 }, (_, i) => 900 + i) },
};

test('overviewRow：取需要的欄位、四捨五入到 2 位、走勢只留 60 日', () => {
  const r = overviewRow(base);
  assert.equal(r.chgPct, 1.23);
  assert.equal(r.pe, 25.12);
  assert.equal(r.trend, 1);
  assert.equal(r.spark.length, 60);
  assert.equal(r.spark.at(-1), 979);
  assert.equal(r.etf, false);
  assert.equal(r.industry, '半導體業');
});

test('overviewRow：ETF 與缺資料 → null（顯示 N/A），不是 0', () => {
  const r = overviewRow({ info: { code: '00878', name: '國泰永續高股息' }, price: null, valuation: {}, tech: null,
    river: null, revenue: null, fundamentals: null, inst: null, series: null });
  assert.equal(r.etf, true);
  for (const k of ['price', 'pe', 'riverPct', 'revYoY', 'epsYoY', 'roe', 'f20', 'k', 'rsi', 'trend']) assert.equal(r[k], null, k);
  assert.deepEqual(r.spark, []);
});

test('sortRows：缺值排最後；key 為 null 時維持清單原順序', () => {
  const rows = [{ code: 'a', pe: 10 }, { code: 'b', pe: null }, { code: 'c', pe: 30 }, { code: 'd', pe: 20 }];
  assert.deepEqual(sortRows(rows, 'pe', -1).map((r) => r.code), ['c', 'd', 'a', 'b']);
  assert.deepEqual(sortRows(rows, 'pe', 1).map((r) => r.code), ['a', 'd', 'c', 'b']);
  assert.deepEqual(sortRows(rows, null, 1).map((r) => r.code), ['a', 'b', 'c', 'd']);
});
