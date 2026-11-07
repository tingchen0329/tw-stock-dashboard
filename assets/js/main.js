/**
 * 進入點：狀態管理、事件、路由
 *
 * 流程：
 *  1. loadBootstrap() 平行載入 meta / 股票清單 / 全市場行情 / 總經 / 盤中價
 *  2. 搜尋框輸入 → search() → 下拉清單（鍵盤 ↑↓ Enter Esc，符合 ARIA combobox）
 *  3. 選股 → 網址變成 #2330（可分享、可用上一頁）→ hashchange → showStock()
 *  4. showStock()：
 *       a. 立刻用全市場行情畫出價格與估值（0 個額外請求，體感瞬間）
 *       b. 再載入個股詳細資料，回來後重畫
 *       c. 使用者若在途中改查別檔，前一個請求以 AbortController 取消 → 不會出現「資料錯置」
 */

import { loadBootstrap, loadStock, loadScreen, loadUsOverview, loadUsStock, loadUsScreen, loadAiConfig, loadMacroHist } from './data.js';
import { buildIndex, search, resolveExact, highlightParts, marketLabel } from './search.js';
import { summarize, marketRow, usMarketRow, peerStats, insiderStats } from './analytics.js';
import { renderFreshness, renderWatchlist, renderMacro, renderMacroHistory, renderStock, renderSetup, h } from './render.js';
import { buildPrompt } from './prompt.js';
import { marketStatus, marketNotice, usMarketStatus, usMarketNotice } from './market.js';
import { renderOverview } from './overview.js';
import { renderScreen } from './screen.js';
import { renderAiPanel, triggerAi } from './ai.js';
import { toCSV, toXLSX, download } from './export.js';
import * as F from './format.js';

const $ = (id) => document.getElementById(id);
const state = {
  boot: null,
  index: [],
  byCode: new Map(),
  current: null,      // { code, summary, ctrl, cleanup, range, tables, meta }
  range: '1Y',
  peerData: {},
  usIndex: [],        // 美股搜尋索引（追蹤清單 + S&P 500），第一次切到美股時建立
  usActive: '',
  usDay: null,      // 同業比較：{ tw: screen.json, us: us/screen.json }，第一次打開個股頁才下載
  macroRange: '3M',
  aiUrl: null,        // AI 報告代理網址（assets/ai.json）
};

/** 標題旁「台股｜美股」切換：依目前頁面標示 */
function markMarket(us) {
  $('sw-tw')?.setAttribute('aria-current', String(!us));
  $('sw-us')?.setAttribute('aria-current', String(us));
  document.body.classList.toggle('us-mode', us);
  const input = $('search');
  if (input && state.index.length) {
    input.placeholder = us
      ? `美股代號或名稱，例如 NVDA、Apple${state.usIndex.length ? `（${state.usIndex.length.toLocaleString()} 檔）` : ''}`
      : `代號或名稱，例如 2330、台積（${state.index.length.toLocaleString()} 檔）`;
  }
  if (us) ensureUsData();
}

const isUs = () => document.body.classList.contains('us-mode');

/** 個股頁最下方的 AI 報告區塊（每次重畫後補上；分析結果保留在 ai.js 的記憶體中） */
function appendAi(code, dataDay, getPrompt) {
  $('stock').append(renderAiPanel({ url: state.aiUrl, code, dataDay, getPrompt }));
}

/* ───────── 小工具 ───────── */

function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

function banner(text, cls = '') {
  $('banners').append(h('p', { class: `banner ${cls}` }, text));
}

/* ───────── 搜尋框（ARIA combobox）───────── */

let active = -1;
let results = [];

function renderResults(query) {
  const list = $('results');
  results = search(isUs() ? state.usIndex : state.index, query, 8);
  active = results.length ? 0 : -1;
  if (!query.trim()) { closeResults(); return; }
  list.replaceChildren(...(results.length
    ? results.map(({ item }, i) => {
      const [a, b, c] = highlightParts(item.name, query);
      return h('li', {
        id: `opt-${i}`, role: 'option', 'aria-selected': String(i === active),
        on: { mousedown: (e) => { e.preventDefault(); pickAny(item); }, mousemove: () => setActive(i) },
      },
      h('span', { class: 'code' }, item.code),
      h('span', {}, a, b ? h('mark', {}, b) : null, c, ' ', h('span', { class: 'badge' }, marketLabel(item.market))),
      h('span', { class: 'ind' }, item.industry));
    })
    : [h('li', { class: 'empty', role: 'option', 'aria-disabled': 'true' }, isUs()
      ? `找不到「${query.trim()}」。可輸入美股代號（例如 NVDA）或英文公司名稱（例如 Apple），按 Enter 直接開啟代號。`
      : `找不到「${query.trim()}」。可輸入代號（例如 2330）或公司名稱（例如 台積）。`)]));
  list.hidden = false;
  $('search').setAttribute('aria-expanded', 'true');
  $('search').setAttribute('aria-activedescendant', active >= 0 ? `opt-${active}` : '');
}

