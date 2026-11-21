#!/usr/bin/env node
/**
 * 到價通知：GitHub Actions 在 build_overview.mjs 之後執行，條件成立時推播到 Discord / Telegram
 *
 *   node scripts/alerts.mjs <資料夾>            例：node scripts/alerts.mjs _site/data
 *   node scripts/alerts.mjs <資料夾> --dry-run  只顯示會觸發的規則，不推播、不寫檔
 *
 * 環境變數（都放 GitHub Secrets；沒設定就略過，不會讓部署失敗）：
 *   ALERT_RULES          規則（一行一條「代號,條件,數值,備註」，格式見 assets/js/alert_rules.js）
 *                        沒有時改讀 config/alerts.csv（注意：repo 是公開的，檔案裡的價位大家都看得到）
 *   DISCORD_WEBHOOK_URL  Discord 頻道 Webhook 網址
 *   TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID
 *   SITE_URL             網站網址（訊息附個股連結）
 *
 * 狀態檔 alerts_state.json 只存「規則 id（雜湊）→ 是否成立」，不含代號與價位；跟著網站部署，下次執行時取回。
 * 同一條規則要「由不成立變成成立」才會再通知，不會每次更新都重複推播。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRules, step, describe } from '../assets/js/alert_rules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2] || '_site/data';
const dry = process.argv.includes('--dry-run');
const env = process.env;

const readJSON = async (p) => { try { return JSON.parse(await readFile(join(dir, p), 'utf-8')); } catch { return null; } };
const table = (t) => {
  const m = new Map();
  for (const r of t?.rows ?? []) m.set(r.code, r);
  return m;
};
const zip = (cols, r) => Object.fromEntries((cols || []).map((c, i) => [c, r[i]]));

/** 推播：失敗只印狀態碼，不印網址或 token */
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
function chunks(lines, max) {
  const out = [];
  let cur = '';
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > max) { out.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + l.slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}
export const CHANNELS = {
  Discord: { ok: () => !!env.DISCORD_WEBHOOK_URL, send: (text) => post(env.DISCORD_WEBHOOK_URL, { content: text, username: '台股研究台', allowed_mentions: { parse: [] } }), max: 1900 },
  Telegram: {
    ok: () => !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),
    send: (text) => post(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    max: 4000,
  },
};

