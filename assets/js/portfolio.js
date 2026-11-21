/**
 * 持股損益（#portfolio）與到價通知規則產生器
 *
 * 持股只存在「這台裝置的這個瀏覽器」（localStorage），不會上傳到任何地方；
 * 換裝置或清除瀏覽器資料前，用「匯出」存一份 JSON，之後再「匯入」。
 *
 * 價格（呼叫端 priceOf 提供）：台股追蹤清單用總覽（盤中約延遲 20 分），其他台股用全市場收盤；
 * 美股用美股總覽或 S&P 500 選股資料（收盤）。美股市值用總經列的美元/台幣換算成台幣合計。
 *
 * 到價通知：這頁只「產生規則文字」，貼到 GitHub Secret ALERT_RULES；
 * GitHub Actions 每次更新資料後由 scripts/alerts.mjs 檢查，條件成立時推播到 Discord / Telegram。
 * 規則放在 Secret（不公開），網站上只會顯示規則「條數」。
 */
import * as F from './format.js';
import { h } from './render.js';
import { download } from './export.js';
import { CONDITIONS, parseRules } from './alert_rules.js';

const KEY = 'tw-stock:portfolio:v1';
const { isNum } = F;

const valid = (x) => x && (x.mkt === 'tw' || x.mkt === 'us') && typeof x.code === 'string' && /^[0-9A-Z.\-]{1,10}$/.test(x.code)
  && isNum(x.shares) && x.shares > 0 && isNum(x.cost) && x.cost >= 0;

/** 正規化一筆持股；不合法回傳 null */
export function normHolding(x) {
  if (!x) return null;
  const mkt = String(x.mkt ?? x.market ?? '').toLowerCase().includes('us') || String(x.mkt ?? '').includes('美') ? 'us' : 'tw';
  let code = String(x.code ?? '').trim().toUpperCase().replace(/^US:/, '');
  const m = /^[A-Z]/.test(code) && !/^\d/.test(code) ? 'us' : mkt;
  code = code.replace(/\.(TW|TWO)$/, '');
  const y = { mkt: m, code, shares: Number(x.shares), cost: Number(x.cost) };
  if (x.note) y.note = String(x.note).slice(0, 40);
  return valid(y) ? y : null;
}

/** localStorage 讀寫（無痕模式 / 停用儲存時會丟例外 → 當作沒有資料，仍可在本頁暫時使用） */
export function loadHoldings(store = globalThis.localStorage) {
  try {
    const x = JSON.parse(store?.getItem(KEY) || '[]');
    return Array.isArray(x) ? x.map(normHolding).filter(Boolean) : [];
  } catch { return []; }
}
function saveHoldings(list, store = globalThis.localStorage) {
  try { store.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
}

/**
 * 匯入：JSON 陣列（本頁匯出的格式）或 CSV「市場,代號,股數,成本[,備註]」（市場可寫 台股 / 美股 / tw / us，第一列可以是標題）
 * @returns {{items:object[], skipped:number}}
 */
export function parseHoldings(text) {
  const t = String(text || '').replace(/^﻿/, '').trim();
  if (!t) return { items: [], skipped: 0 };
  let raw = [];
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      raw = Array.isArray(j) ? j : Array.isArray(j.holdings) ? j.holdings : [];
    } catch { return { items: [], skipped: 1 }; }
  } else {
    raw = t.split(/\r?\n/).map((line) => line.split(',').map((c) => c.trim()))
      .filter((c) => c.length >= 4 && !/^(市場|market)$/i.test(c[0]))
      .map(([mkt, code, shares, cost, note]) => ({ mkt, code, shares: Number(shares.replace(/_/g, '')), cost: Number(cost), note }));
  }
  const items = raw.map(normHolding);
  return { items: items.filter(Boolean), skipped: items.filter((x) => !x).length };
}

/** 同市場同代號合併：股數相加、成本加權平均 */
export function mergeHolding(list, x) {
  const i = list.findIndex((y) => y.mkt === x.mkt && y.code === x.code);
  if (i < 0) return [...list, x];
  const out = [...list];
  out[i] = { ...x };
  return out;
}