function setActive(i) {
  if (!results.length) return;
  active = (i + results.length) % results.length;
  [...$('results').children].forEach((li, k) => li.setAttribute('aria-selected', String(k === active)));
  $('search').setAttribute('aria-activedescendant', `opt-${active}`);
  $('results').children[active]?.scrollIntoView({ block: 'nearest' });
}

function closeResults() {
  $('results').hidden = true;
  $('search').setAttribute('aria-expanded', 'false');
  $('search').removeAttribute('aria-activedescendant');
}

function pick(code) {
  closeResults();
  $('search').value = '';
  $('search').blur();
  if (location.hash === `#${code}`) route();
  else location.hash = code;      // 觸發 hashchange → showStock
}

/** 搜尋結果：美股開 #us/代號，台股開 #代號 */
function pickAny(item) {
  if (item.market !== 'us') { pick(item.code); return; }
  closeResults();
  $('search').value = '';
  $('search').blur();
  usPick(item.code);
}

let blurTimer = 0;

function wireSearch() {
  const input = $('search');
  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    clearTimeout(blurTimer);    // 上一次失焦排程的「關閉清單」不可蓋掉這次的結果
    timer = setTimeout(() => renderResults(input.value), 40);   // 輕量防抖：連續輸入只算最後一次
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if ($('results').hidden) renderResults(input.value); else setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Escape') closeResults();
    else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer);
      if ($('results').hidden) renderResults(input.value);
      const exact = resolveExact(isUs() ? state.usIndex : state.index, input.value);
      const chosen = active >= 0 && results[active] ? results[active].item : exact;
      const raw = input.value.trim();
      if (chosen) pickAny(chosen);
      else if (!isUs() && /^\d{4,6}$/.test(raw)) pick(raw);                       // 清單外的代號也試著查
      else if (isUs() && /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(raw)) pickAny({ code: raw.toUpperCase(), market: 'us' });
    }
  });
  // 失焦延遲關閉：讓滑鼠點選結果有時間觸發；重新聚焦時取消
  input.addEventListener('blur', () => { blurTimer = setTimeout(closeResults, 120); });
  input.addEventListener('focus', () => clearTimeout(blurTimer));
  // 「/」快速聚焦搜尋框（在輸入框內打字時不攔截）
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      input.focus();
    }
  });
}

/* ───────── 個股 ───────── */

function stockInfo(code) {
  const it = state.byCode.get(code);
  return it ? { code, name: it.name, market: it.market, industry: it.industry } : { code, name: '', market: '', industry: '' };
}

function markCurrentChip(code) {
  document.querySelectorAll('#watchlist .chip').forEach((c) => c.setAttribute('aria-current', String(c.dataset.code === code)));
}

