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