/**
 * 持股 + 價格 → 每列損益與合計（純計算）
 * @param {object[]} holdings
 * @param {(x)=>({price, chgPct, name, kind}|null)} priceOf
 * @param {number|null} fx  美元/台幣
 */
export function valuate(holdings, priceOf, fx) {
  const rows = holdings.map((x) => {
    const p = priceOf(x) || {};
    const price = isNum(p.price) && p.price > 0 ? p.price : null;
    const value = price !== null ? price * x.shares : null;
    const costV = x.cost * x.shares;
    const pnl = value !== null ? value - costV : null;
    const day = value !== null && isNum(p.chgPct) && p.chgPct > -100 ? value - value / (1 + p.chgPct / 100) : null;
    const toTwd = (v) => (!isNum(v) ? null : x.mkt === 'us' ? (isNum(fx) ? v * fx : null) : v);
    return {
      ...x, name: p.name || '', price, chgPct: isNum(p.chgPct) ? p.chgPct : null, kind: p.kind || null,
      value, costV, pnl, ret: pnl !== null && costV > 0 ? (pnl / costV) * 100 : null, day,
      valueTwd: toTwd(value), costTwd: toTwd(costV), pnlTwd: toTwd(pnl), dayTwd: toTwd(day),
    };
  });
  const ok = rows.filter((r) => isNum(r.valueTwd));
  const sum = (k) => ok.reduce((s, r) => s + (isNum(r[k]) ? r[k] : 0), 0);
  const value = sum('valueTwd');
  const cost = sum('costTwd');
  for (const r of rows) r.weight = isNum(r.valueTwd) && value > 0 ? (r.valueTwd / value) * 100 : null;
  const dayBase = value - sum('dayTwd');
  return {
    rows,
    total: {
      value, cost, pnl: value - cost, ret: cost > 0 ? ((value - cost) / cost) * 100 : null,
      day: sum('dayTwd'), dayPct: dayBase > 0 ? (sum('dayTwd') / dayBase) * 100 : null,
      counted: ok.length, missing: rows.length - ok.length,
      noFx: rows.some((r) => r.mkt === 'us') && !isNum(fx),
    },
  };
}

/** 依持股成本產生停損 / 停利規則（預設 −10% / +20%） */
export function stopRules(holdings, { stop = -10, take = 20 } = {}) {
  const r2 = (v) => Math.round(v * 100) / 100;
  return holdings.filter((x) => x.cost > 0).flatMap((x) => {
    const code = x.mkt === 'us' ? `US:${x.code}` : x.code;
    return [`${code},價格<=,${r2(x.cost * (1 + stop / 100))},停損 ${stop}%（成本 ${r2(x.cost)}）`,
      `${code},價格>=,${r2(x.cost * (1 + take / 100))},停利 +${take}%（成本 ${r2(x.cost)}）`];
  });
}

/* ───────── 畫面 ───────── */

const money = (v, mkt = 'tw') => (!isNum(v) ? 'N/A' : mkt === 'us' ? `$${F.num(v, 2)}` : F.num(v, 0));
const signedSpan = (text, v) => h('span', { class: `num ${F.dir(v)}` }, text);

/**
 * @param {HTMLElement} host
 * @param {object} ctx { priceOf, fx, fxDay, meta, onPick(mkt, code), store? }
 */