async function showStock(code) {
  const { boot } = state;
  if (!boot?.meta) return;
  state.current?.ctrl.abort();             // 取消上一檔還在跑的請求
  state.current?.cleanup?.();
  performance.mark(`stock:${code}:start`);

  const info = stockInfo(code);
  const mkt = marketRow(boot.market, code);
  const quote = boot.quotes?.rows?.[code] ?? null;
  const asOf = boot.market?.asOf ?? {};
  const ctrl = new AbortController();
  const cur = { code, ctrl, cleanup: null, tables: {}, summary: null };
  state.current = cur;
  markCurrentChip(code);
  document.title = `${code} ${info.name}｜台股研究台`;
  markMarket(false);

  const draw = (tables, meta) => {
    if (state.current !== cur) return;     // 已經換股票了，丟棄舊結果
    cur.tables = tables;
    cur.summary = summarize({ info, mkt, quote, tables, asOf, bench: state.boot.macro?.bench?.tw });
    cur.summary.peers = state.peerData.tw ? peerStats(state.peerData.tw, code, 'industry') : null;
    cur.lastMeta = meta;
    if (!info.name && cur.summary.info) cur.summary.info.name = code;
    cur.cleanup?.();
    cur.cleanup = renderStock($('stock'), cur.summary, {
      range: state.range,
      pending: !meta.done,
      peersLoading: !state.peerData.tw && !state.peerData.twFailed,
      errors: meta.errors,
      source: meta.source,
      fetchedAt: meta.fetchedAt,
      onRange: (r) => { state.range = r; draw(cur.tables, meta); },
      onPrompt: openPrompt,
      onAi: () => (meta.done ? triggerAi(code) : toast('資料載入中，完成後再產生 AI 報告')),
      onCSV: () => exportFile('csv'),
      onXLSX: () => exportFile('xlsx'),
    });
    if (meta.done) {
      appendAi(code, cur.summary.tech?.date ?? '', () => buildPrompt(cur.summary, boot.meta, boot.macro?.items));
      performance.mark(`stock:${code}:done`);
      performance.measure(`stock:${code}`, `stock:${code}:start`, `stock:${code}:done`);
    }
  };

  // a. 先用全市場資料立即顯示（不等網路）
  draw({}, { done: false, errors: {}, source: 'market' });
  // 同業比較要全市場選股資料（screen.json，約 80 KB 壓縮後）：背景載入，回來後重畫
  if (!state.peerData.tw && !state.peerData.twFailed) {
    loadScreen().then((d) => { state.peerData.tw = d; }, () => { state.peerData.twFailed = true; })
      .then(() => { if (state.current === cur && cur.lastMeta) draw(cur.tables, cur.lastMeta); });
  }
  $('stock').scrollIntoView?.({ block: 'nearest' });

  // b. 再抓個股詳細資料
  try {
    await loadStock(code, {
      meta: boot.meta, spec: boot.spec, signal: ctrl.signal,
      onUpdate: (tables, meta) => draw(tables, meta),
    });
  } catch (e) {
    if (e.name === 'AbortError') return;
    draw(cur.tables, { done: true, errors: { all: String(e.message || e) }, source: 'live' });
  }
}

/* ───────── 追蹤清單總覽 ───────── */

function showOverview() {
  const { boot } = state;
  if (!boot?.meta) return;
  state.current?.ctrl.abort();
  state.current?.cleanup?.();
  state.current = { code: 'overview', ctrl: new AbortController(), cleanup: null, summary: null };
  markCurrentChip('overview');
  document.title = '追蹤清單總覽｜台股研究台';
  markMarket(false);
  renderOverview($('stock'), boot.overview, { onPick: pick });
}

/* ───────── 全市場選股 ───────── */

async function showScreen() {
  const { boot } = state;
  if (!boot?.meta) return;
  state.current?.ctrl.abort();
  state.current?.cleanup?.();
  const cur = { code: 'screen', ctrl: new AbortController(), cleanup: null, summary: null };
  state.current = cur;
  markCurrentChip('screen');
  document.title = '全市場選股｜台股研究台';
  markMarket(false);
  $('stock').replaceChildren(h('p', { class: 'note' }, '載入全市場資料中…'));
  let data = null;
  try { data = await loadScreen(); } catch { /* 顯示「尚未產生」 */ }
  if (state.current !== cur) return;
  renderScreen($('stock'), data, { watchlist: boot.meta.watchlist, onPick: pick });
}

/* ───────── 美股 ───────── */

const usPick = (sym) => { location.hash = `us/${sym}`; };

/**
 * 美股版面（與台股同位置）：頁首橫幅放開休市提示、搜尋框下方放美股追蹤列（總覽 / 選股 / 清單）
 * @param {string} active  目前頁面：'us'、'us-screen' 或代號
 * @param {string|null} dataDay  資料日期（美東）
 */
function usTop(active, dataDay) {
  const n = usMarketNotice(usMarketStatus(new Date()), dataDay ?? state.usDay);
  if (dataDay) state.usDay = dataDay;
  $('banners').querySelector('.us-notice')?.remove();
  const el = h('p', { class: `banner us-notice ${n.level === 'warn' ? 'warn' : 'info'}` }, n.text);
  $('banners').prepend(el);
  state.usActive = active;
  markUsChip();
  return document.createDocumentFragment();          // 呼叫端 prepend 用（已不放進內容區）
}

