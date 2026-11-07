/**
 * 畫面渲染（只負責「資料 → DOM」，不抓資料、不保存狀態）
 *
 * 安全：全部用 h() 建立節點、textContent 寫入文字。
 *       股票名稱、產業別都來自外部 API，絕不經過 innerHTML（舊版有 XSS 風險）。
 */

import * as F from './format.js';
import { completeness, INSIDER_CODES } from './analytics.js';
import { lineChart, barChart, tableView } from './charts.js';
import { marketLabel } from './search.js';

/** 建立元素：h('div', {class:'x', on:{click}}, '文字', 子節點...) */
export function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

/** 帶方向色的數字 */
const signedSpan = (text, value) => h('span', { class: `num ${F.dir(value)}` }, text);

/* ───────── 頁首：資料新鮮度 ───────── */

export function renderFreshness(btn, panel, meta) {
  const src = Object.entries(meta.sources || {});
  const ok = src.filter(([, s]) => s.ok).length;
  const level = ok === src.length ? 'ok' : ok >= src.length * 0.6 ? 'warn' : 'bad';
  btn.replaceChildren(
    h('span', { class: `dot ${level}`, 'aria-hidden': 'true' }),
    `資料更新 ${F.when(meta.generatedAt)}`,
    // 夜間只更新總經時，另外標示總經的時間
    meta.macroAt && meta.macroAt !== meta.generatedAt ? `；總經 ${F.when(meta.macroAt)}` : '',
    `，${ok}/${src.length} 個來源正常`,
  );
  btn.setAttribute('aria-label', `資料更新於 ${meta.generatedAt}，${ok} 個來源正常，共 ${src.length} 個。按此查看各來源狀態`);
  panel.replaceChildren(h('table', {},
    h('tbody', {}, src.map(([name, s]) => h('tr', {},
      h('td', {}, s.ok ? '正常' : '失敗'),
      h('td', {}, name),
      h('td', { class: 'num' }, `${s.rows} 筆`),
      h('td', { class: 'muted' }, s.note || ''),
    )))));
}

/* ───────── 追蹤清單 / 總經 ───────── */

export function renderWatchlist(host, items, onPick) {
  host.replaceChildren(
    h('span', { class: 'strip-label' }, '追蹤'),
    ...items.map((it) => h('button', { class: 'chip', type: 'button', dataset: { code: it.code }, on: { click: () => onPick(it.code) } },
      h('span', { class: 't' }, `${it.code} ${it.name}`),
      h('span', { class: 'v' }, F.price(it.price)),
      h('span', { class: `d ${F.dir(it.changePct)}` }, F.isNum(it.changePct) ? `${it.changePct > 0 ? '▲' : it.changePct < 0 ? '▼' : ''} ${F.pct(it.changePct, 2, true)}` : '—'),
    )),
  );
}

/** 總經數值的顯示格式（卡片與歷史視窗共用） */
export function macroFmt(key, v) {
  if (key === 'fed' || key === 'us10y') return F.pct(v, 2);
  if (key === 'usdtwd') return F.num(v, 3);
  return F.num(v, Math.abs(v) > 1000 ? 0 : 2);
}

/**
 * 總經列：每張卡片顯示「最後價格、漲跌 %、資料日期」，點擊開啟歷史紀錄（onOpen(item)）
 */
export function renderMacro(host, items, onOpen) {
  if (!items?.length) { host.replaceChildren(); return; }
  host.replaceChildren(
    h('span', { class: 'strip-label' }, '總經'),
    h('div', { class: 'chips' }, ...items.map((m) => h('button', {
      type: 'button', class: 'chip', 'data-key': m.key,
      title: `${m.source}，${F.when(m.time)}｜點擊查看歷史紀錄`,
      'aria-label': `${m.label} ${macroFmt(m.key, m.value)}，查看歷史紀錄`,
      on: { click: () => onOpen?.(m) },
    },
      h('span', { class: 't' }, m.label),
      h('span', { class: 'v' }, macroFmt(m.key, m.value)),
      h('span', { class: `d ${m.key === 'fed' ? 'flat' : F.dir(m.changePct)}` },
        m.key === 'fed' ? `自 ${F.when(m.time)}` : F.isNum(m.changePct) ? `${m.changePct >= 0.005 ? '▲' : m.changePct <= -0.005 ? '▼' : ''} ${F.pct(m.changePct, 2, true)}` : '—',
        // 資料日期：夜盤顯示報價時間（盤中為時:分）；其他顯示收盤日（美股用美國日期）
        m.key === 'fed' ? null : h('span', { class: 'when' }, macroDay(m))),
    ))),
  );
}

/** 卡片上的日期：日線收盤顯示 MM/DD；台指期夜盤顯示 MM/DD HH:MM */
function macroDay(m) {
  if (m.key === 'txf_night') return F.when(m.time);
  return m.day ? F.when(m.day) : F.when(String(m.time || '').slice(0, 10));
}