export function renderPortfolio(host, ctx) {
  const store = ctx.store ?? globalThis.localStorage;
  let list = loadHoldings(store);
  let persisted = true;
  const ruleBox = h('textarea', { class: 'rule-box', rows: 6, spellcheck: 'false', 'aria-label': '到價通知規則（貼到 GitHub Secret ALERT_RULES）', placeholder: '# 代號,條件,數值,備註\n2330,價格<=,900,停損\nMACRO:keep,<=,160,擔保維持率偏低' });
  const body = h('div');
  const msg = h('p', { class: 'note', role: 'status' });

  const set = (next, text) => {
    list = next;
    persisted = saveHoldings(list, store);
    msg.textContent = persisted ? (text || '') : '這個瀏覽器不允許儲存（例如無痕模式），關閉分頁後持股會消失；請用「匯出」備份。';
    draw();
  };

  /* 新增 / 更新表單 */
  const fMkt = h('select', { 'aria-label': '市場' }, h('option', { value: 'tw' }, '台股'), h('option', { value: 'us' }, '美股'));
  const fCode = h('input', { type: 'text', placeholder: '代號 2330 / NVDA', 'aria-label': '代號', autocomplete: 'off', size: 12 });
  const fShares = h('input', { type: 'number', min: '0', step: 'any', placeholder: '股數', 'aria-label': '股數（台股 1 張 = 1,000 股）', inputmode: 'decimal' });
  const fCost = h('input', { type: 'number', min: '0', step: 'any', placeholder: '成本（每股）', 'aria-label': '平均成本（每股）', inputmode: 'decimal' });
  const form = h('form', {
    class: 'pf-form',
    on: {
      submit: (e) => {
        e.preventDefault();
        const x = normHolding({ mkt: fMkt.value, code: fCode.value, shares: Number(fShares.value), cost: Number(fCost.value) });
        if (!x) { msg.textContent = '請輸入代號、股數（大於 0）與平均成本。'; return; }
        set(mergeHolding(list, x), `已儲存 ${x.code}（${F.num(x.shares, 0)} 股，成本 ${F.num(x.cost, 2)}）`);
        fCode.value = ''; fShares.value = ''; fCost.value = '';
        fCode.focus();
      },
    },
  }, fMkt, fCode, fShares, fCost, h('button', { type: 'submit', class: 'btn' }, '新增 / 更新'));

  /* 匯出 / 匯入 / 清除 */
  const fileIn = h('input', {
    type: 'file', accept: '.json,.csv,text/csv,application/json', hidden: true,
    on: {
      change: async () => {
        const f = fileIn.files?.[0];
        if (!f) return;
        const { items, skipped } = parseHoldings(await f.text());
        fileIn.value = '';
        if (!items.length) { msg.textContent = '檔案裡沒有可匯入的持股（格式：本頁匯出的 JSON，或 CSV「市場,代號,股數,成本」）。'; return; }
        set(items.reduce(mergeHolding, list), `已匯入 ${items.length} 筆${skipped ? `，略過 ${skipped} 筆格式不符` : ''}`);
      },
    },
  });
  let clearArmed = false;
  const clearBtn = h('button', {
    type: 'button', class: 'btn ghost',
    on: {
      click: () => {
        if (!list.length) return;
        if (!clearArmed) { clearArmed = true; clearBtn.textContent = '再按一次確認清除'; setTimeout(() => { clearArmed = false; clearBtn.textContent = '清除全部'; }, 4000); return; }
        clearArmed = false; clearBtn.textContent = '清除全部';
        set([], '已清除全部持股');
      },
    },
  }, '清除全部');
  const tools = h('div', { class: 'pf-tools' },
    h('button', { type: 'button', class: 'btn ghost', on: { click: () => download(`持股_${F.todayTPE()}.json`, JSON.stringify(list, null, 2), 'application/json') } }, '匯出備份'),
    h('button', { type: 'button', class: 'btn ghost', on: { click: () => fileIn.click() } }, '匯入'),
    clearBtn, fileIn);

  function draw() {
    const v = valuate(list, ctx.priceOf, ctx.fx);
    const t = v.total;
    const tiles = h('div', { class: 'tiles pf-tiles' },
      tile('總市值（台幣）', money(t.value), t.noFx ? '美股缺匯率，未計入' : t.missing ? `${t.missing} 檔缺價格，未計入` : `共 ${t.counted} 檔`),
      tile('未實現損益', signedSpan(F.signed(t.pnl, 0), t.pnl), `報酬率 ${F.pct(t.ret, 2, true)}（未扣賣出手續費與證交稅）`),
      tile('今日損益', signedSpan(F.signed(t.day, 0), t.day), F.pct(t.dayPct, 2, true)),
      tile('美元/台幣', isNum(ctx.fx) ? F.num(ctx.fx, 3) : 'N/A', ctx.fxDay ? `匯率日期 ${ctx.fxDay}` : '總經列匯率'));
    const table = list.length ? h('div', { class: 'ov-wrap' }, h('table', { class: 'ov pf-table' },
      h('thead', {}, h('tr', {}, ['股票', '股數', '成本', '現價', '今日', '市值', '損益', '報酬率', '占比', ''].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, v.rows.map((r) => h('tr', {},
        h('td', {}, h('button', { type: 'button', class: 'link', on: { click: () => ctx.onPick?.(r.mkt, r.code) } }, h('b', {}, r.code), ' ', h('span', { class: 'name' }, r.name || (r.mkt === 'us' ? '美股' : ''))),
          r.note ? h('span', { class: 'muted sub' }, r.note) : null),
        h('td', { class: 'num' }, F.num(r.shares, r.shares % 1 ? 2 : 0)),
        h('td', { class: 'num' }, F.num(r.cost, 2)),
        h('td', { class: 'num' }, r.price === null ? h('span', { class: 'muted' }, 'N/A') : [F.price(r.price), r.kind === '盤中' ? h('span', { class: 'tag' }, '盤中') : null]),
        h('td', { class: 'num' }, isNum(r.chgPct) ? signedSpan(F.pct(r.chgPct, 2, true), r.chgPct) : h('span', { class: 'muted' }, 'N/A')),
        h('td', { class: 'num' }, money(r.value, r.mkt)),
        h('td', { class: 'num' }, isNum(r.pnl) ? signedSpan(r.mkt === 'us' ? `${r.pnl < 0 ? '-' : '+'}$${F.num(Math.abs(r.pnl), 2)}` : F.signed(r.pnl, 0), r.pnl) : 'N/A'),
        h('td', { class: 'num' }, isNum(r.ret) ? signedSpan(F.pct(r.ret, 2, true), r.ret) : 'N/A'),
        h('td', { class: 'num' }, F.pct(r.weight, 1)),
        h('td', {}, h('button', { type: 'button', class: 'btn ghost small', 'aria-label': `刪除 ${r.code}`, on: { click: () => set(list.filter((y) => !(y.mkt === r.mkt && y.code === r.code)), `已刪除 ${r.code}`) } }, '刪除')),
      ))))) : h('p', { class: 'note' }, '還沒有持股。在上方輸入代號、股數與平均成本後按「新增 / 更新」；也可以匯入 CSV「市場,代號,股數,成本」。');
    body.replaceChildren(tiles, table);
  }

  /* 到價通知 */
  const al = ctx.meta?.alerts;
  const status = !al ? '尚未啟用：還沒設定 ALERT_RULES 或推播管道（Discord / Telegram）。'
    : `目前有 ${al.rules} 條規則${al.invalid ? `（${al.invalid} 條格式錯誤被略過）` : ''}；推播：${al.channels?.length ? al.channels.join('、') : '未設定（只記錄不推播）'}${al.lastSent ? `；最近一次推播 ${F.when(al.lastSent)}` : ''}${al.checkedAt ? `；最後檢查 ${F.when(al.checkedAt)}` : ''}。`;
  const rCode = h('input', { type: 'text', placeholder: '代號，例如 2330、US:NVDA、MACRO:keep', 'aria-label': '規則代號', size: 18 });
  const rCond = h('select', { 'aria-label': '條件' }, CONDITIONS.map((c) => h('option', { value: c.key }, c.label)));
  const rVal = h('input', { type: 'number', step: 'any', placeholder: '數值', 'aria-label': '數值', inputmode: 'decimal' });
  const rNote = h('input', { type: 'text', placeholder: '備註（可空白）', 'aria-label': '備註', size: 14 });
  const check = h('p', { class: 'note', role: 'status' });
  const validate = () => {
    const { rules, errors } = parseRules(ruleBox.value);
    check.textContent = !ruleBox.value.trim() ? '' : errors.length
      ? `⚠ ${errors.length} 行格式錯誤：${errors.slice(0, 3).map((e) => `第 ${e.line} 行 ${e.msg}`).join('；')}`
      : `✓ ${rules.length} 條規則格式正確`;
  };
  ruleBox.addEventListener('input', validate);
  const addLine = (line) => { ruleBox.value = `${ruleBox.value.replace(/\s*$/, '')}${ruleBox.value.trim() ? '\n' : ''}${line}`; validate(); };
  const ruleForm = h('form', {
    class: 'pf-form',
    on: {
      submit: (e) => {
        e.preventDefault();
        const c = CONDITIONS.find((x) => x.key === rCond.value);
        const code = rCode.value.trim().toUpperCase().replace(/^MACRO:/, 'MACRO:');
        if (!code) { check.textContent = '請輸入代號'; return; }
        if (c.value && (rVal.value === '' || !isNum(Number(rVal.value)))) { check.textContent = `「${c.label}」需要數值`; return; }
        addLine([code.startsWith('MACRO:') ? `MACRO:${code.slice(6).toLowerCase()}` : code, c.key, c.value ? rVal.value : '', rNote.value.replace(/,/g, '，')].join(','));
      },
    },
  }, rCode, rCond, rVal, rNote, h('button', { type: 'submit', class: 'btn' }, '加入規則'));
  const ruleTools = h('div', { class: 'pf-tools' },
    h('button', { type: 'button', class: 'btn ghost', on: { click: () => { const r = stopRules(list); if (r.length) r.forEach(addLine); else check.textContent = '先在上方新增持股，才能依成本產生停損 / 停利。'; } } }, '依持股成本產生停損 −10% / 停利 +20%'),
    h('button', {
      type: 'button', class: 'btn ghost',
      on: { click: async () => { try { await navigator.clipboard.writeText(ruleBox.value); check.textContent = '已複製，貼到 GitHub Secret ALERT_RULES'; } catch { ruleBox.select(); check.textContent = '請按 Ctrl+C（⌘C）複製'; } } },
    }, '複製規則'));

  host.replaceChildren(h('section', { class: 'portfolio' },
    h('h2', {}, '持股損益'),
    h('p', { class: 'note' }, '持股只存在這台裝置的瀏覽器，不會上傳；換裝置前請先「匯出備份」。現價：台股追蹤清單為盤中價（約延遲 20 分）、其他為最近收盤；美股為最近收盤。'),
    form, msg, tools, body,
    h('section', { class: 'panel pf-alerts' },
      h('h3', {}, '到價通知（推播到手機）'),
      h('p', { class: 'note' }, status),
      h('p', { class: 'note' }, 'GitHub Actions 每次更新資料（盤中約每 30 分鐘、收盤後、夜間）都會檢查一次；條件「由不成立變成成立」時推播一次，不會每次重複。LINE Notify 已於 2025-03-31 停止服務，所以改用 Discord 或 Telegram。'),
      ruleForm, ruleBox, check, ruleTools,
      h('details', {}, h('summary', {}, '設定步驟與規則格式'),
        h('ol', {},
          h('li', {}, '推播管道（擇一或都設）：Discord 頻道設定 → 整合 → Webhook → 複製網址，存成 GitHub Secret「DISCORD_WEBHOOK_URL」；或 Telegram 找 @BotFather 建立機器人，把 token 存成「TELEGRAM_BOT_TOKEN」、你的 chat id 存成「TELEGRAM_CHAT_ID」。'),
          h('li', {}, '把上面的規則複製，存成 GitHub Secret「ALERT_RULES」（Settings → Secrets and variables → Actions → New repository secret）。Secret 不公開，網站上只顯示條數。'),
          h('li', {}, '下次資料更新就會生效；這頁上方的狀態會顯示規則條數與推播管道。')),
        h('p', { class: 'note' }, '格式：一行一條「代號,條件,數值,備註」。代號：台股 2330、美股 US:NVDA（或直接 NVDA）、總經 MACRO:keep（擔保維持率）、MACRO:taiex、MACRO:vix… 條件：'
          + CONDITIONS.map((c) => `${c.key}（${c.label}）`).join('、') + '。# 開頭為註解。'))),
  ));
  draw();
  const cleanup = () => {};
  cleanup.refresh = draw;                 // 美股價格晚到時重算表格
  return cleanup;
}

function tile(label, value, sub) {
  return h('div', { class: 'tile' }, h('div', { class: 'l' }, label), h('div', { class: 'v num' }, value), h('div', { class: 's' }, sub || ''));
}