function markUsChip() {
  document.querySelectorAll('#us-watchlist .chip').forEach((c) => c.setAttribute('aria-current', String(c.dataset.code === state.usActive)));
}

/** 美股追蹤列與搜尋索引：第一次切到美股時載入（追蹤清單 + S&P 500 成分股） */
let usDataPromise = null;
function ensureUsData() {
  if (usDataPromise) return usDataPromise;
  usDataPromise = (async () => {
    const [ov, sc] = await Promise.all([loadUsOverview().catch(() => null), loadUsScreen().catch(() => null)]);
    const rows = new Map();
    for (const r of ov?.rows ?? []) rows.set(r.code, [r.code, r.name || r.code, 'us', r.etf ? 'ETF' : (r.industry || '')]);
    const cols = sc?.cols ?? [];
    for (const r of sc?.rows ?? []) {
      const o = Object.fromEntries(cols.map((c, i) => [c, r[i]]));
      if (!rows.has(o.code)) rows.set(o.code, [o.code, o.name || o.code, 'us', o.sector || '']);
      else if (!rows.get(o.code)[3] || rows.get(o.code)[3] === 'NasdaqGS') rows.get(o.code)[3] = o.sector || '';
    }
    state.usIndex = buildIndex([...rows.values()], state.boot.meta.usWatchlist ?? []);
    if (ov?.dataDay) state.usDay = ov.dataDay;
    const items = (ov?.rows ?? []).map((r) => ({ code: r.code, name: r.name?.replace(/,? (Inc\.|Corporation|Corp\.|Platforms|Holdings)\.?$/i, '') ?? '', price: r.price, changePct: r.chgPct }));
    renderWatchlist($('us-watchlist'), items, usPick);
    $('us-watchlist').firstChild.after(
      h('button', { class: 'chip ov-chip', type: 'button', dataset: { code: 'us' }, on: { click: () => { location.hash = 'us'; } } },
        h('span', { class: 't' }, '總覽'), h('span', { class: 'v' }, `${items.length} 檔`)),
      h('button', { class: 'chip ov-chip', type: 'button', dataset: { code: 'us-screen' }, on: { click: () => { location.hash = 'us-screen'; } } },
        h('span', { class: 't' }, '選股'), h('span', { class: 'v' }, 'S&P 500')));
    markUsChip();
    if (isUs()) markMarket(true);                     // 更新搜尋框提示的檔數
  })();
  return usDataPromise;
}

async function showUsScreen() {
  if (!state.boot?.meta) return;
  state.current?.ctrl.abort();
  state.current?.cleanup?.();
  const cur = { code: 'us-screen', ctrl: new AbortController(), cleanup: null, summary: null };
  state.current = cur;
  markCurrentChip('');
  markMarket(true);
  document.title = '美股選股｜台股研究台';
  $('stock').replaceChildren(h('p', { class: 'note' }, '載入美股選股資料中…'));
  let data = null;
  try { data = await loadUsScreen(); } catch { /* 顯示「尚未產生」 */ }
  if (state.current !== cur) return;
  renderScreen($('stock'), data, { watchlist: state.boot.meta.usWatchlist ?? [], onPick: usPick, market: 'us' });
  $('stock').prepend(usTop('us-screen', data?.asOf?.date));
}

async function showUsOverview() {
  if (!state.boot?.meta) return;
  state.current?.ctrl.abort();
  state.current?.cleanup?.();
  const cur = { code: 'us', ctrl: new AbortController(), cleanup: null, summary: null };
  state.current = cur;
  markCurrentChip('');
  markMarket(true);
  document.title = '美股總覽｜台股研究台';
  $('stock').replaceChildren(h('p', { class: 'note' }, '載入美股資料中…'));
  let data = null;
  try { data = await loadUsOverview(); } catch { /* 顯示「尚未產生」 */ }
  if (state.current !== cur) return;
  renderOverview($('stock'), data, {
    onPick: usPick, title: '美股追蹤清單總覽', hide: ['f20', 't20'], dayNote: '美東收盤',
    note: '資料來源：Yahoo Finance（日線、配息）、美國證管會 SEC EDGAR（財報）。本益比 = 收盤 ÷ 近四季 EPS；河流圖位階 = 目前本益比在近三年的百分位（由財報與股價推算）；營收年增為最新一季與去年同季比較。'
      + 'ETF、外國公司（例如台積電 ADR）沒有 SEC 財報，顯示 N/A。清單在 config/us_watchlist.csv。',
  });
  $('stock').prepend(usTop('us', data?.dataDay));
}

