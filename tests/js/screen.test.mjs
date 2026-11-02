// 全市場選股：條件判斷（畫面由 e2e 測試涵蓋）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyScreen, toObjects, PRESETS } from '../../assets/js/screen.js';

const screen = {
  cols: ['code', 'yield', 'eps', 'roe', 'pe', 'revCumYoY', 'volume', 'revYoY', 'om'],
  rows: [
    ['1101', 6.1, 1.2, 9, 12, -3, 5000, -5, 4],     // 殖利率型 ✔
    ['2330', 1.2, 45, 28, 22, 36, 30000, 31, 49],   // 成長型 ✔
    ['2002', 7.0, -0.5, 2, null, -12, 20000, -8, -1], // 虧損：兩種都不選
    ['9999', 5.5, 2, 10, 10, null, 800, 3, 6],      // 累計營收缺資料 → 殖利率型不選
  ],
};
const rows = toObjects(screen);
const crit = (p) => PRESETS[p].criteria;

test('成長型與殖利率型分開', () => {
  assert.deepEqual(applyScreen(rows, crit('growth')).map((r) => r.code), ['2330']);
  assert.deepEqual(applyScreen(rows, crit('yield')).map((r) => r.code), ['1101']);
});

test('缺資料不會被選入；條件留空代表不使用', () => {
  const c = crit('yield').map((x) => (x.key === 'revCumYoY' ? { ...x, value: null } : x));
  assert.deepEqual(applyScreen(rows, c).map((r) => r.code), ['1101', '9999']);
});

test('「大於」不含等於', () => {
  assert.equal(applyScreen([{ eps: 0 }], [{ key: 'eps', op: '>', value: 0 }]).length, 0);
});

test('美股選股：成長型 / 殖利率型預設條件', async () => {
  const { US_PRESETS } = await import('../../assets/js/screen.js');
  const us = [
    { code: 'NVDA', revYoY: 60, epsYoY: 70, netMargin: 50, roe: 90, pe: 38, yield: 0.03, epsTTM: 4 },
    { code: 'KO', revYoY: 3, epsYoY: 5, netMargin: 25, roe: 40, pe: 19, yield: 3.1, epsTTM: 3 },
    { code: 'XOM', revYoY: -12, epsYoY: -20, netMargin: 9, roe: 12, pe: 14, yield: 3.5, epsTTM: 7 },   // 營收衰退太多
    { code: 'LOSS', revYoY: 30, epsYoY: null, netMargin: -5, roe: -3, pe: null, yield: 4, epsTTM: -1 },
  ];
  assert.deepEqual(applyScreen(us, US_PRESETS.growth.criteria).map((r) => r.code), ['NVDA']);
  assert.deepEqual(applyScreen(us, US_PRESETS.yield.criteria).map((r) => r.code), ['KO']);
  for (const p of Object.values(US_PRESETS)) for (const c of p.criteria) assert.ok(['>=', '<=', '>', '<'].includes(c.op), c.key);
});