/** 美股收盤在台北隔天凌晨：顯示「10/19（台北 10/20 05:00）」，避免以為是 10/20 的收盤 */
function lastWhen(item) {
  const t = String(item.time || '');
  if (item.day && t.length > 10 && t.slice(0, 10) !== item.day) return `${F.when(item.day)}（台北 ${F.when(t)}）`;
  return F.when(t);
}

const MACRO_RANGES = [['1M', 21, '1 個月'], ['3M', 63, '3 個月'], ['6M', 126, '6 個月'], ['1Y', Infinity, '1 年']];

/**
 * 總經歷史紀錄（對話框內容）：折線圖 + 區間統計 + 每日收盤表
 * @param {HTMLElement} host
 * @param {object} item   macro.json 的一項（label、value、changePct…）
 * @param {{dates:string[], close:number[], source?:string}|null} hist
 * @param {{range:string, onRange:(r)=>void}} state
 */
export function renderMacroHistory(host, item, hist, state) {
  const charts = [];
  const head = h('div', { class: 'mh-head' },
    h('div', { class: 'mh-price' },
      h('span', { class: 'v' }, macroFmt(item.key, item.value)),
      item.key === 'fed' ? h('span', { class: 'muted' }, `自 ${F.when(item.time)} 起`)
        : h('span', { class: `d ${F.dir(item.changePct)}` }, `${F.signed(item.change, item.key === 'usdtwd' ? 3 : 2)}（${F.pct(item.changePct, 2, true)}）`)),
    h('p', { class: 'note' }, `最後${item.key === 'txf_night' ? '報價' : '收盤'}：${lastWhen(item)}｜來源：${item.source || hist?.source || 'N/A'}`));
  if (!hist?.dates?.length || hist.dates.length < 2) {
    host.replaceChildren(head, h('p', { class: 'note' }, '這一項目前沒有歷史資料（下次資料更新後會出現）。'));
    return () => {};
  }
  const [, n] = MACRO_RANGES.find(([k]) => k === state.range) || MACRO_RANGES[3];
  const start = Math.max(0, hist.dates.length - (Number.isFinite(n) ? n + 1 : hist.dates.length));
  const dates = hist.dates.slice(start);
  const close = hist.close.slice(start);
  const valid = close.filter(F.isNum);
  const hi = Math.max(...valid);
  const lo = Math.min(...valid);
  const first = close.find(F.isNum);
  const lastV = [...close].reverse().find(F.isNum);
  const chg = F.isNum(first) && F.isNum(lastV) && first ? ((lastV / first) - 1) * 100 : null;
  const box = h('div');
  const fmt = (v) => macroFmt(item.key, v);
  const stats = h('dl', { class: 'kv mh-stats' },
    h('dt', {}, '區間漲跌'), h('dd', { class: F.dir(chg) }, F.pct(chg, 2, true)),
    h('dt', {}, '區間最高'), h('dd', {}, `${fmt(hi)}（${F.when(dates[close.indexOf(hi)])}）`),
    h('dt', {}, '區間最低'), h('dd', {}, `${fmt(lo)}（${F.when(dates[close.indexOf(lo)])}）`),
    h('dt', {}, '距區間高點'), h('dd', {}, F.pct(hi ? ((lastV / hi) - 1) * 100 : null, 2, true)));
  const rowsDesc = dates.map((d, i) => [d, fmt(close[i]), i ? F.pct(F.isNum(close[i]) && F.isNum(close[i - 1]) && close[i - 1] ? ((close[i] / close[i - 1]) - 1) * 100 : null, 2, true) : '—']);
  host.replaceChildren(head,
    h('div', { class: 'seg', role: 'group', 'aria-label': '期間' }, MACRO_RANGES.map(([k, , label]) =>
      h('button', { type: 'button', 'aria-pressed': String(k === state.range), title: label, on: { click: () => state.onRange(k) } }, k))),
    box, stats,
    tableView(['日期', item.key === 'fed' ? '利率' : '收盤', '日漲跌'], rowsDesc, { label: '每日紀錄（表格）' }));
  const ch = lineChart(box);
  ch.update({
    dates, series: [{ name: item.label, values: close, color: 'var(--s1)', endLabel: true }],
    height: 240, fmt, axisFmt: (v) => macroFmt(item.key, v), ariaLabel: `${item.label}近${dates.length}個交易日走勢`,
  });
  charts.push(ch);
  return () => charts.forEach((c) => c.destroy?.());
}

/* ───────── 個股 ───────── */

const panel = (title, note, ...body) => h('section', { class: 'panel' }, h('h3', {}, title), note ? h('p', { class: 'note' }, note) : null, ...body);

function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

function legend(items) {
  return h('div', { class: 'legend', 'aria-hidden': 'true' }, items.map(([label, color, box]) => {
    const i = h('i', box ? { class: 'box' } : {});
    i.style.background = color;
    return h('span', {}, i, label);
  }));
}