async function showUsStock(sym) {
  if (!state.boot?.meta) return;
  state.current?.ctrl.abort();
  state.current?.cleanup?.();
  const cur = { code: sym, ctrl: new AbortController(), cleanup: null, summary: null, tables: {} };
  state.current = cur;
  markCurrentChip('');
  markMarket(true);
  state.usActive = sym;
  markUsChip();
  document.title = `${sym}｜美股｜台股研究台`;
  $('stock').replaceChildren(h('p', { class: 'note' }, `載入 ${sym}…`));
  let detail;
  try {
    detail = await loadUsStock(sym, cur.ctrl.signal);
  } catch (e) {
    if (e.name === 'AbortError' || state.current !== cur) return;
    const inList = (state.boot.meta.usWatchlist ?? []).includes(sym);
    const ext = (href, label) => h('a', { href, target: '_blank', rel: 'noopener' }, label);
    $('stock').replaceChildren(usTop(sym, null),
      h('p', { class: 'banner warn' }, inList ? `${sym} 的資料尚未產生：下一次 GitHub Actions 更新後就會出現。`
        : `${sym} 不在美股追蹤清單，所以沒有完整個股頁（股價圖、河流圖、財報）。想追蹤的話，把代號加進 config/us_watchlist.csv（可直接用 Yahoo Finance 匯出的 CSV），下次更新就會出現。`),
      h('p', { class: 'ext-links' },
        ext(`https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`, 'Yahoo Finance ↗'), ' · ',
        ext(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}`, 'TradingView ↗'), ' · ',
        ext(`https://finviz.com/quote.ashx?t=${encodeURIComponent(sym)}`, 'Finviz ↗'), ' · ',
        h('a', { href: '#us-screen' }, '← 回美股選股'), ' · ', h('a', { href: '#us' }, '美股總覽')));
    return;
  }
  if (state.current !== cur) return;
  const mkt = usMarketRow(detail);
  const hasFin = (detail.tables?.income?.rows ?? []).length > 0;
  const info = { code: sym, name: detail.name || sym, market: 'us', industry: detail.exchange || '', etf: !hasFin, shares: detail.shares ?? null };
  const draw = () => {
    cur.tables = detail.tables || {};
    cur.summary = summarize({ info, mkt, quote: null, tables: cur.tables, asOf: { twse: mkt?.date }, bench: state.boot.macro?.bench?.us });
    cur.summary.insider = insiderStats(detail.insider);
    cur.summary.peers = state.peerData.us ? peerStats(state.peerData.us, sym, 'sector') : null;
    cur.cleanup?.();
    cur.cleanup = renderStock($('stock'), cur.summary, {
      range: state.range, pending: false, errors: detail.errors, source: 'us', fetchedAt: detail.fetchedAt,
      peersLoading: !state.peerData.us && !state.peerData.usFailed,
      onRange: (r) => { state.range = r; draw(); },
      onPrompt: openPrompt, onCSV: () => exportFile('csv'), onXLSX: () => exportFile('xlsx'),
      onAi: () => triggerAi(`US:${sym}`),
    });
    $('stock').prepend(usTop(sym, mkt?.date));
    appendAi(`US:${sym}`, mkt?.date ?? '', () => buildPrompt(cur.summary, state.boot.meta, state.boot.macro?.items));
  };
  draw();
  if (!state.peerData.us && !state.peerData.usFailed) {
    loadUsScreen().then((d) => { state.peerData.us = d; }, () => { state.peerData.usFailed = true; })
      .then(() => { if (state.current === cur) draw(); });
  }
}

const route = () => {
  const c = decodeURIComponent(location.hash.slice(1));
  if (c === 'us') showUsOverview();
  else if (c === 'us-screen') showUsScreen();
  else if (c.startsWith('us/')) showUsStock(c.slice(3).toUpperCase());
  else if (c === 'overview') showOverview();
  else if (c === 'screen') showScreen();
  else if (c) showStock(c);
};

/* ───────── 總經歷史 ───────── */

