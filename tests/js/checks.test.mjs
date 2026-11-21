/**
 * 還原股價與資料驗證。
 * 還原股價用「性質測試」寫法：固定亂數種子產生 200 組隨機股價與除權息事件，檢查一定要成立的規則。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustEvents, adjustedSeries, summarize } from '../../assets/js/analytics.js';
import { checkStock, countChecks, screenIndex } from '../../assets/js/checks.js';

/** 可重現的亂數（mulberry32） */
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const day = (i) => new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString().slice(0, 10);

function randomCase(r) {
  const n = 30 + Math.floor(r() * 300);
  const dates = Array.from({ length: n }, (_, i) => day(i));
  const close = [];
  let c = 20 + r() * 500;
  for (let i = 0; i < n; i++) { c *= 1 + (r() - 0.5) * 0.06; close.push(+c.toFixed(2)); }
  const rowsRes = [];
  for (let k = 0; k < Math.floor(r() * 5); k++) {
    const i = 1 + Math.floor(r() * (n - 1));
    const before = close[i - 1];
    rowsRes.push([dates[i], before, +(before * (1 - 0.01 - r() * 0.08)).toFixed(2)]);
  }
  return { ps: { dates, open: close, high: close, low: close, close, volume: close.map(() => 1) },
    divResult: { cols: ['date', 'before_price', 'after_price'], rows: rowsRes } };
}

test('還原股價（性質）：最新價不變、事件前價格都被乘上 ≤ 1 的因子、非除息日的日報酬不變', () => {
  const r = rng(20261122);
  for (let k = 0; k < 200; k++) {
    const { ps, divResult } = randomCase(r);
    const ev = adjustEvents(ps, { divResult });
    const adj = adjustedSeries(ps, ev);
    const n = ps.close.length;
    assert.equal(adj.close[n - 1], ps.close[n - 1]);
    const exDays = new Set(ev.map((e) => e.date));
    for (let i = 0; i < n; i++) {
      assert.ok(adj.factor[i] > 0 && adj.factor[i] <= 1 + 1e-12);
      if (i && i < n && !exDays.has(ps.dates[i])) {
        const raw = ps.close[i] / ps.close[i - 1];
        const a = adj.close[i] / adj.close[i - 1];
        assert.ok(Math.abs(raw - a) < 1e-9, `第 ${i} 天日報酬被改變`);
      }
    }
    // 因子由後往前只會變小（越早的價格乘越多次）
    for (let i = 1; i < n; i++) assert.ok(adj.factor[i - 1] <= adj.factor[i] + 1e-12);
  }
});

test('還原股價：除息當天報酬 = 填息後的真實報酬（含息）', () => {
  const ps = { dates: ['2025-07-01', '2025-07-02', '2025-07-03'], open: [100, 97, 98], high: [100, 97, 98], low: [100, 97, 98], close: [100, 97, 98], volume: [1, 1, 1] };
  const ev = adjustEvents(ps, { divResult: { cols: ['date', 'before_price', 'after_price'], rows: [['2025-07-02', 100, 96]] } });
  const adj = adjustedSeries(ps, ev);
  // 除息 4 元、隔天收 97：含息報酬 = 97 / 96 − 1 ≈ +1.04%，不是 −3%
  assert.ok(Math.abs(adj.close[1] / adj.close[0] - 97 / 96) < 1e-12);
  // 美股：配息 1 元、除息前一天收 100 → 因子 0.99
  const us = adjustEvents(ps, { dividends: [['2025-07-02', 1]] });
  assert.ok(Math.abs(us[0].factor - 0.99) < 1e-12);
  // 不合理的事件（參考價 ≥ 除息前收盤、配息 ≥ 股價）略過
  assert.equal(adjustEvents(ps, { divResult: { cols: ['date', 'before_price', 'after_price'], rows: [['2025-07-02', 100, 100]] }, dividends: [['2025-07-02', 500]] }).length, 0);
});

test('summarize：報酬率與相對大盤用還原股價，技術指標用原始價', () => {
  const n = 400;                                            // 超過一年，才算得出「近一年」報酬
  const dates = Array.from({ length: n }, (_, i) => day(i));
  const close = dates.map((_, i) => 100 + (i % 7));
  const price = { cols: ['date', 'open', 'max', 'min', 'close', 'Trading_Volume'], rows: dates.map((d, i) => [d, close[i], close[i], close[i], close[i], 1000]) };
  const divResult = { cols: ['date', 'before_price', 'after_price'], rows: [[dates[200], close[199], close[199] - 5]] };
  const s = summarize({ info: { code: '9999', market: 'twse' }, mkt: null, tables: { price, divResult } });
  assert.equal(s.adjusted.available, true);
  assert.equal(s.adjusted.applied, 1);
  assert.ok(s.tech.returns.y1 > s.tech.returnsRaw.y1);
  assert.equal(s.tech.close, close[n - 1]);
  const none = summarize({ info: { code: '9999', market: 'twse' }, mkt: null, tables: { price } });
  assert.equal(none.adjusted.available, false);                 // 股利資料還沒載入
});

