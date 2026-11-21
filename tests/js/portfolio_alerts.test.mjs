/**
 * 持股損益、到價通知（規則解析、邊緣觸發、推播腳本）與集保千張大戶
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseHoldings, valuate, stopRules, mergeHolding, normHolding, loadHoldings } from '../../assets/js/portfolio.js';
import { parseRules, evaluate, step, ruleId, parseCode, describe } from '../../assets/js/alert_rules.js';
import { holderStats, summarize, overviewRow } from '../../assets/js/analytics.js';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ───────── 持股 ───────── */

test('匯入：CSV（中文市場、標題列、美股代號自動判斷）與 JSON；格式錯誤略過', () => {
  const { items, skipped } = parseHoldings('﻿市場,代號,股數,成本\n台股,2330,1000,850.5\n美股,nvda,10,120\n台股,abc!,1,1\n台股,2317,-5,100\n');
  assert.deepEqual(items, [{ mkt: 'tw', code: '2330', shares: 1000, cost: 850.5 }, { mkt: 'us', code: 'NVDA', shares: 10, cost: 120 }]);
  assert.equal(skipped, 2);
  const j = parseHoldings(JSON.stringify([{ mkt: 'tw', code: '0050', shares: 2000, cost: 150, note: '定期定額' }]));
  assert.deepEqual(j.items, [{ mkt: 'tw', code: '0050', shares: 2000, cost: 150, note: '定期定額' }]);
  assert.equal(parseHoldings('{bad').items.length, 0);
  assert.equal(normHolding({ mkt: 'tw', code: '2330.TW', shares: 1, cost: 1 }).code, '2330');
});

test('同代號再次輸入＝更新（不重複）；localStorage 壞掉時回傳空清單', () => {
  const a = mergeHolding([{ mkt: 'tw', code: '2330', shares: 1000, cost: 800 }], { mkt: 'tw', code: '2330', shares: 2000, cost: 900 });
  assert.deepEqual(a, [{ mkt: 'tw', code: '2330', shares: 2000, cost: 900 }]);
  assert.deepEqual(loadHoldings({ getItem: () => '{not json' }), []);
  assert.deepEqual(loadHoldings({ getItem: () => { throw new Error('SecurityError'); } }), []);
});

test('損益：台股 + 美股換算台幣、今日損益、占比；缺價格不計入合計', () => {
  const prices = { 2330: { price: 1000, chgPct: 2, name: '台積電' }, NVDA: { price: 150, chgPct: -1 }, 9999: null };
  const v = valuate([
    { mkt: 'tw', code: '2330', shares: 1000, cost: 800 },
    { mkt: 'us', code: 'NVDA', shares: 10, cost: 100 },
    { mkt: 'tw', code: '9999', shares: 1000, cost: 10 },
  ], (x) => prices[x.code], 32);
  const [tsmc, nvda, miss] = v.rows;
  assert.equal(tsmc.pnl, 200_000);
  assert.equal(tsmc.ret, 25);
  assert.ok(Math.abs(tsmc.day - (1_000_000 - 1_000_000 / 1.02)) < 1e-6);
  assert.equal(nvda.valueTwd, 1500 * 32);
  assert.equal(nvda.pnlTwd, 500 * 32);
  assert.equal(miss.price, null);
  assert.equal(v.total.value, 1_000_000 + 48_000);
  assert.equal(v.total.missing, 1);
  assert.ok(Math.abs(tsmc.weight + nvda.weight - 100) < 1e-9);
  assert.equal(miss.weight, null);
  // 沒有匯率：美股不計入台幣合計、標示 noFx
  const noFx = valuate([{ mkt: 'us', code: 'NVDA', shares: 1, cost: 1 }], () => ({ price: 2 }), null);
  assert.equal(noFx.total.noFx, true);
  assert.equal(noFx.total.value, 0);
});

test('依成本產生停損 / 停利規則，且規則格式可被解析', () => {
  const lines = stopRules([{ mkt: 'tw', code: '2330', shares: 1000, cost: 1000 }, { mkt: 'us', code: 'NVDA', shares: 1, cost: 100 }]);
  assert.equal(lines[0], '2330,價格<=,900,停損 -10%（成本 1000）');
  assert.equal(lines[3], 'US:NVDA,價格>=,120,停利 +20%（成本 100）');
  const { rules, errors } = parseRules(lines.join('\n'));
  assert.equal(rules.length, 4);
  assert.equal(errors.length, 0);
});