async function openMacro(item) {
  const dlg = $('macro-dialog');
  const body = $('macro-body');
  $('macro-title').textContent = `${item.label}｜歷史紀錄`;
  body.replaceChildren(h('p', { class: 'note' }, '載入中…'));
  dlg.showModal();
  let hist = null;
  try { hist = (await loadMacroHist())?.items?.[item.key] ?? null; } catch { /* 顯示「沒有歷史資料」 */ }
  let cleanup = () => {};
  const draw = (range) => {
    cleanup();
    state.macroRange = range;
    cleanup = renderMacroHistory(body, item, hist, { range, onRange: draw });
  };
  draw(state.macroRange || '3M');
  dlg.addEventListener('close', () => cleanup(), { once: true });
}

/* ───────── 分析指令 / 匯出 ───────── */

function openPrompt() {
  const s = state.current?.summary;
  if (!s) return;
  const text = buildPrompt(s, state.boot.meta, state.boot.macro?.items);
  $('prompt-text').value = text;
  $('prompt-dialog').showModal();
  copy(text);
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已複製到剪貼簿');
  } catch {
    // http:// 或舊瀏覽器沒有 Clipboard API：選取文字讓使用者自己 Ctrl+C
    $('prompt-text').select();
    toast('請按 Ctrl+C（⌘+C）複製');
  }
}

const r2 = (x) => (F.isNum(x) ? +x.toFixed(2) : null);

function exportSheets(s) {
  const { info, price: px, valuation: v, tech: t, revenue: rev, inst, fundamentals: f, river: rv } = s;
  const summary = [
    ['項目', '數值', '來源 / 日期'],
    ['代號', info.code, ''], ['名稱', info.name, ''], ['市場', marketLabel(info.market), ''], ['產業', info.industry, ''],
    ['股價', px?.price ?? null, `${px?.source ?? ''} ${px?.asOf ?? ''}`],
    ['漲跌', px?.change ?? null, ''], ['漲跌幅%', px?.changePct ?? null, ''],
    ['本益比', v.pe ?? null, `${v.source ?? ''} ${v.asOf ?? ''}`], ['股價淨值比', v.pb ?? null, ''], ['殖利率%', v.yield ?? null, ''],
    ['外資買賣超(張)', F.isNum(s.instToday?.foreign) ? Math.round(s.instToday.foreign / 1000) : null, s.instToday?.date ?? ''],
    ['投信買賣超(張)', F.isNum(s.instToday?.trust) ? Math.round(s.instToday.trust / 1000) : null, ''],
    ['自營商買賣超(張)', F.isNum(s.instToday?.dealer) ? Math.round(s.instToday.dealer / 1000) : null, ''],
    ['月營收年增%', rev?.latest?.yoy ?? null, rev?.latest?.period ?? ''],
    ['近四季EPS', f?.eps4 ?? null, f?.latestQuarter ?? ''], ['ROE%', f?.roe ?? null, ''], ['負債比%', f?.debtRatio ?? null, f?.balanceDate ?? ''],
    ['MA20', t?.ma?.[20] ?? null, t?.date ?? ''], ['MA60', t?.ma?.[60] ?? null, ''], ['K', t?.k ?? null, ''], ['D', t?.d ?? null, ''], ['RSI14', t?.rsi ?? null, ''],
    ['河流圖區間', rv?.zone ?? null, rv ? `PE ${rv.currentPE.toFixed(2)}` : ''],
  ].map((r) => r.map((c) => (typeof c === 'number' ? (Number.isFinite(c) ? +c.toFixed(4) : null) : c)));
  const ps = s.series;
  const n = ps.close.length;
  const priceRows = [['日期', '開盤', '最高', '最低', '收盤', '成交量(股)', 'MA20', 'MA60']];
  for (let i = Math.max(0, n - 250); i < n; i++) {
    priceRows.push([ps.dates[i], ps.open[i], ps.high[i], ps.low[i], ps.close[i], ps.volume[i],
      r2(t?.maSeries[20][i]), r2(t?.maSeries[60][i])]);
  }
  const revRows = [['月份', '營收(元)', '年增%', '月增%'], ...(rev?.items ?? []).map((x) => [x.period, x.revenue, r2(x.yoy), r2(x.mom)])];
  const instRows = [['日期', '外資(張)', '投信(張)', '自營商(張)', '合計(張)'], ...(inst?.days ?? []).map((d) => [d.date, Math.round(d.foreign / 1000), Math.round(d.trust / 1000), Math.round(d.dealer / 1000), Math.round(d.total / 1000)])];
  const finRows = [['季度', 'EPS', '毛利率%', '營益率%', '淨利率%'], ...(f?.quarters ?? []).map((q) => [q.date, r2(q.eps), r2(q.gross), r2(q.op), r2(q.net)])];
  return [
    { name: '摘要', rows: summary }, { name: '股價', rows: priceRows }, { name: '月營收', rows: revRows },
    { name: '三大法人', rows: instRows }, { name: '財報', rows: finRows },
  ];
}

