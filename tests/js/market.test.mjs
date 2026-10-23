// 開休市狀態：以 2026-10 薔琵颱風為例（10/22 四 有開盤、10/23 五 停市、10/26 一 補假、10/27 二 開盤）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketStatus, marketNotice, tpeClock, closedReason } from '../../assets/js/market.js';
import * as F from '../../assets/js/format.js';

const MARKET = {
  lastTradingDay: '2026-10-22',
  holidays: [{ date: '2026-10-26', name: '臺灣光復暨金門古寧頭大捷紀念日' }],
  closures: ['2026-10-23'],
  holidaysOk: true,
};
const at = (s) => new Date(`${s}+08:00`);   // 台北時間

test('tpeClock：UTC 16:30 = 台北隔天 00:30', () => {
  assert.deepEqual(tpeClock(new Date('2026-10-22T16:30:00Z')), { date: '2026-10-23', minutes: 30 });
});

test('dayLabel：日期加星期', () => {
  assert.equal(F.dayLabel('2026-10-23'), '10/23（五）');
  assert.equal(F.dayLabel('2026-10-25'), '10/25（日）');
  assert.equal(F.dayLabel(''), 'N/A');
});

test('颱風停市日：警示橫幅，下次開盤跳過週末與補假', () => {
  const st = marketStatus(at('2026-10-23T22:26:00'), MARKET);
  assert.equal(st.state, 'closed');
  assert.equal(st.reason, '臨時休市');
  assert.equal(st.nextOpen, '2026-10-27');
  assert.deepEqual(marketNotice(st), {
    level: 'warn',
    text: '今天 10/23（五）台股休市（臨時休市）。下列為 10/22（四）收盤資料，下次開盤 10/27（二）。',
  });
});

test('週末：一般橫幅', () => {
  const n = marketNotice(marketStatus(at('2026-10-24T10:00:00'), MARKET));
  assert.equal(n.level, 'info');
  assert.equal(n.text, '今天 10/24（六）台股休市（週末）。下列為 10/22（四）收盤資料，下次開盤 10/27（二）。');
});

test('排定休市日顯示假日名稱', () => {
  const st = marketStatus(at('2026-10-26T11:00:00'), MARKET);
  assert.equal(st.reason, '臺灣光復暨金門古寧頭大捷紀念日');
  assert.equal(marketNotice(st).level, 'warn');
});

test('盤前、盤中、收盤後', () => {
  const m = { ...MARKET, lastTradingDay: '2026-10-22' };
  assert.equal(marketStatus(at('2026-10-27T08:30:00'), m).state, 'pre');
  assert.match(marketNotice(marketStatus(at('2026-10-27T08:30:00'), m)).text, /^盤前：下列為 10\/22（四）收盤資料/);
  assert.equal(marketStatus(at('2026-10-27T09:00:00'), m).state, 'open');
  assert.equal(marketStatus(at('2026-10-27T13:29:00'), m).state, 'open');
  const after = marketStatus(at('2026-10-27T13:30:00'), m);
  assert.equal(after.state, 'after');
  assert.match(marketNotice(after).text, /還沒更新/);
  // 收盤資料已是今天 → 不顯示
  assert.equal(marketNotice(marketStatus(at('2026-10-27T17:00:00'), { ...m, lastTradingDay: '2026-10-27' })), null);
});

test('休市表抓取失敗時，推斷的休市不標「臨時」', () => {
  assert.equal(closedReason('2026-10-23', { closures: ['2026-10-23'], holidaysOk: false }), '休市');
});

test('沒有 market 區塊（舊版 meta）也不會出錯', () => {
  const st = marketStatus(at('2026-10-24T10:00:00'), undefined);
  assert.equal(st.state, 'closed');
  assert.match(marketNotice(st).text, /最近一次收盤資料，下次開盤 10\/26（一）/);
});
