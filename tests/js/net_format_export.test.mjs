// 網路層、格式化、匯出
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJSON, HttpError, _resetCache } from '../../assets/js/net.js';
import * as F from '../../assets/js/format.js';
import { crc32, toCSV, toXLSX } from '../../assets/js/export.js';
import { niceTicks } from '../../assets/js/charts.js';

const okFetch = (data, delay = 0, counter = { n: 0 }) => (url, { signal } = {}) => {
  counter.n++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ ok: true, status: 200, json: async () => data }), delay);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); });
  });
};

test('進行中請求共用：同時兩次呼叫只發一次請求', async () => {
  _resetCache();
  const c = { n: 0 };
  const f = okFetch({ a: 1 }, 20, c);
  const [x, y] = await Promise.all([fetchJSON('u1', { fetchImpl: f }), fetchJSON('u1', { fetchImpl: f })]);
  assert.deepEqual(x, y);
  assert.equal(c.n, 1);
});

test('快取：ttl 內不重抓', async () => {
  _resetCache();
  const c = { n: 0 };
  const f = okFetch({ a: 2 }, 0, c);
  await fetchJSON('u2', { fetchImpl: f, ttl: 60000 });
  await fetchJSON('u2', { fetchImpl: f, ttl: 60000 });
  assert.equal(c.n, 1);
});

test('逾時會中止請求', async () => {
  _resetCache();
  await assert.rejects(fetchJSON('u3', { fetchImpl: okFetch({}, 500), timeout: 30 }), (e) => e.name === 'AbortError');
});

test('HTTP 錯誤帶狀態碼（402 = FinMind 額度用完）', async () => {
  _resetCache();
  const f = async () => ({ ok: false, status: 402, json: async () => ({}) });
  await assert.rejects(fetchJSON('u4', { fetchImpl: f }), (e) => e instanceof HttpError && e.status === 402);
});

test('一個呼叫端取消，不影響另一個等待同一請求的呼叫端', async () => {
  _resetCache();
  const f = okFetch({ ok: 1 }, 30);
  const ctrl = new AbortController();
  const a = fetchJSON('u5', { fetchImpl: f, signal: ctrl.signal });
  const b = fetchJSON('u5', { fetchImpl: f });
  ctrl.abort();
  await assert.rejects(a, (e) => e.name === 'AbortError');
  assert.deepEqual(await b, { ok: 1 });
});

test('格式化：0 不是 N/A、缺資料是 N/A、漲跌帶符號', () => {
  assert.equal(F.signed(0), '0.00');
  assert.equal(F.num(null), 'N/A');
  assert.equal(F.num(NaN), 'N/A');
  assert.equal(F.change(15, 1.05), '▲ +15.00 (+1.05%)');
  assert.equal(F.change(-3, -0.5), '▼ -3.00 (-0.50%)');
  assert.equal(F.lots(-4857000), '-4,857');
  assert.equal(F.twd(1.684e11), '1,684.0億');
});

test('台北日期：UTC 前一天 23:30 已是台北隔天（舊版用 UTC 會差一天）', () => {
  assert.equal(F.todayTPE(new Date('2026-10-19T23:30:00Z')), '2026-10-20');
  assert.equal(F.daysBefore('2026-03-01', 1), '2026-02-28');
});

test('圖表刻度一定涵蓋資料範圍（舊版刻度起點往上取整，線條超出圖框）', () => {
  const t = niceTicks(496.9, 1000);
  assert.ok(t[0] <= 496.9 && t.at(-1) >= 1000, JSON.stringify(t));
  const b = niceTicks(-12, 38);
  assert.ok(b[0] <= -12 && b.at(-1) >= 38 && b.includes(0));
});

test('CRC32 標準測試向量', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('CSV：BOM、逗號與引號跳脫', () => {
  const s = toCSV([{ name: 'x', rows: [['a,b', 'say "hi"', 3]] }]);
  assert.ok(s.startsWith('﻿# x'));
  assert.ok(s.includes('"a,b","say ""hi""",3'));
});

test('XLSX：zip 結構正確（檔頭 PK、含 workbook）', () => {
  const bytes = toXLSX([{ name: '摘要', rows: [['項目', '數值'], ['股價', 1000.5]] }]);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  assert.ok(new TextDecoder().decode(bytes).includes('xl/workbook.xml'));
});