function exportFile(kind) {
  const s = state.current?.summary;
  if (!s) return;
  const sheets = exportSheets(s);
  const base = `${s.info.code}_${s.info.name || 'stock'}_${F.todayTPE()}`;
  if (kind === 'csv') download(`${base}.csv`, toCSV(sheets), 'text/csv;charset=utf-8');
  else download(`${base}.xlsx`, toXLSX(sheets), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/* ───────── 啟動 ───────── */

async function boot() {
  wireSearch();
  $('prompt-copy').addEventListener('click', () => copy($('prompt-text').value));
  $('prompt-close').addEventListener('click', () => $('prompt-dialog').close());
  $('macro-close').addEventListener('click', () => $('macro-dialog').close());
  $('freshness').addEventListener('click', () => {
    const p = $('sources');
    p.hidden = !p.hidden;
    $('freshness').setAttribute('aria-expanded', String(!p.hidden));
  });

  const [b, aiUrl] = await Promise.all([loadBootstrap(), loadAiConfig()]);
  state.boot = b;
  state.aiUrl = aiUrl;
  if (!b.meta) {
    renderSetup($('stock'), location.protocol === 'file:');
    $('search').disabled = true;
    return;
  }
  renderFreshness($('freshness'), $('sources'), b.meta);
  const notice = marketNotice(marketStatus(new Date(), b.meta.market));   // 休市 / 盤前 / 盤中 / 資料日期
  if (notice) banner(notice.text, `tw-notice ${notice.level === 'warn' ? 'warn' : 'info'}`);
  if (b.meta.demo) banner('目前顯示的是示範資料（合成數字，非真實行情）。部署到 GitHub 並設定 FINMIND_TOKEN 後會換成真實資料。', 'warn');
  if (!b.meta.tokenUsed && !b.meta.demo) banner('FinMind token 尚未設定：追蹤清單以匿名額度抓取，可能缺資料。請在 GitHub Secrets 新增 FINMIND_TOKEN。');

  state.index = buildIndex(b.stocks?.rows ?? [], b.meta.watchlist);
  state.byCode = new Map(state.index.map((it) => [it.code, it]));
  $('search').placeholder = `代號或名稱，例如 2330、台積（${state.index.length.toLocaleString()} 檔）`;

  // 追蹤清單：價格優先用盤中價，其次全市場收盤
  const wl = (b.meta.watchlist || []).map((code) => {
    const q = b.quotes?.rows?.[code];
    const m = marketRow(b.market, code);
    const pctFromMkt = m && F.isNum(m.change) && F.isNum(m.close) && m.close - m.change ? (m.change / (m.close - m.change)) * 100 : null;
    return { code, name: state.byCode.get(code)?.name ?? '', price: q?.value ?? m?.close, changePct: q?.changePct ?? pctFromMkt };
  });
  renderWatchlist($('watchlist'), wl, pick);
  $('watchlist').firstChild.after(h('button', {
    class: 'chip ov-chip', type: 'button', dataset: { code: 'overview' }, on: { click: () => pick('overview') },
  }, h('span', { class: 't' }, '總覽'), h('span', { class: 'v' }, `${wl.length} 檔`)),
  h('button', {
    class: 'chip ov-chip', type: 'button', dataset: { code: 'screen' }, on: { click: () => pick('screen') },
  }, h('span', { class: 't' }, '選股'), h('span', { class: 'v' }, '全市場')));
  renderMacro($('macro'), b.macro?.items, openMacro);

  window.addEventListener('hashchange', route);
  if (location.hash.length > 1) route();
  else if (b.overview?.rows?.length) showOverview();         // 首頁：追蹤清單總覽
  else if (b.meta.watchlist?.[0]) showStock(b.meta.watchlist[0]);
}

boot();
