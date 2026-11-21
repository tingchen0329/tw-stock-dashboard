/**
 * 選股條件回測：「當時已公布」的資料（不能偷看未來）、報酬與手續費計算、偏差說明需要的比較基準
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quarterDeadline, revenueDeadline, rebalanceDates, idxLE, factorsAt, prepStock, buildPanel, runBacktest, COST, BT_COLS,
} from '../../assets/js/backtest.js';
import { TW_PRESETS } from '../../assets/js/presets.js';

const T = (cols, rows) => ({ cols, rows });
/** 2025-01-01 起的平日 */
function weekdays(from, to) {
  const out = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += 864e5) {
    const d = new Date(t);
    if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

test('公布期限：月營收次月 10 日、季報 5/15 8/14 11/14 次年 3/31', () => {
  assert.equal(revenueDeadline(2026, 9), '2026-10-10');
  assert.equal(revenueDeadline(2026, 12), '2027-01-10');
  assert.equal(quarterDeadline('2026-03-31'), '2026-05-15');
  assert.equal(quarterDeadline('2026-06-30'), '2026-08-14');
  assert.equal(quarterDeadline('2026-09-30'), '2026-11-14');
  assert.equal(quarterDeadline('2025-12-31'), '2026-03-31');
  assert.equal(quarterDeadline('2026-05-31'), null);
});

test('換股日：每月 11 日（含）以後第一個交易日', () => {
  assert.deepEqual(rebalanceDates(['2026-10-08', '2026-10-12', '2026-10-13', '2026-11-10', '2026-11-11', '2026-11-12']), ['2026-10-12', '2026-11-11']);
  assert.equal(idxLE(['a', 'c', 'e'], 'd'), 1);
  assert.equal(idxLE(['b'], 'a'), -1);
});

/** 一檔合成股票：月營收、季報、本益比、股價 */
function stock({ revOct = 300, eps = [1, 1, 1, 1, 2, 2, 5] } = {}) {
  const dates = weekdays('2024-09-02', '2026-11-30');
  const close = dates.map((_, i) => 100 + i * 0.1);
  const price = T(['date', 'open', 'max', 'min', 'close', 'Trading_Volume'], dates.map((d, i) => [d, close[i], close[i], close[i], close[i], 1_000_000]));
  const per = T(['date', 'PER', 'PBR', 'dividend_yield'], dates.map((d) => [d, 20, 4, 3]));
  const rev = [];
  for (let y = 2024; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
    if (y === 2026 && m > 10) break;
    rev.push([`${y}-${String(m).padStart(2, '0')}-01`, y === 2026 && m === 10 ? revOct : 100 + (y - 2024) * 12 + m, y, m]);
  }
  const qs = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30'];
  const inc = qs.flatMap((q, i) => [[q, 'EPS', eps[i], '每股盈餘'], [q, 'Revenue', 1000, '營業收入'], [q, 'OperatingIncome', 100 + i * 10, '營業利益']]);
  return { code: '1234', name: '測試', tables: { price, per, revenue: T(['date', 'revenue', 'revenue_year', 'revenue_month'], rev), income: T(['date', 'type', 'value', 'origin_name'], inc) } };
}

test('點時資料：10 月營收 11/10 以後才用；第三季財報 11/14 以後才用', () => {
  const st = prepStock(stock());
  const before = factorsAt(st, '2026-11-09', '2026-11-06');
  const after = factorsAt(st, '2026-11-11', '2026-11-10');
  // 11/09：最新可用是 9 月（年增 = 9 月 vs 去年 9 月）
  assert.ok(Math.abs(before.revYoY - ((100 + 24 + 9) / (100 + 12 + 9) - 1) * 100) < 1e-9);
  // 11/11：10 月營收 300（暴增）已公布
  assert.ok(Math.abs(after.revYoY - (300 / (100 + 12 + 10) - 1) * 100) < 1e-9);
  // EPS：11/11 只能用到第二季（今年累計 2 + 2 = 4）；11/17 才有第三季（2 + 2 + 5 = 9）
  assert.equal(after.eps, 4);
  assert.equal(factorsAt(st, '2026-11-17', '2026-11-16').eps, 9);
  // 營益率今年累計：(140 + 150) / 2000
  assert.ok(Math.abs(after.om - 14.5) < 1e-9);
  // 3 月中：去年年報還沒到期限 → 用去年前三季（1 + 1 + 1）
  assert.equal(factorsAt(st, '2026-03-11', '2026-03-10').eps, 3);
  // 本益比 / ROE 推估 / 殖利率 / 20 日均量（張）
  assert.deepEqual([after.pe, after.roe, after.yield, after.volume], [20, 20, 3, 1000]);
});

test('buildPanel：報酬用還原股價（除息日不算虧損），ETF 略過', () => {
  const s = stock();
  const dates = s.tables.price.rows.map((r) => r[0]);
  // 2026-07-15 除息 5 元：收盤直接掉 5 元
  const ex = dates.indexOf('2026-07-15');
  s.tables.price.rows = s.tables.price.rows.map((r, i) => (i >= ex ? [r[0], r[1] - 5, r[2] - 5, r[3] - 5, r[4] - 5, r[5]] : r));
  const before = s.tables.price.rows[ex - 1][4];
  s.tables.divResult = T(['date', 'before_price', 'after_price', 'stock_and_cache_dividend', 'stock_or_cache_dividend'], [['2026-07-15', before, before - 5, 5, '息']]);
  const bench = { dates, close: dates.map((_, i) => 1000 + i), label: '加權報酬指數', kind: 'tr' };
  const panel = buildPanel([s, { ...stock(), code: '0050' }], bench);
  assert.equal(panel.stocks.length, 1);
  assert.deepEqual(panel.cols, [...BT_COLS, 'ret']);
  const i = panel.dates.indexOf('2026-07-13');
  const ret = panel.stocks[0].rows[i][panel.cols.indexOf('ret')];
  assert.ok(ret > 0, `含息報酬應為正（股價每天 +0.1），實際 ${ret}`);
  assert.equal(panel.bench.ret.length, panel.dates.length);
  assert.equal(panel.end, dates[dates.length - 1]);
  assert.equal(buildPanel([s], { dates: dates.slice(0, 10), close: [] }), null);       // 大盤資料不足
});

/** 手寫 panel：A 每期 +10%（營收年增 30%）、B 每期 −10%（營收年增 5%）、C 尚未上市 */
const panel = {
  dates: ['2026-01-12', '2026-02-11', '2026-03-11'], end: '2026-04-10', day: 11,
  cols: [...BT_COLS, 'ret'],
  bench: { label: '大盤', kind: 'tr', ret: [0.02, 0.02, 0.02] },
  stocks: [
    { code: 'A', name: '甲', rows: [0, 1, 2].map(() => [30, 20, 1, 10, 15, 12, 3, 800, 0.1]) },
    { code: 'B', name: '乙', rows: [0, 1, 2].map(() => [5, 5, 1, 10, 15, 12, 3, 800, -0.1]) },
    { code: 'C', name: '丙', rows: [null, null, [30, 20, 1, 10, 15, 12, 3, 800, 0.0]] },
  ],
};

test('runBacktest：條件、等權、手續費與證交稅', () => {
  const r = runBacktest(panel, [{ key: 'revYoY', op: '>=', value: 20 }, { key: 'big1000Chg', op: '>=', value: 1, label: '千張大戶週增減' }]);
  assert.deepEqual(r.periods.map((p) => p.picks), [['A'], ['A'], ['A', 'C']]);
  assert.deepEqual(r.skipped.map((c) => c.key), ['big1000Chg']);           // 沒有歷史資料的條件不使用
  // 第一期：買進 100% → 手續費 0.1425%
  assert.ok(Math.abs(r.periods[0].ret - ((1 - COST.buy) * 1.1 - 1)) < 1e-12);
  // 第二期：持股不變 → 沒有成本
  assert.ok(Math.abs(r.periods[1].ret - 0.1) < 1e-12);
  // 第三期：A 賣一半（50%）、買 C 50% → 0.5 × 賣出成本 + 0.5 × 買進成本；報酬 (10% + 0%) / 2
  const fee = 0.5 * COST.sell + 0.5 * COST.buy;
  assert.ok(Math.abs(r.periods[2].ret - ((1 - fee) * 1.05 - 1)) < 1e-12);
  assert.ok(Math.abs(r.periods[0].univ - 0) < 1e-12);                       // 清單等權：(+10% − 10%) / 2
  assert.equal(r.stats.strat.win, 100);
  assert.equal(r.curve.dates.length, 4);
  assert.ok(r.stats.bench.total > 6 && r.stats.bench.total < 6.2);         // 1.02³ − 1
  assert.equal(r.stats.strat.mdd, 0);
});

test('runBacktest：缺資料不會被選入；選不到股票的月份持有現金', () => {
  const r = runBacktest(panel, [{ key: 'pe', op: '<=', value: 5 }]);
  assert.ok(r.periods.every((p) => p.n === 0 && p.ret === 0));
  assert.equal(r.stats.strat.total, 0);
  assert.equal(r.stats.strat.empty, 3);
  const withNull = structuredClone(panel);
  withNull.stocks[0].rows[0][0] = null;                                     // A 第一期沒有營收
  assert.deepEqual(runBacktest(withNull, [{ key: 'revYoY', op: '>=', value: 20 }]).periods[0].picks, []);
  // 條件清空（null）＝不使用 → 全部選入
  assert.deepEqual(runBacktest(panel, [{ key: 'revYoY', op: '>=', value: null }]).periods[0].picks, ['A', 'B']);
});

test('預設條件的欄位都能回測（千張大戶除外）', () => {
  for (const p of Object.values(TW_PRESETS)) {
    const r = runBacktest(panel, p.criteria);
    assert.ok(r.skipped.every((c) => c.key.startsWith('big1000')), r.skipped.map((c) => c.key).join());
  }
});
