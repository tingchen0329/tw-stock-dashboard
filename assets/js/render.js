/**
 * 畫面渲染（只負責「資料 → DOM」，不抓資料、不保存狀態）
 *
 * 安全：全部用 h() 建立節點、textContent 寫入文字。
 *       股票名稱、產業別都來自外部 API，絕不經過 innerHTML（舊版有 XSS 風險）。
 */

import * as F from './format.js';
import { completeness } from './analytics.js';
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

export function renderMacro(host, items) {
  if (!items?.length) { host.replaceChildren(); return; }
  host.replaceChildren(
    h('span', { class: 'strip-label' }, '總經'),
    h('div', { class: 'chips' }, ...items.map((m) => h('div', { class: 'chip', title: `${m.source}，${F.when(m.time)}` },
      h('span', { class: 't' }, m.label),
      h('span', { class: 'v' }, m.key === 'fed' || m.key === 'us10y' ? F.pct(m.value, 2) : m.key === 'usdtwd' ? F.num(m.value, 3) : F.num(m.value, m.value > 1000 ? 0 : 2)),
      h('span', { class: `d ${m.key === 'fed' ? 'flat' : F.dir(m.changePct)}` },
        m.key === 'fed' ? `自 ${F.when(m.time)}` : F.isNum(m.changePct) ? `${m.changePct > 0 ? '▲' : m.changePct < 0 ? '▼' : ''} ${F.pct(m.changePct, 2, true)}` : '—',
        // 夜盤的價值在於「多新」：顯示報價時間（盤中為時:分，備援的昨夜收盤為日期）
        m.key === 'txf_night' ? h('span', { class: 'when' }, F.when(m.time)) : null),
    ))),
  );
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
    tile('季營收年增', F.pct(f?.revYoY, 1, true), '最新一季', F.dir(f?.revYoY)),
    tile('毛利率', F.pct(f?.margins?.gross, 1), '最新一季'),
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
  ]), tableView(['季度', 'EPS', '毛利率', '營益率', '淨利率'], f.quarters.map((q) => [q.date, F.num(q.eps), F.pct(q.gross, 1), F.pct(q.op, 1), F.pct(q.net, 1)]))]
    : h('p', { class: 'note' }, state.pending ? '載入中…' : '沒有財報資料'));

  host.replaceChildren(
    head, quote, comp, tiles,
    h('div', { class: 'grid' }, pricePanel, techPanel),
    // 美股沒有本益比歷史、月營收、法人籌碼 → 只顯示財報
    ...(us ? [fundPanel] : [h('div', { class: 'grid even' }, riverPanel, revPanel), h('div', { class: 'grid even' }, chipPanel, fundPanel)]),
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