/* ───────── 規則 ───────── */

test('規則解析：別名、總經、註解、錯誤訊息', () => {
  const { rules, errors } = parseRules([
    '代號,條件,數值,備註', '# 註解', '', '2330, price<= ,900,停損, 分批',
    'MACRO:KEEP,<=,160,維持率', 'nvda,rsi>=,75', '2454,站上MA20', 'xx!,<=,1', '2330,abc,1', '2330,價格<=,', 'MACRO:vix,RSI>=,1',
  ].join('\n'));
  assert.deepEqual(rules.map((r) => [r.kind, r.code, r.cond.key, r.value]), [
    ['tw', '2330', '價格<=', 900], ['macro', 'keep', '價格<=', 160], ['us', 'NVDA', 'RSI>=', 75], ['tw', '2454', '站上MA20', null]]);
  assert.equal(rules[0].note, '停損,分批');
  assert.deepEqual(errors.map((e) => e.line), [8, 9, 10, 11]);
  assert.deepEqual(parseCode('US:brk.b'), { kind: 'us', code: 'BRK.B' });
  // id 只跟「代號 + 條件 + 數值」有關（改備註不會重新通知），且瀏覽器與 Node 結果相同
  assert.equal(parseRules('2330,<=,900,a').rules[0].id, parseRules('2330,價格<=,900,b').rules[0].id);
  assert.equal(ruleId('abc'), '1a47e90b');
});

test('判斷與邊緣觸發：由不成立變成立才通知；缺資料維持原狀態', () => {
  const [low, drop, ma] = parseRules('2330,價格<=,900\n2330,跌幅>=,3\n2330,跌破MA20').rules;
  assert.equal(evaluate(low, { price: 899 }), true);
  assert.equal(evaluate(low, { price: null }), null);
  assert.equal(evaluate(drop, { chgPct: -3.2 }), true);
  assert.equal(evaluate(drop, { chgPct: 3.2 }), false);
  assert.equal(evaluate(ma, { price: 10, ma20: 11 }), true);
  let snap = { price: 950 };
  const s1 = step([low], () => snap, null, 't1');
  assert.equal(s1.fired.length, 0);
  snap = { price: 890 };
  const s2 = step([low], () => snap, s1.state, 't2');
  assert.equal(s2.fired.length, 1);
  const s3 = step([low], () => ({ price: 880 }), s2.state, 't3');
  assert.equal(s3.fired.length, 0);                                    // 仍成立：不重複通知
  assert.equal(s3.state.rules[low.id].at, 't2');
  const s4 = step([low], () => null, s3.state, 't4');                  // 缺資料：狀態不變
  assert.deepEqual(s4.state.rules, s3.state.rules);
  const s5 = step([low], () => ({ price: 950 }), s4.state, 't5');
  const s6 = step([low], () => ({ price: 899 }), s5.state, 't6');
  assert.equal(s6.fired.length, 1);                                    // 回升後再跌破 → 再通知
  assert.match(describe(s6.fired[0]), /^🔔 2330｜價格 ≤ 900｜現價 899/);
});

/* ───────── 推播腳本（本機假 Discord） ───────── */

function site(dir, { price = 890, rsi = 50 } = {}) {
  mkdirSync(join(dir, 'us'), { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ generatedAt: 'x', bytes: { 'overview.json': 1 } }));
  writeFileSync(join(dir, 'overview.json'), JSON.stringify({ rows: [{ code: '2330', name: '台積電', price, chgPct: -1.2, rsi, ma20: 900 }] }));
  writeFileSync(join(dir, 'macro.json'), JSON.stringify({ items: [{ key: 'keep', label: '擔保維持率', value: 151.78, changePct: -14.5 }] }));
  writeFileSync(join(dir, 'market.json'), JSON.stringify({ cols: ['close', 'change', 'pe'], rows: { 2317: [200, -2, 12] } }));
}