test('資料驗證：收盤價、營收、EPS 交叉比對與異常值', () => {
  const dates = Array.from({ length: 40 }, (_, i) => day(i));
  const close = dates.map((_, i) => (i === 30 ? 150 : 100));      // 第 30 天 +50%：超過漲跌幅限制
  const price = { cols: ['date', 'open', 'max', 'min', 'close', 'Trading_Volume'],
    rows: dates.map((d, i) => [d, close[i], i === 10 ? 90 : close[i], close[i], close[i], 1000]) };   // 第 10 天最高 < 收盤
  const revenue = { cols: ['revenue_year', 'revenue_month', 'revenue'], rows: [[2025, 9, 100], [2026, 9, 120]] };
  const income = { cols: ['date', 'type', 'value'], rows: [['2026-03-31', 'EPS', 1.5], ['2026-06-30', 'EPS', 2]] };
  const screen = screenIndex({ cols: ['code', 'revYm', 'revYoY', 'epsPeriod', 'eps'], rows: [['1234', '2026-09', 20, '2026Q2', 3.5]] }).get('1234');
  const base = { info: { code: '1234', market: 'twse' }, asOf: { twse: dates[39] }, tables: { price, revenue, income, divResult: { cols: [], rows: [] } }, screen };
  const r = checkStock({ ...base, mkt: { close: 100 } });
  const by = Object.fromEntries(r.map((x) => [x.key, x.level]));
  assert.deepEqual([by.close, by.revenue, by.eps, by.jump, by.ohlc], ['ok', 'ok', 'ok', 'warn', 'warn']);
  const r2 = checkStock({ ...base, mkt: { close: 101 }, screen: { ...screen, revYoY: 25, eps: 4 } });
  const by2 = Object.fromEntries(r2.map((x) => [x.key, x.level]));
  assert.deepEqual([by2.close, by2.revenue, by2.eps], ['warn', 'warn', 'warn']);
  assert.deepEqual(countChecks(r2), { ok: 0, warn: 5, info: 0 });
  // 除權息日的大跌不算異常；股利資料還沒載入時只提示
  const exd = checkStock({ ...base, mkt: { close: 100 }, tables: { ...base.tables, divResult: { cols: ['date'], rows: [[dates[30]], [dates[31]]] } } });
  assert.equal(exd.find((x) => x.key === 'jump').level, 'ok');
  const noDiv = checkStock({ ...base, mkt: { close: 100 }, tables: { ...base.tables, divResult: undefined } });
  assert.equal(noDiv.find((x) => x.key === 'jump').level, 'info');
});

test('減資 / 面額變更：因子 = 參考價 ÷ 停止前收盤；恢復買賣日的跳動不算異常', () => {
  const dates = Array.from({ length: 30 }, (_, i) => day(i));
  const close = dates.map((_, i) => (i < 20 ? 400 : 100));            // 面額 10 元 → 2.5 元（1 拆 4）
  const ps = { dates, open: close, high: close, low: close, close, volume: close.map(() => 1) };
  const ev = adjustEvents(ps, { actions: [[dates[20], 100, 400, '變更面額'], [dates[25], 100, null, '減資']] });
  assert.equal(ev.length, 1);                                         // 第二筆參考價 = 前收（因子 1）→ 略過
  assert.equal(ev[0].factor, 0.25);
  const adj = adjustedSeries(ps, ev);
  assert.ok(adj.close.every((c) => c === 100));                      // 還原後沒有 −75% 的假跌幅
  const price = { cols: ['date', 'open', 'max', 'min', 'close', 'Trading_Volume'], rows: dates.map((d, i) => [d, close[i], close[i], close[i], close[i], 1]) };
  const base = { info: { code: '2327', market: 'twse' }, tables: { price, divResult: { cols: [], rows: [] } } };
  assert.equal(checkStock(base).find((x) => x.key === 'jump').level, 'warn');
  assert.equal(checkStock({ ...base, actions: [[dates[20], 100, 400, '變更面額']] }).find((x) => x.key === 'jump').level, 'ok');
  // 金融業營收口徑不同：差異只提示
  const revenue = { cols: ['revenue_year', 'revenue_month', 'revenue'], rows: [[2025, 9, 100], [2026, 9, 120]] };
  const fin = checkStock({ ...base, tables: { ...base.tables, revenue }, screen: { revYm: '2026-09', revYoY: 5, industry: '金融保險業' } });
  assert.equal(fin.find((x) => x.key === 'revenue').level, 'info');
});

test('同一事件同時列在「變更面額」與「分割」（或除權息結果）只調整一次', () => {
  const ps = { dates: ['2025-08-21', '2025-08-22', '2025-08-25', '2025-08-26'], close: [540, 546, 143, 145], open: [], high: [], low: [], volume: [] };
  const actions = [['2025-08-25', 136.5, 546, '變更面額'], ['2025-08-25', 136.5, 546, '分割']];
  const divResult = { cols: ['date', 'before_price', 'after_price', 'stock_and_cache_dividend', 'stock_or_cache_dividend'], rows: [['2025-08-25', 546, 136.5, 0, '權']] };
  const ev = adjustEvents(ps, { actions, divResult });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].factor, 0.25);
  const adj = adjustedSeries(ps, ev);
  assert.ok(Math.abs(adj.close[2] / adj.close[1] - 143 / 136.5) < 1e-9);   // 還原後只剩真實漲跌（+4.8%）
});
