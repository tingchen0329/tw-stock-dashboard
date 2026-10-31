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

import { loadBootstrap, loadStock, loadScreen } from './data.js';
import { buildIndex, search, resolveExact, highlightParts, marketLabel } from './search.js';
import { summarize, marketRow } from './analytics.js';
import { renderFreshness, renderWatchlist, renderMacro, renderStock, renderSetup, h } from './render.js';
import { buildPrompt } from './prompt.js';
import { marketStatus, marketNotice } from './market.js';
import { renderOverview } from './overview.js';
import { renderScreen } from './screen.js';
import { toCSV, toXLSX, download } from './export.js';
import * as F from './format.js';

const $ = (id) => document.getElementById(id);
const state = {
  boot: null,
  index: [],
  byCode: new Map(),
  current: null,      // { code, summary, ctrl, cleanup, range, tables, meta }
  range: '1Y',
};

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
  results = search(state.index, query, 8);
  active = results.length ? 0 : -1;
  if (!query.trim()) { closeResults(); return; }
  list.replaceChildren(...(results.length
    ? results.map(({ item }, i) => {
      const [a, b, c] = highlightParts(item.name, query);
      return h('li', {
        id: `opt-${i}`, role: 'option', 'aria-selected': String(i === active),
        on: { mousedown: (e) => { e.preventDefault(); pick(item.code); }, mousemove: () => setActive(i) },
      },
      h('span', { class: 'code' }, item.code),
      h('span', {}, a, b ? h('mark', {}, b) : null, c, ' ', h('span', { class: 'badge' }, marketLabel(item.market))),
      h('span', { class: 'ind' }, item.industry));
    })
    : [h('li', { class: 'empty', role: 'option', 'aria-disabled': 'true' }, `找不到「${query.trim()}」。可輸入代號（例如 2330）或公司名稱（例如 台積）。`)]));
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
      const exact = resolveExact(state.index, input.value);
      const chosen = active >= 0 && results[active] ? results[active].item : exact;
      if (chosen) pick(chosen.code);
      else if (/^\d{4,6}$/.test(input.value.trim())) pick(input.value.trim());   // 清單外的代號也試著查
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

  const draw = (tables, meta) => {
    if (state.current !== cur) return;     // 已經換股票了，丟棄舊結果
    cur.tables = tables;
    cur.summary = summarize({ info, mkt, quote, tables, asOf });
    if (!info.name && cur.summary.info) cur.summary.info.name = code;
    cur.cleanup?.();
    cur.cleanup = renderStock($('stock'), cur.summary, {
      range: state.range,
      pending: !meta.done,
      errors: meta.errors,
      source: meta.source,
      fetchedAt: meta.fetchedAt,
      onRange: (r) => { state.range = r; draw(cur.tables, meta); },
      onPrompt: openPrompt,
      onCSV: () => exportFile('csv'),
      onXLSX: () => exportFile('xlsx'),
    });
    if (meta.done) {
      performance.mark(`stock:${code}:done`);
      performance.measure(`stock:${code}`, `stock:${code}:start`, `stock:${code}:done`);
    }
  };

  // a. 先用全市場資料立即顯示（不等網路）
  draw({}, { done: false, errors: {}, source: 'market' });
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
  $('stock').replaceChildren(h('p', { class: 'note' }, '載入全市場資料中…'));
  let data = null;
  try { data = await loadScreen(); } catch { /* 顯示「尚未產生」 */ }
  if (state.current !== cur) return;
  renderScreen($('stock'), data, { watchlist: boot.meta.watchlist, onPick: pick });
}

const route = () => {
  const c = decodeURIComponent(location.hash.slice(1));
  if (c === 'overview') showOverview();
  else if (c === 'screen') showScreen();
  else if (c) showStock(c);
};

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
  $('freshness').addEventListener('click', () => {
    const p = $('sources');
    p.hidden = !p.hidden;
    $('freshness').setAttribute('aria-expanded', String(!p.hidden));
  });

  const b = await loadBootstrap();
  state.boot = b;
  if (!b.meta) {
    renderSetup($('stock'), location.protocol === 'file:');
    $('search').disabled = true;
    return;
  }
  renderFreshness($('freshness'), $('sources'), b.meta);
  const notice = marketNotice(marketStatus(new Date(), b.meta.market));   // 休市 / 盤前 / 盤中 / 資料日期
  if (notice) banner(notice.text, notice.level === 'warn' ? 'warn' : 'info');
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
  renderMacro($('macro'), b.macro?.items);

  window.addEventListener('hashchange', route);
  if (location.hash.length > 1) route();
  else if (b.overview?.rows?.length) showOverview();         // 首頁：追蹤清單總覽
  else if (b.meta.watchlist?.[0]) showStock(b.meta.watchlist[0]);
}

boot();