test('alerts.mjs：推播一次、狀態檔不含規則內容、第二次不重複、Secret 不外洩', async () => {
  const got = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { got.push(JSON.parse(b)); res.writeHead(204).end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const hook = `http://127.0.0.1:${server.address().port}/api/webhooks/123/SECRET-HOOK-TOKEN`;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'alerts-'));
    site(dir);
    const env = { ...process.env, ALERT_RULES: '2330,價格<=,900,停損\nMACRO:keep,<=,160\n2317,跌幅>=,0.5\n9999,<=,1\nbad line', DISCORD_WEBHOOK_URL: hook, SITE_URL: 'https://example.github.io/tw/' };
    delete env.TELEGRAM_BOT_TOKEN;
    const r1 = await run(process.execPath, [join(ROOT, 'scripts/alerts.mjs'), dir], { env });
    assert.match(r1.stdout, /4 條規則.*本次觸發 3 條，1 條找不到資料/);
    assert.match(r1.stdout, /::warning title=到價通知規則格式::第 5 行/);
    assert.equal(got.length, 1);
    assert.match(got[0].content, /2330 台積電｜價格 ≤ 900｜現價 890.*停損 https:\/\/example\.github\.io\/tw\/#2330/);
    assert.match(got[0].content, /擔保維持率｜價格 ≤ 160｜現價 151\.78/);
    assert.match(got[0].content, /2317｜今日跌幅 ≥ % 0\.5/);
    const state = readFileSync(join(dir, 'alerts_state.json'), 'utf-8');
    assert.ok(!state.includes('2330') && !state.includes('900') && !state.includes('SECRET'), state);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
    assert.deepEqual([meta.alerts.rules, meta.alerts.invalid, meta.alerts.fired, meta.alerts.channels], [4, 1, 3, ['Discord']]);
    assert.ok(meta.bytes['alerts_state.json'] > 0 && meta.bytes['overview.json'] === 1);
    assert.ok(!JSON.stringify(meta).includes('SECRET'));
    // 第二次：條件仍成立 → 不重複推播
    await run(process.execPath, [join(ROOT, 'scripts/alerts.mjs'), dir], { env });
    assert.equal(got.length, 1);
    // 規則清空 → 拿掉 meta.alerts，網站顯示「尚未啟用」
    await run(process.execPath, [join(ROOT, 'scripts/alerts.mjs'), dir], { env: { ...env, ALERT_RULES: '' } });
    assert.equal(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8')).alerts, undefined);
  } finally {
    server.close();
  }
});

test('alerts.mjs：推播失敗不影響部署（exit 0），下次再試', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alerts-'));
  site(dir);
  const env = { ...process.env, ALERT_RULES: '2330,價格<=,900', DISCORD_WEBHOOK_URL: 'http://127.0.0.1:9/hook' };
  const r = await run(process.execPath, [join(ROOT, 'scripts/alerts.mjs'), dir], { env });
  assert.match(r.stdout, /::warning title=到價通知推播失敗::Discord/);
  assert.ok(!r.stdout.includes('127.0.0.1:9/hook'));                  // 不印出網址
  const state = JSON.parse(readFileSync(join(dir, 'alerts_state.json'), 'utf-8'));
  assert.deepEqual(state.rules, {});                                   // 沒送出 → 不記成已通知
});

/* ───────── 集保千張大戶 ───────── */

test('holderStats：週變化、4 週變化、股東人數；summarize 與總覽列帶出', () => {
  const holders = {
    cols: ['date', 'p1000', 'p400', 'n1000', 'holders'], source: '集保 OpenAPI',
    rows: { 2330: [['2026-10-23', 83.0, 86, 1460, 3400000], ['2026-10-30', 83.2, 86, 1461, 3380000], ['2026-11-06', 83.5, 86, 1462, 3360000],
      ['2026-11-13', 83.9, 86, 1465, 3350000], ['2026-11-20', 84.14, 86.89, 1469, 3329043]] },
  };
  const hs = holderStats(holders, '2330');
  assert.equal(hs.weeks, 5);
  assert.ok(Math.abs(hs.p1000Chg - 0.24) < 1e-9);
  assert.ok(Math.abs(hs.p1000Chg4 - 1.14) < 1e-9);
  assert.ok(Math.abs(hs.holdersChgPct - (3329043 / 3350000 - 1) * 100) < 1e-9);
  assert.equal(holderStats(holders, '2317'), null);
  const one = holderStats({ rows: { 1101: [['2026-11-20', 50, 60, 10, 1000]] } }, '1101');
  assert.equal(one.p1000Chg, null);
  const s = summarize({ info: { code: '2330', name: '台積電', market: 'twse' }, tables: {}, holders });
  assert.equal(s.holders.p1000, 84.14);
  assert.equal(overviewRow(s).big1000, 84.14);
  assert.equal(summarize({ info: { code: '2330', market: 'us' }, tables: {}, holders }).holders, null);
});