const RANGES = [['3M', 63, '3 個月'], ['6M', 126, '6 個月'], ['1Y', 250, '1 年'], ['3Y', Infinity, '3 年']];

/**
 * @param {HTMLElement} host
 * @param {object} s       analytics.summarize() 結果
 * @param {object} state   { range, pending:boolean, errors, source, fetchedAt, onRange, onPrompt, onCSV, onXLSX }
 * @returns {Function} cleanup（移除圖表的 ResizeObserver）
 */
/** 自由現金流殖利率 = 近四季 FCF ÷ 市值（收盤 × 流通股數） */
function fcfYield(fcf, price, shares) {
  if (![fcf, price, shares].every(F.isNum) || price <= 0 || shares <= 0) return 'N/A';
  return F.pct((fcf / (price * shares)) * 100, 1);
}

/** 台股沒有流通股數欄位：用 近四季淨利 ÷ 近四季 EPS 推算（只在兩者都為正時） */
function impliedShares(f) {
  return F.isNum(f?.ni4) && F.isNum(f?.eps4) && f.ni4 > 0 && f.eps4 > 0 ? f.ni4 / f.eps4 : null;
}

const rankText = (r, unit, better) => (r?.rank ? `第 ${r.rank} ${better} / ${r.of} 檔（產業中位數 ${F.num(r.median, 1)}${unit}）` : `N/A（產業中位數 ${F.num(r?.median, 1)}${unit}）`);

