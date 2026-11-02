// 美股開休市（美東時間，夏令 / 冬令）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usMarketStatus, usMarketNotice, etToDate, tpeLabel } from '../../assets/js/market.js';

const tpe = (s) => new Date(`${s}+08:00`);

test('etToDate：冬令 09:30 美東 = 台北 22:30；夏令 = 21:30', () => {
  assert.equal(tpeLabel(etToDate('2026-11-03', 9 * 60 + 30)), '11/03（二） 22:30');
  assert.equal(tpeLabel(etToDate('2026-10-27', 9 * 60 + 30)), '10/27（二） 21:30');
});

test('台北 11/03 23:00（美東 10:00）盤中，台北 05:00 收盤', () => {
  const st = usMarketStatus(tpe('2026-11-03T23:00:00'));
  assert.equal(st.state, 'open');
  assert.match(usMarketNotice(st, '2026-11-02').text, /台北 11\/04（三） 05:00 收盤/);
});

test('感恩節休市，下次開盤跳到週五', () => {
  const st = usMarketStatus(tpe('2026-11-26T23:00:00'));
  assert.equal(st.state, 'closed');
  assert.equal(st.reason, '感恩節');
  assert.equal(tpeLabel(st.nextOpen), '11/27（五） 22:30');
  assert.equal(usMarketNotice(st, null).level, 'warn');
});

test('感恩節隔天提早收盤 13:00', () => {
  const st = usMarketStatus(tpe('2026-11-28T00:30:00'));      // 美東 11/27 11:30
  assert.equal(st.state, 'open');
  assert.match(usMarketNotice(st, null).text, /提早收盤/);
});

test('盤前、盤後、週末', () => {
  assert.equal(usMarketStatus(tpe('2026-11-03T20:00:00')).state, 'pre');     // 美東 07:00
  assert.equal(usMarketStatus(tpe('2026-11-04T06:00:00')).state, 'after');   // 美東 17:00
  assert.equal(usMarketStatus(tpe('2026-11-08T12:00:00')).reason, '週末');
});