async function main() {
  let text = env.ALERT_RULES || '';
  let from = 'Secret ALERT_RULES';
  if (!text.trim() && existsSync(join(ROOT, 'config/alerts.csv'))) { text = await readFile(join(ROOT, 'config/alerts.csv'), 'utf-8'); from = 'config/alerts.csv'; }
  const { rules, errors } = parseRules(text);
  const channels = Object.entries(CHANNELS).filter(([, c]) => c.ok()).map(([k]) => k);
  const meta = await readJSON('meta.json');
  if (!meta) { console.log('到價通知：沒有 meta.json，略過'); return; }
  const prevState = await readJSON('alerts_state.json');
  const now = new Date().toISOString();

  if (!rules.length) {
    console.log(`到價通知：沒有規則（${errors.length ? `${errors.length} 行格式錯誤` : '未設定 ALERT_RULES'}），略過`);
    for (const e of errors) console.log(`::warning title=到價通知規則格式::第 ${e.line} 行 ${e.msg}`);
    if (meta.alerts) { delete meta.alerts; if (!dry) await writeFile(join(dir, 'meta.json'), JSON.stringify(meta)); }
    return;
  }

  // 最新數據：台股追蹤清單（總覽，含盤中價、RSI、MA20、千張大戶）→ 其他台股（全市場收盤）；美股總覽 → S&P 500；總經
  const [ov, usOv, market, macro, stocks, usScreen] = await Promise.all(['overview.json', 'us/overview.json', 'market.json', 'macro.json', 'stocks.json', 'us/screen.json'].map(readJSON));
  const tw = table(ov);
  const us = table(usOv);
  const names = new Map((stocks?.rows ?? []).map((r) => [r[0], r[1]]));
  const usSc = new Map((usScreen?.rows ?? []).map((r) => { const o = zip(usScreen.cols, r); return [o.code, o]; }));
  const mac = new Map((macro?.items ?? []).map((m) => [m.key, m]));
  const snapOf = (r) => {
    if (r.kind === 'macro') {
      const m = mac.get(r.code);
      return m && { name: m.label, price: m.value, chgPct: m.changePct, when: m.day || m.time };
    }
    if (r.kind === 'us') {
      const o = us.get(r.code);
      if (o) return { name: o.name, price: o.price, chgPct: o.chgPct, rsi: o.rsi, pe: o.pe, ma20: o.ma20 };
      const s = usSc.get(r.code);
      return s && { name: s.name, price: s.close, chgPct: s.chgPct, pe: s.pe };
    }
    const o = tw.get(r.code);
    if (o) return { name: o.name, price: o.price, chgPct: o.chgPct, rsi: o.rsi, pe: o.pe, ma20: o.ma20, big1000Chg: o.big1000Chg };
    const row = market?.rows?.[r.code];
    if (!row) return null;
    const x = zip(market.cols, row);
    const prev = typeof x.close === 'number' && typeof x.change === 'number' ? x.close - x.change : null;
    return { name: names.get(r.code) || '', price: x.close, chgPct: prev ? (x.change / prev) * 100 : null, pe: x.pe > 0 ? x.pe : null };
  };

  const { fired, state } = step(rules, snapOf, prevState, now);
  const missing = rules.filter((r) => !snapOf(r)).length;
  const site = (env.SITE_URL || '').replace(/\/?$/, '/');
  const lines = fired.map((f) => {
    const link = site.length > 1 && f.rule.kind !== 'macro' ? ` ${site}#${f.rule.kind === 'us' ? `us/${f.rule.code}` : f.rule.code}` : '';
    return describe(f) + link;
  });
  console.log(`到價通知：${rules.length} 條規則（來自 ${from}），本次觸發 ${fired.length} 條${missing ? `，${missing} 條找不到資料` : ''}；推播管道：${channels.join('、') || '未設定'}`);
  for (const e of errors) console.log(`::warning title=到價通知規則格式::第 ${e.line} 行 ${e.msg}`);
  if (dry) { lines.forEach((l) => console.log('  ' + l)); return; }

  let sent = null;
  if (lines.length && channels.length) {
    const head = `台股研究台到價通知（${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })}）`;
    for (const name of channels) {
      try {
        for (const part of chunks([head, ...lines], CHANNELS[name].max)) await CHANNELS[name].send(part);
        sent = now;
        console.log(`  已推播到 ${name}：${lines.length} 條`);
      } catch (e) {
        console.log(`::warning title=到價通知推播失敗::${name}：${String(e.message || e).slice(0, 80)}（請檢查 Secret 是否正確）`);
      }
    }
  } else if (lines.length) {
    console.log('::notice title=到價通知::有規則成立但沒有設定推播管道（DISCORD_WEBHOOK_URL 或 TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID）');
  }

  // 規則成立但沒有推播成功：狀態不要記成「已通知」，下次再試
  if (lines.length && channels.length && !sent) for (const f of fired) delete state.rules[f.rule.id];
  const lastSent = sent || prevState?.lastSent || null;
  const body = JSON.stringify({ checkedAt: now, lastSent, ...state });
  for (const secret of [env.DISCORD_WEBHOOK_URL, env.TELEGRAM_BOT_TOKEN, env.ALERT_RULES].filter((s) => s && s.length > 8)) {
    if (body.includes(secret)) throw new Error('狀態檔含有 Secret 內容，停止寫出');
  }
  await writeFile(join(dir, 'alerts_state.json'), body);
  meta.bytes = { ...(meta.bytes || {}), 'alerts_state.json': Buffer.byteLength(body) };
  meta.alerts = {
    rules: rules.length, invalid: errors.length, missing, channels, checkedAt: now, fired: fired.length,
    lastSent,
  };
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
}

main().catch((e) => {
  // 通知失敗不可以讓整個部署失敗
  console.log(`::warning title=到價通知::${String(e.message || e).slice(0, 200)}`);
});
