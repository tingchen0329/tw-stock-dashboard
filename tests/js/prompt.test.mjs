// 分析指令：缺資料時也要完整、不出現 undefined / NaN
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../../assets/js/prompt.js';

const EMPTY = {
  info: { code: '7777', name: '測試', market: 'emerging', industry: '' }, price: null, valuation: {}, tech: null,
  river: null, revenue: null, inst: null, instToday: null, margin: null, holding: null, fundamentals: null,
};

test('幾乎沒有資料：每段寫 N/A，仍有輸出要求', () => {
  const p = buildPrompt(EMPTY, {}, []);
  assert.doesNotMatch(p, /undefined|NaN|null/);
  assert.match(p, /^你是台股分析師，依下列數據分析 7777 測試（興櫃｜產業 N\/A）。/);
  for (const sec of ['【總經】N/A', '【股價】N/A', '【營收】N/A', '【獲利】N/A', '【本益比河流圖】N/A']) assert.ok(p.includes(sec), sec);
  assert.match(p, /破線停損價/);
  assert.match(p, /非投資建議/);
});

test('資料日取自 meta.market，並帶星期', () => {
  const p = buildPrompt(EMPTY, { market: { lastTradingDay: '2026-10-22' } }, []);
  assert.match(p, /資料日：10\/22（四）收盤/);
});