/** 同業比較：同產業排名 + 前 12 檔（依營收年增排序，自己標粗體） */
function renderPeers(p, info, state) {
  const us = info.market === 'us';
  if (!p) {
    return panel('同業比較', null, h('p', { class: 'note' }, state.peersLoading ? '載入全市場資料中…'
      : us ? '這一檔不在 S&P 500 選股資料中，沒有同業可比較' : '全市場資料中找不到這一檔的產業別（ETF 沒有同業比較）'));
  }
  const peers = [...p.peers].sort((a, b) => (F.isNum(b.revYoY) ? b.revYoY : -1e9) - (F.isNum(a.revYoY) ? a.revYoY : -1e9));
  const top = peers.slice(0, 12);
  if (!top.some((r) => r.code === p.me.code)) top.push(p.me);
  const href = (c) => (us ? `#us/${c}` : `#${c}`);
  const table = h('table', { class: 'peer-table' },
    h('thead', {}, h('tr', {}, ['代號', '名稱', '本益比', '營收年增', 'ROE', '殖利率'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, top.map((r) => h('tr', { class: r.code === p.me.code ? 'me' : '' },
      h('td', {}, h('a', { href: href(r.code) }, r.code)),
      h('td', {}, r.name || ''),
      h('td', {}, F.isNum(r.pe) && r.pe > 0 ? F.num(r.pe, 1) : 'N/A'),
      h('td', { class: F.dir(r.revYoY) }, F.pct(r.revYoY, 1, true)),
      h('td', {}, F.pct(r.roe, 1)),
      h('td', {}, F.pct(r.yield, 2))))));
  return panel('同業比較', `${p.industry}，共 ${p.n} 檔${us ? '（S&P 500 成分股）' : '（上市櫃）'}；表格依營收年增排序，前 12 檔`,
    kv([
      ['本益比', rankText(p.ranks.pe, ' 倍', '低')],
      ['營收年增', rankText(p.ranks.revYoY, '%', '高')],
      ['ROE', rankText(p.ranks.roe, '%', '高')],
      ['殖利率', rankText(p.ranks.yield, '%', '高')],
    ]),
    h('div', { class: 'scroll-x' }, table));
}

/** 股利政策與填息（台股） */
function renderDividends(d, s, state, charts) {
  if (!d) {
    return panel('股利政策與填息', null, h('p', { class: 'note' },
      state.pending ? '載入中…' : '尚無股利資料：股利、除權息、現金流量表每次更新只補幾檔（避免超過 FinMind 免費額度），約 1–2 天內全部補齊。'));
  }
  const e = d.last;
  const lastText = !e ? 'N/A'
    : e.filled ? `${e.date} 除${e.kind || '息'} ${F.num(e.dividend)} 元，${e.fillDays} 個交易日填息`
      : e.inData ? `${e.date} 除${e.kind || '息'} ${F.num(e.dividend)} 元，尚未填息（已 ${e.tradingDaysSince} 個交易日，距填息 ${F.pct(e.gap != null ? -e.gap : null, 1)}）`
        : `${e.date} 除${e.kind || '息'} ${F.num(e.dividend)} 元`;
  const pol = d.policy.slice(-8);
  const box = h('div');
  const p = panel('股利政策與填息', `連續 ${d.streak} 年發放現金股利；填息 = 除息後收盤回到除息前一天的收盤價`,
    box,
    kv([
      ['最近一次', lastText],
      ['近 5 次平均填息', F.isNum(d.avgFillDays) ? `${F.num(d.avgFillDays, 0)} 個交易日` : 'N/A'],
      ['填息率（股價資料期間內）', F.isNum(d.fillRate) ? `${F.pct(d.fillRate, 0)}（${d.events.filter((x) => x.filled).length}/${d.events.filter((x) => x.inData).length} 次）` : 'N/A'],
      ['最近年度現金股利', pol.length ? `${pol[pol.length - 1].year} 年度 ${F.num(pol[pol.length - 1].cash)} 元，配發率 ${F.pct(pol[pol.length - 1].payout, 0)}` : 'N/A'],
    ]),
    tableView(['盈餘年度', '現金股利', '股票股利', 'EPS', '配發率'], d.policy.map((r) => [String(r.year), F.num(r.cash), F.num(r.stock), F.num(r.eps), F.pct(r.payout, 0)]), { label: '歷年股利政策' }),
    tableView(['除權息日', '股利', '除息前收盤', '填息天數'], d.events.map((x) => [x.date, F.num(x.dividend), F.num(x.before),
      x.filled ? `${x.fillDays} 天` : x.inData ? '尚未填息' : '超出股價資料期間']), { label: '除權息與填息紀錄' }));
  if (pol.length) {
    const ch = barChart(box);
    ch.update({
      labels: pol.map((r) => String(r.year)), values: pol.map((r) => r.cash),
      colorFor: () => 'var(--s1)', fmt: (v) => F.num(v), axisFmt: (v) => F.num(v, Math.abs(v) >= 10 ? 0 : 1),
      tipRows: (i) => [{ value: `${F.num(pol[i].cash)} 元`, label: '現金股利' }, { value: F.pct(pol[i].payout, 0), label: '配發率' }],
      ariaLabel: `${s.info.name}近 ${pol.length} 年現金股利`, height: 160,
    });
    charts.push(ch);
  }
  return p;
}

/** 美股內部人買賣（SEC Form 4） */
function renderInsider(x, state) {
  if (!x || !x.filings) {
    return panel('內部人買賣', null, h('p', { class: 'note' }, state.pending ? '載入中…' : '沒有 Form 4 資料（ETF、外國公司不需申報，或下次完整更新後才會出現）'));
  }
  const usd = (v) => (F.isNum(v) ? `${v < 0 ? '-' : ''}$${F.twd(Math.abs(v))}` : 'N/A');
  const line = (a, label) => (a.n ? `${a.n} 筆、${a.people} 人，${F.num(a.shares, 0)} 股，約 ${usd(a.value)}${a.plan ? `（${a.plan} 筆為 10b5-1 預排計畫）` : ''}` : `無${label}`);
  return panel('內部人買賣', `SEC Form 4，${x.since ?? ''} 至 ${x.end ?? ''}（近 6 個月，${x.filings} 份申報）。只有「公開市場買進 / 賣出」反映內部人的看法；獎酬配股、繳稅扣股屬例行性`,
    kv([
      ['公開市場買進', h('span', { class: x.buy.n ? 'up' : '' }, line(x.buy, '買進'))],
      ['公開市場賣出', h('span', { class: x.sell.n ? 'down' : '' }, line(x.sell, '賣出'))],
      ['淨買賣金額', signedSpan(usd(x.net), x.net)],
    ]),
    tableView(['日期', '人員', '職稱', '交易', '股數', '價格', '交易後持股'], [...x.recent].reverse().map((t) => [
      t.date, t.owner, t.role || '', `${INSIDER_CODES[t.code] || t.code}${t.plan ? '（10b5-1）' : ''}`,
      `${t.ad === 'D' ? '-' : '+'}${F.num(t.shares, 0)}`, F.isNum(t.price) && t.price ? `$${F.num(t.price, 2)}` : 'N/A', F.num(t.after, 0)]), { label: '最近 20 筆申報明細' }));
}

export function renderStock(host, s, state) {
  const charts = [];
  const { info, price: px, valuation: v, tech: t, river: rv, revenue: rev, inst, instToday: it, margin: mg, holding: hd, fundamentals: f } = s;
  const c = completeness(s);
  const us = info.market === 'us';
  // TradingView：只開新分頁看線圖（不嵌入網頁，維持 CSP 與資料一致性）
  const tvSymbol = us ? info.code : `${info.market === 'tpex' ? 'TPEX' : 'TWSE'}:${info.code}`;
  const srcText = us ? `Yahoo 日線 + SEC 財報，抓取於 ${F.when(state.fetchedAt)}` : state.source === 'prefetched'
    ? `追蹤清單資料，抓取於 ${F.when(state.fetchedAt)}`
    : state.source === 'live' ? 'FinMind 即時查詢（免 token）' : '全市場行情';

  const head = h('div', { class: 'stock-head' },
    h('div', {},
      h('h2', {}, `${info.code} ${info.name}`),
      h('div', { class: 'sub' },
        h('span', { class: 'badge' }, us ? '美股' : marketLabel(info.market)),
        info.industry ? h('span', {}, info.industry) : null,
        h('span', { class: 'muted' }, srcText),
      )),
    h('div', { class: 'actions' },
      state.onAi ? h('button', { class: 'btn ai', type: 'button', on: { click: state.onAi } }, '產生 AI 報告') : null,
      h('button', { class: 'btn primary', type: 'button', on: { click: state.onPrompt } }, '產生分析指令'),
      h('button', { class: 'btn', type: 'button', on: { click: state.onCSV } }, '下載 CSV'),
      h('button', { class: 'btn', type: 'button', on: { click: state.onXLSX } }, '下載 Excel'),
      h('a', { class: 'btn', href: `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`, target: '_blank', rel: 'noopener noreferrer' }, 'TradingView ↗'),
    ));

  const quote = h('div', { class: 'quote' },
    h('span', { class: 'price' }, F.price(px?.price)),
    signedSpan(F.change(px?.change, px?.changePct), px?.change),
    h('span', { class: 'asof' }, px ? `${px.kind}，${px.source}，${F.when(px.asOf)}` : '尚無價格資料'),
  );

  const comp = h('details', { class: 'completeness' },
    h('summary', {}, `資料完整度 ${c.pct}%（${c.ok}/${c.total}）${state.pending ? '，其餘資料載入中' : ''}`),
    c.missing.length ? h('ul', {}, c.missing.map((m) => h('li', {}, `缺少：${m}`))) : h('p', {}, '分析所需欄位皆已取得。'),
    Object.keys(state.errors || {}).length ? h('p', { class: 'muted' }, `失敗的資料集：${Object.entries(state.errors).map(([k, e]) => `${k}（${e}）`).join('；')}`) : null,
  );

  const tile = (l, val, sub, cls = '') => h('div', { class: 'tile' }, h('div', { class: 'l' }, l), h('div', { class: `v num ${cls}` }, val), h('div', { class: 's' }, sub));
  const instSub = it ? `${it.source}，${F.when(it.date)}，張` : '無資料';
  const tiles = us ? h('div', { class: 'tiles' },
    tile('本益比', F.num(v.pe), '收盤 ÷ 近四季 EPS'),
    tile('股價淨值比', F.num(v.pb), '收盤 ÷ 每股淨值'),
    tile('近四季 EPS', F.num(f?.eps4), f?.latestQuarter ? `美元，至 ${f.latestQuarter}` : '無資料'),
    tile('殖利率', F.pct(v.yield), '近一年現金股利 ÷ 收盤'),
    tile('季營收年增', F.pct(f?.revYoY, 1, true), '最新一季', F.dir(f?.revYoY)),
    tile('ROE', F.pct(f?.roe, 1), '近四季'),
  ) : h('div', { class: 'tiles' },
    tile('本益比', F.num(v.pe), v.source ? `${v.source}，${F.when(v.asOf)}` : '無資料'),
    tile('股價淨值比', F.num(v.pb), v.source ? '倍' : ''),
    tile('殖利率', F.pct(v.yield), v.source ? '近四季現金股利' : ''),
    tile('外資', F.lots(it?.foreign), instSub, F.dir(it?.foreign)),
    tile('投信', F.lots(it?.trust), instSub, F.dir(it?.trust)),
    tile('自營商', F.lots(it?.dealer), instSub, F.dir(it?.dealer)),
  );

  /* 股價圖 */
  const priceChart = h('div');
  const range = RANGES.find((r) => r[0] === state.range) || RANGES[2];
  const ps = s.series;
  const from = Math.max(0, ps.close.length - range[1]);
  const pricePanel = panel('股價與均線', null,
    h('div', { class: 'seg', role: 'group', 'aria-label': '期間' }, RANGES.map(([k, , label]) =>
      h('button', { type: 'button', 'aria-pressed': String(k === range[0]), on: { click: () => state.onRange(k) } }, label))),
    legend([['收盤價', 'var(--s1)'], ['MA20', 'var(--s2)'], ['MA60', 'var(--s3)']]),
    priceChart,
    t ? tableView(['日期', '收盤', 'MA20', 'MA60'], ps.dates.slice(from).map((d, i) => [d, F.price(ps.close[from + i]), F.price(t.maSeries[20][from + i]), F.price(t.maSeries[60][from + i])])) : null,
  );
  if (ps.close.length > 1 && t) {
    const ch = lineChart(priceChart);
    ch.update({
      dates: ps.dates.slice(from),
      series: [
        { name: '收盤價', values: ps.close.slice(from), color: 'var(--s1)', endLabel: true },
        { name: 'MA20', values: t.maSeries[20].slice(from), color: 'var(--s2)' },
        { name: 'MA60', values: t.maSeries[60].slice(from), color: 'var(--s3)' },
      ],
      fmt: F.price, axisFmt: F.axis, height: 270,
      ariaLabel: `${info.name}${range[2]}收盤價走勢，最新 ${F.price(t.close)}，用左右方向鍵逐日查看`,
    });
    charts.push(ch);
  } else priceChart.append(h('p', { class: 'note' }, state.pending ? '股價資料載入中…' : '沒有股價歷史資料'));

  /* 技術指標 */
  const crossText = (x) => (x === 'golden' ? '，近 3 日黃金交叉' : x === 'dead' ? '，近 3 日死亡交叉' : '');
  const techPanel = panel('技術指標', t ? `${t.date} 收盤` : null, t ? kv([
    ['均線排列', t.alignment],
    ['MA5 / MA20', `${F.price(t.ma[5])} / ${F.price(t.ma[20])}`],
    ['MA60 / MA240', `${F.price(t.ma[60])} / ${F.price(t.ma[240])}`],
    ['KD (9)', `${F.num(t.k, 1)} / ${F.num(t.d, 1)}${crossText(t.kdCross)}`],
    ['RSI (14)', F.num(t.rsi, 1)],
    ['MACD 柱狀', h('span', { class: F.dir(t.osc) }, `${F.signed(t.osc)}${crossText(t.macdCross)}`)],
    ['量 / 20 日均量', `${F.num(t.volRatio, 2)} 倍`],
    ['5 日 / 20 日', [signedSpan(F.pct(t.returns.d5, 1, true), t.returns.d5), ' / ', signedSpan(F.pct(t.returns.d20, 1, true), t.returns.d20)]],
    ['年初至今 / 一年', [signedSpan(F.pct(t.returns.ytd, 1, true), t.returns.ytd), ' / ', signedSpan(F.pct(t.returns.y1, 1, true), t.returns.y1)]],
    ['一年價格位階', `${F.num(t.pct1y, 0)} 百分位`],
    ['60 日高 / 低', `${F.price(t.levels.high60)} / ${F.price(t.levels.low60)}`],
    ['52 週高 / 低', `${F.price(t.levels.high250)} / ${F.price(t.levels.low250)}`],
  ]) : h('p', { class: 'note' }, state.pending ? '載入中…' : '股價資料不足（少於 30 個交易日）'));

  /* 河流圖 */
  const riverChart = h('div');
  const riverPanel = panel('本益比河流圖', rv
    ? `目前 ${F.num(rv.currentPE, 1)} 倍，近三年 ${F.num(rv.percentile, 0)} 百分位，位於「${rv.zone}」區；25–75 百分位對應 ${F.price(rv.fair.low)}–${F.price(rv.fair.high)}`
    : null,
  rv ? legend([['收盤價', 'var(--s1)'], ['10–25 百分位', 'var(--band-1)', true], ['25–50', 'var(--band-2)', true], ['50–75', 'var(--band-3)', true], ['75–90', 'var(--band-4)', true]]) : null,
  riverChart,
  rv ? tableView(['日期', '收盤', ...rv.mults.map((m) => `${F.num(m, 1)}x`)], rv.dates.map((d, i) => [d, F.price(rv.price[i]), ...rv.bands.map((b) => F.price(b[i]))])) : null);
  if (rv) {
    const ch = lineChart(riverChart);
    ch.update({
      dates: rv.dates,
      bands: [0, 1, 2, 3].map((k) => ({ lower: rv.bands[k], upper: rv.bands[k + 1], fill: `var(--band-${k + 1})` })),
      bandLabels: [0, 2, 4].map((k) => ({ values: rv.bands[k], text: `${F.num(rv.mults[k], 1)}x` })),
      series: [{ name: '收盤價', values: rv.price, color: 'var(--s1)' }],
      fmt: F.price, axisFmt: F.axis, height: 250,
      ariaLabel: `${info.name}近三年本益比河流圖，目前位於${rv.zone}區`,
    });
    charts.push(ch);
  } else riverChart.append(h('p', { class: 'note' }, state.pending ? '載入中…' : '虧損或本益比資料不足，河流圖不適用；請參考股價淨值比。'));

  /* 月營收 */
  const revChart = h('div');
  const revItems = rev ? rev.items.filter((x) => F.isNum(x.yoy)).slice(-18) : [];
  const revPanel = panel('月營收年增率', rev
    ? `最新 ${rev.latest.period}：${F.twd(rev.latest.revenue)}，年增 ${F.pct(rev.latest.yoy, 1, true)}；今年累計 ${F.pct(rev.ytdYoY, 1, true)}`
    : null,
  revChart,
  rev ? tableView(['月份', '營收', '年增', '月增'], rev.items.map((x) => [x.period, F.twd(x.revenue), F.pct(x.yoy, 1, true), F.pct(x.mom, 1, true)])) : null);
  if (revItems.length) {
    const ch = barChart(revChart);
    ch.update({
      labels: revItems.map((x) => `${String(x.y).slice(2)}/${x.m}`),
      values: revItems.map((x) => x.yoy),
      colorFor: (val) => (val >= 0 ? 'var(--up)' : 'var(--down)'),
      fmt: (val) => F.pct(val, 1, true), axisFmt: (val) => `${val}%`,
      tipRows: (i) => [
        { value: F.pct(revItems[i].yoy, 1, true), label: '年增' },
        { value: F.pct(revItems[i].mom, 1, true), label: '月增' },
        { value: F.twd(revItems[i].revenue), label: '營收' },
      ],
      ariaLabel: `${info.name}近 ${revItems.length} 個月營收年增率`,
    });
    charts.push(ch);
  } else revChart.append(h('p', { class: 'note' }, state.pending ? '載入中…' : '沒有月營收資料'));

  /* 籌碼 */
  const chipPanel = panel('籌碼', '單位：張', kv([
    inst && ['外資 5 / 20 日', [signedSpan(F.lots(inst.sum5.foreign), inst.sum5.foreign), ' / ', signedSpan(F.lots(inst.sum20.foreign), inst.sum20.foreign)]],
    inst && ['投信 5 / 20 日', [signedSpan(F.lots(inst.sum5.trust), inst.sum5.trust), ' / ', signedSpan(F.lots(inst.sum20.trust), inst.sum20.trust)]],
    inst && ['自營商 5 / 20 日', [signedSpan(F.lots(inst.sum5.dealer), inst.sum5.dealer), ' / ', signedSpan(F.lots(inst.sum20.dealer), inst.sum20.dealer)]],
    inst && ['外資連續', inst.foreignStreak > 0 ? `連 ${inst.foreignStreak} 日買超` : inst.foreignStreak < 0 ? `連 ${-inst.foreignStreak} 日賣超` : '—'],
    ['外資持股比例', hd ? `${F.pct(hd.ratio)}（20 日 ${F.signed(hd.chg20)}）` : 'N/A'],
    ['融資餘額', mg ? `${F.num(mg.margin, 0)}（20 日 ${F.signed(mg.marginChg20, 0)}）` : 'N/A'],
    ['融券餘額', mg ? `${F.num(mg.short, 0)}（20 日 ${F.signed(mg.shortChg20, 0)}）` : 'N/A'],
    ['券資比', mg ? F.pct(mg.shortRatio) : 'N/A'],
  ]), !inst && !mg && !hd && state.pending ? h('p', { class: 'note' }, '載入中…') : null);

  /* 相對大盤與風險（台股比加權指數、美股比 S&P 500） */
  const rk = s.risk;
  const relRow = (label, x) => [label, x ? [signedSpan(F.pct(x.stock, 1, true), x.stock), h('span', { class: 'muted' }, ` vs ${F.pct(x.bench, 1, true)}，`),
    signedSpan(`${x.excess >= 0 ? '贏' : '輸'} ${F.num(Math.abs(x.excess), 1)} 點`, x.excess)] : 'N/A'];
  const betaText = (b) => (!F.isNum(b) ? 'N/A' : `${F.num(b, 2)}（${b > 1.2 ? '大盤漲跌時，漲跌幅通常更大' : b < 0.8 ? '與大盤連動較低' : '與大盤大致同步'}）`);
  const riskPanel = panel('相對大盤與風險', rk ? `比較對象：${rk.label}，至 ${rk.date}；報酬為「個股 vs 大盤」` : null, rk ? kv([
    relRow('近 1 個月', rk.periods.m1),
    relRow('近 3 個月', rk.periods.m3),
    relRow('近 6 個月', rk.periods.m6),
    relRow('近 1 年', rk.periods.y1),
    ['Beta（近一年）', betaText(rk.beta)],
    ['年化波動度', `${F.pct(rk.vol, 1)}（大盤 ${F.pct(rk.benchVol, 1)}）`],
    ['近一年最大回撤', h('span', { class: 'down' }, F.pct(rk.mdd, 1))],
  ]) : h('p', { class: 'note' }, state.pending ? '載入中…' : '大盤資料不足，無法比較'));

  /* 季度趨勢：每季 EPS（長條）＋營收年增、毛利率（提示框） */
  const qChart = h('div');
  const qs = f ? f.quarters.filter((q) => F.isNum(q.eps)).slice(-12) : [];
  const money = us ? F.usd : F.twd;
  const hasFcf = qs.some((q) => F.isNum(q.fcf));
  const lastQ = qs[qs.length - 1];
  const qPanel = panel('季度趨勢', lastQ ? `最新 ${lastQ.date}：EPS ${F.num(lastQ.eps)}，營收 ${money(lastQ.revenue)}，年增 ${F.pct(lastQ.revYoY, 1, true)}` : null,
    qChart,
    qs.length ? tableView(['季度', 'EPS', '營收', '營收年增', '毛利率', ...(hasFcf ? ['自由現金流'] : [])],
      qs.map((q) => [q.date, F.num(q.eps), money(q.revenue), F.pct(q.revYoY, 1, true), F.pct(q.gross, 1), ...(hasFcf ? [money(q.fcf)] : [])])) : null);
  if (qs.length) {
    const ch = barChart(qChart);
    ch.update({
      labels: qs.map((q) => `${q.date.slice(2, 4)}Q${Math.ceil(+q.date.slice(5, 7) / 3)}`),
      values: qs.map((q) => q.eps),
      colorFor: (val) => (val >= 0 ? 'var(--s1)' : 'var(--down)'),
      fmt: (val) => F.num(val), axisFmt: (val) => F.num(val, Math.abs(val) >= 10 ? 0 : 2),
      tipRows: (i) => [
        { value: F.num(qs[i].eps), label: 'EPS' },
        { value: F.pct(qs[i].revYoY, 1, true), label: '營收年增' },
        { value: F.pct(qs[i].gross, 1), label: '毛利率' },
      ],
      ariaLabel: `${info.name}近 ${qs.length} 季每股盈餘`,
    });
    charts.push(ch);
  } else qChart.append(h('p', { class: 'note' }, state.pending ? '載入中…' : '沒有季度財報資料'));

  /* 基本面 */
  const fundPanel = panel('基本面', f ? `財報至 ${f.latestQuarter ?? 'N/A'}（單季）` : null, f ? [kv([
    ['近四季 EPS', `${F.num(f.eps4)} ${us ? '美元' : '元'}`],
    us && ['季營收年增', signedSpan(F.pct(f.revYoY, 1, true), f.revYoY)],
    ['EPS 年增', signedSpan(F.pct(f.eps4YoY, 1, true), f.eps4YoY)],
    ['毛利率', `${F.pct(f.margins?.gross, 1)}（去年同期 ${F.pct(f.marginsLastYear?.gross, 1)}）`],
    ['營益率', `${F.pct(f.margins?.op, 1)}（去年同期 ${F.pct(f.marginsLastYear?.op, 1)}）`],
    ['淨利率', `${F.pct(f.margins?.net, 1)}（去年同期 ${F.pct(f.marginsLastYear?.net, 1)}）`],
    ['ROE / ROA（近四季）', `${F.pct(f.roe, 1)} / ${F.pct(f.roa, 1)}`],
    ['負債比 / 流動比', `${F.pct(f.debtRatio, 1)} / ${F.pct(f.currentRatio, 0)}`],
    (us || F.isNum(f.fcf4)) && ['近四季自由現金流', money(f.fcf4)],
    (us || F.isNum(f.fcf4)) && ['自由現金流殖利率', fcfYield(f.fcf4, px?.price, us ? s.shares : impliedShares(f))],
    (us || F.isNum(f.fcf4)) && ['盈餘品質（FCF ÷ 淨利）', F.isNum(f.fcf4) && F.isNum(f.ni4) && f.ni4 > 0 ? `${F.num(f.fcf4 / f.ni4, 2)} 倍` : 'N/A'],
  ]), tableView(['季度', 'EPS', '毛利率', '營益率', '淨利率'], f.quarters.map((q) => [q.date, F.num(q.eps), F.pct(q.gross, 1), F.pct(q.op, 1), F.pct(q.net, 1)]))]
    : h('p', { class: 'note' }, state.pending ? '載入中…' : '沒有財報資料'));

  const peerPanel = renderPeers(s.peers, info, state);
  const divPanel = us ? null : renderDividends(s.dividends, s, state, charts);
  const insPanel = us ? renderInsider(s.insider, state) : null;

  host.replaceChildren(
    head, quote, comp, tiles,
    h('div', { class: 'grid' }, pricePanel, techPanel),
    // 美股沒有月營收、法人籌碼 → 河流圖 + 財報、季度趨勢 + 相對大盤、內部人 + 同業
    ...(us ? [h('div', { class: 'grid even' }, riverPanel, fundPanel), h('div', { class: 'grid even' }, qPanel, riskPanel),
      h('div', { class: 'grid even' }, insPanel, peerPanel)]
      : [h('div', { class: 'grid even' }, riverPanel, revPanel), h('div', { class: 'grid even' }, chipPanel, fundPanel),
        h('div', { class: 'grid even' }, qPanel, riskPanel), h('div', { class: 'grid even' }, divPanel, peerPanel)]),
  );
  return () => charts.forEach((ch) => ch.destroy());
}

/** 尚未部署資料（或用 file:// 直接開檔）時的說明 */
export function renderSetup(host, isFile) {
  host.replaceChildren(h('div', { class: 'empty-state' },
    h('h2', {}, isFile ? '請用本機伺服器開啟' : '還沒有資料'),
    isFile
      ? h('p', {}, '瀏覽器不允許從檔案 (file://) 讀取 JSON。請在專案資料夾執行 scripts/preview.sh（或 python3 -m http.server），再開 http://localhost:8000。')
      : [h('p', {}, '資料由 GitHub Actions 產生。請到 repo 的 Settings 完成兩件事：'),
        h('ol', {},
          h('li', {}, 'Secrets and variables → Actions → New repository secret，名稱 FINMIND_TOKEN'),
          h('li', {}, 'Pages → Build and deployment → Source 選 GitHub Actions')),
        h('p', {}, '然後到 Actions 分頁執行「Update data & deploy」，約 2 分鐘後重新整理此頁。')],
  ));
}
