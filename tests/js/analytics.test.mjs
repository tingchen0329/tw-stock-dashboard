// 指標計算正確性 + 舊版 bug 的回歸測試
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../../assets/js/analytics.js';

const close = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const table = (cols, rowsArr) => ({ cols, rows: rowsArr });

test('SMA', () => {
  assert.deepEqual(A.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('EMA 以前 n 筆平均為起點', () => {
  const e = A.ema([1, 2, 3, 4], 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  near(e[2], 2);
  near(e[3], 4 * 0.5 + 2 * 0.5);
});

test('RSI：一路上漲 = 100、一路下跌 = 0', () => {
  assert.equal(A.rsi(close(30, (i) => 100 + i)).at(-1), 100);
  near(A.rsi(close(30, (i) => 100 - i)).at(-1), 0);
});

test('KD：收在 9 日最高點時 K 往 100 靠近、平盤時維持 50', () => {
  const up = close(40, (i) => 10 + i);
  const { K } = A.kd(up, up, up);
  assert.ok(K.at(-1) > 95);
  const flat = close(20, () => 10);
  assert.equal(A.kd(flat, flat, flat).K.at(-1), 50);
});

test('MACD：常數序列 DIF = 0', () => {
  const m = A.macd(close(60, () => 50));
  near(m.dif.at(-1), 0);
  near(m.osc.at(-1), 0);
});

test('月營收：月份用 revenue_year/revenue_month，不是 date（舊版 bug：月份晚一個月）', () => {
  const t = table(['revenue_year', 'revenue_month', 'revenue'], [
    [2025, 9, 100], [2025, 10, 110], [2026, 8, 150], [2026, 9, 120],
  ]);
  const r = A.revenueStats(t);
  assert.equal(r.latest.period, '2026-09');        // FinMind date 會是 2026-10-01
  near(r.latest.yoy, 20);                          // 120 / 100 − 1
  near(r.latest.mom, -20);                         // 120 / 150 − 1
});

test('月營收：年增率是正常的百分比（舊版把年份 2026 當去年營收，算出 +20272710561%）', () => {
  const t = table(['revenue_year', 'revenue_month', 'revenue'], [[2025, 4, 1033275118], [2026, 4, 1023839000]]);
  const r = A.revenueStats(t);
  assert.ok(Math.abs(r.latest.yoy) < 100);
});

test('三大法人：外資自營商算外資；連續買超天數', () => {
  const rowsArr = [];
  ['2026-10-15', '2026-10-16', '2026-10-17'].forEach((d, k) => {
    rowsArr.push([d, 'Foreign_Investor', 2000, 1000], [d, 'Foreign_Dealer_Self', 500, 0],
      [d, 'Investment_Trust', 0, 300], [d, 'Dealer_self', 100, 0], [d, 'Dealer_Hedging', 0, 50 * (k + 1)]);
  });
  const s = A.instStats(table(['date', 'name', 'buy', 'sell'], rowsArr));
  assert.equal(s.latest.foreign, 1500);
  assert.equal(s.latest.trust, -300);
  assert.equal(s.latest.dealer, 100 - 150);
  assert.equal(s.foreignStreak, 3);
  assert.equal(s.sum5.foreign, 4500);
});

test('融資融券：券資比', () => {
  const s = A.marginStats(table(['date', 'MarginPurchaseTodayBalance', 'ShortSaleTodayBalance'], [['2026-10-17', 10000, 500]]));
  near(s.shortRatio, 5);
});

test('河流圖：資料太少回傳 null；區間判斷正確', () => {
  const dates = close(300, (i) => `2025-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`);
  const px = close(300, (i) => 100 + i * 0.1);
  const ps = { dates, close: px, open: px, high: px, low: px, volume: px };
  assert.equal(A.peRiver({ ...ps, dates: dates.slice(0, 30), close: px.slice(0, 30) }, table(['date', 'PER'], dates.slice(0, 30).map((d) => [d, 15]))), null);
  const per = dates.map((d, i) => [d, 10 + (i / 299) * 10]);      // 本益比 10 → 20，最後一天最高
  const r = A.peRiver(ps, table(['date', 'PER'], per));
  assert.equal(r.zone, '極高');
  near(r.currentEPS, px.at(-1) / 20);
  assert.equal(r.bands.length, 5);
});

test('財報：近四季 EPS、ROE、負債比', () => {
  const inc = []; const bal = [];
  const qs = ['2024-12-31', '2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30'];
  qs.forEach((d, i) => {
    inc.push([d, 'EPS', i < 4 ? 1 : 2, '基本每股盈餘'], [d, 'Revenue', 100, '營業收入合計'], [d, 'GrossProfit', 40, '營業毛利'],
      [d, 'OperatingIncome', 20, '營業利益'], [d, 'IncomeAfterTaxes', 10, '本期淨利'], [d, 'Revenue_per', 100, '營業收入合計']);
    bal.push([d, 'TotalAssets', 1000, '資產總計'], [d, 'Liabilities', 400, '負債總計'], [d, 'Equity', 500, '權益總計'],
      [d, 'CurrentAssets', 300, '流動資產合計'], [d, 'CurrentLiabilities', 150, '流動負債合計']);
  });
  const cols = ['date', 'type', 'value', 'origin_name'];
  const f = A.fundamentals(table(cols, inc), table(cols, bal));
  assert.equal(f.eps4, 8);
  assert.equal(f.epsPrev4, 4);
  near(f.eps4YoY, 100);
  near(f.margins.gross, 40);
  near(f.roe, 40 / 500 * 100);
  near(f.debtRatio, 40);
  near(f.currentRatio, 200);
});

test('財報：type 改名時用中文科目名稱備援', () => {
  const cols = ['date', 'type', 'value', 'origin_name'];
  const f = A.fundamentals(table(cols, [['2026-06-30', 'BasicEPS_new', 3.2, '基本每股盈餘（元）']]), null);
  assert.equal(f.quarters[0].eps, 3.2);
});

test('價格優先序：盤中價較新時用盤中價，否則用官方收盤', () => {
  const info = { code: '2330', name: '台積電', market: 'twse' };
  const mkt = { close: 1000, change: 10 };
  const asOf = { twse: '2026-10-19' };
  const a = A.summarize({ info, mkt, quote: { value: 1010, change: 10, changePct: 1, time: '2026-10-20T10:12+08:00' }, asOf });
  assert.equal(a.price.price, 1010);
  assert.equal(a.price.kind, '盤中');
  const b = A.summarize({ info, mkt, quote: { value: 1000, time: '2026-10-19T13:30+08:00' }, asOf });
  assert.equal(b.price.kind, '收盤');
  near(b.price.changePct, (10 / 990) * 100);
});

test('漲跌為 0 不是缺資料（舊版把 0 當 falsy 不顯示）', () => {
  const s = A.summarize({ info: { code: '1', name: 'x', market: 'twse' }, mkt: { close: 50, change: 0 }, asOf: {} });
  assert.equal(s.price.change, 0);
  assert.equal(s.price.changePct, 0);
});

test('完整度：沒有任何資料時為 0%，並列出缺項', () => {
  const s = A.summarize({ info: { code: '1', name: 'x', market: 'twse' }, mkt: null, asOf: {} });
  const c = A.completeness(s);
  assert.equal(c.pct, 0);
  assert.ok(c.missing.includes('近四季 EPS'));
});

test('riskStats：相對大盤、Beta、波動度、最大回撤', async () => {
  const { riskStats } = await import('../../assets/js/analytics.js');
  const dates = Array.from({ length: 300 }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10));
  const bench = { label: 'B', dates, close: dates.map((_, i) => 100 * 1.001 ** i * (1 + 0.01 * Math.sin(i))) };
  // 個股 = 大盤日報酬的 2 倍 → Beta 約 2
  const close = [100];
  for (let i = 1; i < 300; i++) close.push(close[i - 1] * (1 + 2 * (bench.close[i] / bench.close[i - 1] - 1)));
  const r = riskStats({ dates, close }, bench);
  assert.ok(Math.abs(r.beta - 2) < 0.01, `beta ${r.beta}`);
  assert.ok(Math.abs(r.vol / r.benchVol - 2) < 0.01);
  assert.ok(r.mdd <= 0);
  assert.equal(r.label, 'B');
  assert.ok(r.periods.y1 && Math.abs(r.periods.y1.excess - (r.periods.y1.stock - r.periods.y1.bench)) < 1e-9);
  // 對不上日期（少於 120 個共同交易日）→ null
  assert.equal(riskStats({ dates: dates.slice(0, 100), close: close.slice(0, 100) }, bench), null);
  assert.equal(riskStats({ dates, close }, null), null);
});

test('台股現金流量表：年初累計拆單季；缺上一期就略過', async () => {
  const { twCashflowRows } = await import('../../assets/js/analytics.js');
  const t = { cols: ['date', 'type', 'value', 'origin_name'], rows: [
    ['2025-03-31', 'CashFlowsFromOperatingActivities', 100, '營業活動之淨現金流入（流出）'],
    ['2025-03-31', 'PropertyAndPlantAndEquipment', -30, '取得不動產、廠房及設備'],
    ['2025-06-30', 'CashFlowsFromOperatingActivities', 250, '營業活動之淨現金流入（流出）'],
    ['2025-06-30', 'PropertyAndPlantAndEquipment', -50, '取得不動產、廠房及設備'],
    ['2025-12-31', 'CashFlowsFromOperatingActivities', 600, '營業活動之淨現金流入（流出）'],   // 缺 9 月 → 無法拆
  ] };
  const r = twCashflowRows(t);
  assert.deepEqual(r.map((x) => [x[0], x[1], x[2]]), [
    ['2025-03-31', 'OperatingCashFlow', 100], ['2025-03-31', 'Capex', 30],
    ['2025-06-30', 'OperatingCashFlow', 150], ['2025-06-30', 'Capex', 20]]);
});

test('股利與填息：民國年度、填息天數、尚未填息', async () => {
  const { dividendStats } = await import('../../assets/js/analytics.js');
  const ps = { dates: ['2025-07-01', '2025-07-02', '2025-07-03', '2025-07-04', '2026-07-01', '2026-07-02'], close: [100, 95, 97, 101, 110, 104] };
  const div = { cols: ['year', 'CashEarningsDistribution', 'StockEarningsDistribution'], rows: [['113年', 5, 0], ['114年第1季', 2, 0], ['114年第2季', 3, 0]] };
  const res = { cols: ['date', 'before_price', 'stock_and_cache_dividend', 'stock_or_cache_dividend'], rows: [['2025-07-02', 100, 5, '息'], ['2026-07-02', 108, 3, '息']] };
  const quarters = ['2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31'].map((date) => ({ date, eps: 2.5 }));
  const d = dividendStats(div, res, ps, quarters);
  assert.deepEqual(d.policy.map((r) => [r.year, r.cash, r.times]), [[2024, 5, 1], [2025, 5, 2]]);
  assert.equal(d.policy[0].payout, 50);
  assert.equal(d.streak, 2);
  assert.equal(d.events[0].fillDays, 3);          // 07-02 起第 3 個交易日 07-04 收 101 ≥ 100
  assert.equal(d.events[1].filled, false);
  assert.ok(Math.abs(d.events[1].gap - (104 / 108 - 1) * 100) < 1e-9);
  assert.equal(d.fillRate, 50);
});

test('同業排名與內部人彙總', async () => {
  const { peerStats, insiderStats } = await import('../../assets/js/analytics.js');
  const sc = { cols: ['code', 'industry', 'pe', 'revYoY', 'roe', 'yield'], rows: [
    ['A', 'X', 10, 5, 10, 3], ['B', 'X', 20, 15, 8, 2], ['C', 'X', -5, 30, 1, 0], ['D', 'Y', 8, 1, 1, 1]] };
  const p = peerStats(sc, 'B');
  assert.equal(p.n, 3);
  assert.deepEqual(p.ranks.pe, { rank: 2, of: 2, median: 15 });          // 負本益比不列入
  assert.equal(p.ranks.revYoY.rank, 2);
  assert.equal(peerStats(sc, 'D'), null);                                  // 同產業只有自己
  const x = insiderStats({ filings: {
    a: { filed: '2026-10-01', tx: [{ date: '2026-10-01', owner: 'P1', code: 'P', shares: 10, price: 5 }] },
    b: { filed: '2026-09-01', tx: [{ date: '2026-09-01', owner: 'P2', code: 'S', shares: 4, price: 10, plan: true }, { date: '2026-09-01', owner: 'P2', code: 'F', shares: 1, price: 10 }] },
    c: { filed: '2025-01-01', tx: [{ date: '2025-01-01', owner: 'P3', code: 'S', shares: 999, price: 10 }] },
  } });
  assert.deepEqual([x.buy.value, x.sell.value, x.sell.plan, x.net], [50, 40, 1, 10]);     // 6 個月外的不算
  assert.equal(x.recent[0].date, '2026-10-01');
});
