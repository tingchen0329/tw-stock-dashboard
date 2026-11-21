/**
 * 全市場選股：成長型 / 殖利率型
 *
 * 資料：screen.json（scripts/fetch_data.py 每次更新時用證交所、櫃買開放資料整理，約 2,000 檔上市櫃個股，不含 ETF）
 * 篩選全部在瀏覽器端完成：改門檻立即重算，門檻記在這台瀏覽器（localStorage，失敗也不影響使用）。
 *
 * 限制：開放資料只有「最新一期」月營收與損益表，沒有多年歷史，
 * 所以沒有「連續 N 年」類型的條件；ROE 以「股價淨值比 ÷ 本益比」推估。
 */
import * as F from './format.js';
import { h } from './render.js';
import { sortRows } from './overview.js';
import { runBacktest } from './backtest.js';
import { lineChart, tableView } from './charts.js';

import { TW_PRESETS, US_PRESETS } from './presets.js';

export { TW_PRESETS, US_PRESETS };

const OPS = { '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b };
const OP_TEXT = { '>=': '≥', '<=': '≤', '>': '>' };

/** screen.json 的欄位陣列 → 物件 */
export const toObjects = (screen) => (screen?.rows ?? []).map((r) => Object.fromEntries(screen.cols.map((c, i) => [c, r[i]])));

/** 全部條件都要符合；缺資料視為不符合（不會因為 N/A 被選進來）。value 為 null / '' 的條件略過 */
export function applyScreen(rows, criteria) {
  const active = criteria.filter((c) => F.isNum(c.value));
  return rows.filter((r) => active.every((c) => F.isNum(r[c.key]) && OPS[c.op](r[c.key], c.value)));
}

/* ───────── 畫面 ───────── */

const storeKey = (market) => (market === 'us' ? 'screen:us:v1' : 'screen:v1');
const load = (market) => { try { return JSON.parse(localStorage.getItem(storeKey(market))) || {}; } catch { return {}; } };
const save = (market, o) => { try { localStorage.setItem(storeKey(market), JSON.stringify(o)); } catch { /* 無痕模式等：不記也能用 */ } };

const pctCell = (v) => (F.isNum(v) ? h('span', { class: `num ${F.dir(v)}` }, F.pct(v, 1, true)) : h('span', { class: 'muted' }, F.NA));
const plain = (text) => h('span', { class: text === F.NA ? 'muted' : '' }, text);

function columns(watch) {
  return [
    { key: 'code', label: '股票', cell: (r) => [h('b', {}, r.code), h('span', { class: 'name' }, r.name), watch.has(r.code) ? h('span', { class: 'star', title: '已在追蹤清單' }, '★') : null] },
    { key: 'industry', label: '產業', cell: (r) => h('span', { class: 'muted' }, r.industry || F.NA) },
    { key: 'chgPct', label: '收盤', cell: (r) => [h('span', { class: 'px' }, F.price(r.close)), h('span', { class: `num ${F.dir(r.chgPct)} sub` }, F.isNum(r.chgPct) ? F.pct(r.chgPct, 2, true) : F.NA)] },
    { key: 'volume', label: '成交量', tip: '當日成交張數', cell: (r) => plain(F.num(r.volume, 0)) },
    { key: 'pe', label: '本益比', cell: (r) => plain(F.num(r.pe, 1)) },
    { key: 'pb', label: '股淨比', cell: (r) => plain(F.num(r.pb, 2)) },
    { key: 'yield', label: '殖利率', cell: (r) => plain(F.pct(r.yield, 2)) },
    { key: 'roe', label: 'ROE', tip: '推估：股價淨值比 ÷ 本益比', cell: (r) => plain(F.pct(r.roe, 1)) },
    { key: 'revYoY', label: '月營收年增', tip: '最新月營收與去年同月比較', cell: (r) => pctCell(r.revYoY) },
    { key: 'revCumYoY', label: '累計年增', tip: '今年累計營收與去年同期比較', cell: (r) => pctCell(r.revCumYoY) },
    { key: 'eps', label: 'EPS', tip: '今年累計每股盈餘（最新一季財報）', cell: (r) => h('span', { class: F.isNum(r.eps) && r.eps < 0 ? 'down' : '' }, F.num(r.eps, 2)) },
    { key: 'gm', label: '毛利率', cell: (r) => plain(F.pct(r.gm, 1)) },
    { key: 'om', label: '營益率', cell: (r) => plain(F.pct(r.om, 1)) },
    { key: 'foreign', label: '外資', tip: '當日外資買賣超（張）', cell: (r) => (F.isNum(r.foreign) ? h('span', { class: `num ${F.dir(r.foreign)}` }, F.signed(r.foreign, 0)) : plain(F.NA)) },
    { key: 'trust', label: '投信', tip: '當日投信買賣超（張）', cell: (r) => (F.isNum(r.trust) ? h('span', { class: `num ${F.dir(r.trust)}` }, F.signed(r.trust, 0)) : plain(F.NA)) },
    { key: 'big1000', label: '千張大戶', tip: '集保股權分散表：持股 1,000 張以上股東的持股比例（每週五更新）', cell: (r) => plain(F.pct(r.big1000, 1)) },
    { key: 'big1000Chg', label: '大戶週增減', tip: '千張大戶持股比例與前一週相比（百分點）', cell: (r) => (F.isNum(r.big1000Chg) ? h('span', { class: `num ${F.dir(r.big1000Chg)}` }, F.signed(r.big1000Chg, 2)) : plain(F.NA)) },
  ];
}

/* ───────── 回測 ───────── */

const sp = (v, dp = 1) => (F.isNum(v) ? h('span', { class: `num ${F.dir(v)}` }, F.pct(v, dp, true)) : h('span', { class: 'muted' }, F.NA));

/**
 * 選股條件回測區塊：依目前門檻即時重算（backtest.json 由 build_overview.mjs 產生）
 * @returns {{el:HTMLElement, chart:object|null}}
 */
export function backtestView(panel, crit, presetLabel, onPick) {
  const r = runBacktest(panel, crit);
  if (!r) return { el: h('p', { class: 'note' }, '回測資料不足（需要至少兩個月的大盤與個股資料）。'), chart: null };
  const { strat: S, univ: U, bench: B } = r.stats;
  const names = new Map(panel.stocks.map((s) => [s.code, s.name]));
  const benchLabel = `${panel.bench.label}${panel.bench.kind === 'tr' ? '' : '（價格指數，不含息）'}`;
  const row = (label, x, cls) => h('tr', { class: cls },
    h('th', { scope: 'row' }, label),
    h('td', {}, sp(x.total)), h('td', {}, sp(x.cagr)), h('td', {}, F.isNum(x.mdd) ? h('span', { class: 'down' }, F.pct(x.mdd, 1)) : F.NA),
    h('td', {}, F.isNum(x.win) ? F.pct(x.win, 0) : '—'), h('td', {}, F.isNum(x.avgPicks) ? F.num(x.avgPicks, 1) : '—'));
  const box = h('div');
  const chart = lineChart(box);
  chart.update({
    dates: r.curve.dates, height: 240,
    series: [
      { name: '策略', values: r.curve.strat.map((v) => v * 100), color: 'var(--s1)', endLabel: true },
      { name: '清單等權', values: r.curve.univ.map((v) => v * 100), color: 'var(--s2)', endLabel: true },
      { name: benchLabel, values: r.curve.bench.map((v) => v * 100), color: 'var(--s3)', endLabel: true },
    ],
    fmt: (v) => F.num(v, 1), axisFmt: (v) => F.num(v, 0), ariaLabel: `${presetLabel}條件回測：策略、清單等權與大盤的累積淨值（起點 100）`,
  });
  const lastP = r.periods[r.periods.length - 1];
  const pickBtns = lastP.picks.length
    ? lastP.picks.map((c) => h('button', { type: 'button', class: 'chip', on: { click: () => onPick(c) } }, h('span', { class: 't' }, `${c} ${names.get(c) || ''}`)))
    : [h('span', { class: 'muted' }, '目前沒有股票符合（持有現金）')];
  const legendEl = h('div', { class: 'legend', 'aria-hidden': 'true' }, [['策略', 'var(--s1)'], ['清單等權', 'var(--s2)'], [benchLabel, 'var(--s3)']].map(([t, c]) => {
    const i = h('i');
    i.style.background = c;
    return h('span', {}, i, t);
  }));
  const el = h('section', { class: 'panel backtest' },
    h('h3', {}, `條件回測：${presetLabel}（追蹤清單）`),
    h('p', { class: 'note' }, `用上方目前的門檻，在追蹤清單 ${panel.stocks.length} 檔個股（不含 ETF）上回測：${r.start}～${r.end} 共 ${r.months} 期，`
      + `每月 ${panel.day} 日後第一個交易日收盤換股、等權重，已扣手續費 0.1425% 與證交稅 0.3%（期間合計約 ${F.num(S.fees, 1)}%）。`
      + `選不到股票的月份持有現金（${S.empty} 期）。`),
    r.skipped.length ? h('p', { class: 'note' }, `沒有歷史資料、回測時不使用的條件：${r.skipped.map((c) => c.label).join('、')}。`) : null,
    h('div', { class: 'ov-wrap' }, h('table', { class: 'ov bt-stats' },
      h('thead', {}, h('tr', {}, ['', '累積報酬', '年化', '最大回撤', '月勝率 vs 大盤', '平均檔數'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, row('策略（符合條件）', S, 'bt-strat'), row('清單等權（全部持有）', U), row(benchLabel, B)))),
    legendEl, box,
    h('p', { class: 'note' }, `${F.when(lastP.date)} 換股後持有（${lastP.n} 檔）：`), h('div', { class: 'chips bt-picks' }, ...pickBtns),
    tableView(['換股日', '檔數', '策略', '清單等權', '大盤', '選中'], r.periods.map((p) => [
      p.date, String(p.n), F.pct(p.ret * 100, 2, true), F.pct(F.isNum(p.univ) ? p.univ * 100 : null, 2, true), F.pct(F.isNum(p.bench) ? p.bench * 100 : null, 2, true),
      p.picks.map((c) => `${c}${names.get(c) ? ` ${names.get(c)}` : ''}`).join('、') || '（現金）']), { label: '每期明細（表格）' }),
    h('details', { class: 'bt-caveats', open: true }, h('summary', {}, '回測的限制（請先讀）'),
      h('ul', {},
        h('li', {}, h('b', {}, '倖存者 / 選擇偏差：'), '股票池是「現在的」追蹤清單——多半是你近年看好、表現好的股票，也不含期間內下市或被你移除的股票，所以絕對報酬通常高估。比較「策略 vs 清單等權」的差距，比看絕對報酬有意義。'),
        h('li', {}, h('b', {}, '樣本少：'), `只有約 ${r.months} 個月，結果容易被單一波行情左右，不代表條件長期有效。`),
        h('li', {}, h('b', {}, '條件為近似：'), '月營收以次月 10 日、季報以法定期限（5/15、8/14、11/14、3/31）視為公布日；金融業期限可能不同。成交量用換股日前 20 日平均；ROE 以股價淨值比 ÷ 本益比推估。'),
        h('li', {}, h('b', {}, '交易假設：'), '以換股日收盤價成交、不計滑價與零股限制；忽略持有期間權重漂移的再平衡成本。'),
        h('li', {}, '過去績效不代表未來，這不是買賣建議。'))));
  return { el, chart };
}

function usColumns(watch) {
  return [
    { key: 'code', label: '股票', cell: (r) => [h('b', {}, r.code), h('span', { class: 'name' }, r.name), watch.has(r.code) ? h('span', { class: 'star', title: '已在美股追蹤清單' }, '★') : null] },
    { key: 'sector', label: '產業', cell: (r) => h('span', { class: 'muted' }, r.sector || F.NA) },
    { key: 'chgPct', label: '收盤', cell: (r) => [h('span', { class: 'px' }, F.price(r.close)), h('span', { class: `num ${F.dir(r.chgPct)} sub` }, F.isNum(r.chgPct) ? F.pct(r.chgPct, 2, true) : F.NA)] },
    { key: 'r20', label: '20日', cell: (r) => pctCell(r.r20) },
    { key: 'pe', label: '本益比', tip: '收盤 ÷ 近四季 EPS', cell: (r) => plain(F.num(r.pe, 1)) },
    { key: 'yield', label: '殖利率', tip: '近一年現金股利 ÷ 收盤', cell: (r) => plain(F.pct(r.yield, 2)) },
    { key: 'roe', label: 'ROE', tip: '近四季淨利 ÷ 最新股東權益', cell: (r) => plain(F.pct(r.roe, 1)) },
    { key: 'revYoY', label: '季營收年增', tip: '最新一季營收與去年同季比較', cell: (r) => pctCell(r.revYoY) },
    { key: 'epsYoY', label: '季 EPS 年增', tip: '最新一季 EPS 與去年同季比較', cell: (r) => pctCell(r.epsYoY) },
    { key: 'netMargin', label: '淨利率', tip: '最新一季', cell: (r) => plain(F.pct(r.netMargin, 1)) },
    { key: 'epsTTM', label: '近四季 EPS', cell: (r) => h('span', { class: F.isNum(r.epsTTM) && r.epsTTM < 0 ? 'down' : '' }, F.num(r.epsTTM, 2)) },
    { key: 'period', label: '財報季', cell: (r) => plain(r.period || F.NA) },
  ];
}

const MAX_ROWS = 300;   // 條件全部清空時避免一次畫 2,000 列

/**
 * @param {object} o
 * @param {'tw'|'us'} [o.market]   us：S&P 500（us/screen.json）
 */
export function renderScreen(host, screen, { watchlist = [], onPick, market = 'tw', before = null, backtest = null }) {
  const us = market === 'us';
  const PRESETS = us ? US_PRESETS : TW_PRESETS;
  const all = toObjects(screen);
  const watch = new Set(watchlist);
  const cols = us ? usColumns(watch) : columns(watch);
  const saved = load(market);
  const state = { preset: saved.preset in PRESETS ? saved.preset : 'growth', values: saved.values || {}, sort: null };

  const criteriaOf = (p) => PRESETS[p].criteria.map((c) => ({ ...c, value: (state.values[p] ?? {})[c.key] !== undefined ? state.values[p][c.key] : c.value }));
  const tabs = h('div', { class: 'ov-tabs', role: 'group', 'aria-label': '選股類型' });
  const form = h('div', { class: 'screen-form' });
  const count = h('p', { class: 'screen-count' });
  const desc = h('p', { class: 'note' });
  const table = h('table', { class: 'ov' });

  const persist = () => save(market, { preset: state.preset, values: state.values });

  // 回測（只有台股）：backtest 是 Promise（背景載入 backtest.json），回來後依目前門檻畫
  const btHost = h('div', { class: 'bt-host' });
  let btPanel = null;
  let btChart = null;
  const drawBacktest = () => {
    if (!btPanel) return;
    btChart?.destroy?.();
    const { el, chart } = backtestView(btPanel, criteriaOf(state.preset), PRESETS[state.preset].label, onPick);
    btChart = chart;
    btHost.replaceChildren(el);
  };
  if (!us && backtest) {
    btHost.replaceChildren(h('p', { class: 'note' }, '載入回測資料中…'));
    Promise.resolve(backtest).then((p) => {
      if (!p?.dates?.length) { btHost.replaceChildren(h('p', { class: 'note' }, '回測資料尚未產生：下一次 GitHub Actions 更新後就會出現。')); return; }
      btPanel = p;
      drawBacktest();
    }, () => btHost.replaceChildren(h('p', { class: 'note' }, '回測資料載入失敗。')));
  }

  const drawTable = () => {
    const crit = criteriaOf(state.preset);
    const sort = state.sort ?? PRESETS[state.preset].sort;
    const hits = sortRows(applyScreen(all, crit), sort.key, sort.dir);
    count.replaceChildren(`符合 ${hits.length.toLocaleString()} 檔（${us ? 'S&P 500 等' : '全市場'} ${all.length.toLocaleString()} 檔）`,
      hits.length > MAX_ROWS ? `，顯示前 ${MAX_ROWS} 檔` : '');
    table.replaceChildren(
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', {
        scope: 'col', title: c.tip,
        'aria-sort': c.key === sort.key ? (sort.dir > 0 ? 'ascending' : 'descending') : null,
        on: { click: () => { state.sort = { key: c.key, dir: c.key === sort.key ? -sort.dir : (['code', 'industry', 'sector', 'period'].includes(c.key) ? 1 : -1) }; drawTable(); } },
      }, c.label)))),
      h('tbody', {}, hits.slice(0, MAX_ROWS).map((r) => h('tr', {
        dataset: { code: r.code }, title: `${r.code} ${r.name}`, on: { click: () => onPick(r.code) },
      }, cols.map((c) => h('td', {}, c.cell(r)))))),
    );
    if (!hits.length) table.append(h('tbody', {}, h('tr', {}, h('td', { colspan: String(cols.length), class: 'muted' }, '沒有符合條件的股票，請放寬門檻。'))));
    drawBacktest();
  };

  const drawForm = () => {
    const p = state.preset;
    desc.replaceChildren(PRESETS[p].desc);
    tabs.replaceChildren(...Object.entries(PRESETS).map(([k, v]) => h('button', {
      type: 'button', class: 'btn', 'aria-pressed': String(k === p),
      on: { click: () => { state.preset = k; state.sort = null; persist(); drawForm(); drawTable(); } },
    }, v.label)));
    form.replaceChildren(
      ...criteriaOf(p).map((c) => h('label', { class: 'crit' },
        h('span', { class: 't' }, c.label),
        h('span', { class: 'op' }, OP_TEXT[c.op]),
        h('input', {
          type: 'number', step: 'any', inputmode: 'decimal', value: F.isNum(c.value) ? String(c.value) : '',
          'aria-label': `${c.label} ${OP_TEXT[c.op]}`,
          on: {
            input: (e) => {
              const raw = e.target.value.trim();
              state.values[p] = { ...(state.values[p] ?? {}), [c.key]: raw === '' ? null : Number(raw) };
              persist();
              drawTable();
            },
          },
        }),
        h('span', { class: 'unit' }, c.unit))),
      h('button', {
        type: 'button', class: 'btn', on: { click: () => { delete state.values[p]; persist(); drawForm(); drawTable(); } },
      }, '恢復預設'),
    );
  };

  drawForm();
  drawTable();
  const a = screen?.asOf ?? {};
  // 新一季財報公布期間（季底後約 45 天）多數公司還沒有新資料：提醒可清空財報條件
  const withEps = all.filter((r) => F.isNum(r.eps)).length;
  const epsNote = !us && all.length && withEps < all.length / 2
    ? h('p', { class: 'banner warn' }, `財報公布期間：目前只有 ${withEps.toLocaleString()} 檔有最新財報（EPS、利益率），其餘顯示 N/A 並會被條件排除。`
      + '要納入全部股票，請清空「今年累計 EPS」與「營業利益率」兩個條件。')
    : null;
  const scope = us ? 'S&P 500' : '全市場';
  count.dataset.scope = scope;
  host.replaceChildren(h('section', { class: 'overview screen' },
    before,
    h('div', { class: 'overview-head' },
      h('h2', {}, us ? '美股選股（S&P 500）' : '全市場選股'),
      h('p', { class: 'note' }, us ? `股價 ${F.when(a.date)}；財報 ${a.income ?? F.NA}`
        : `收盤 ${F.when(a.twse)}；月營收 ${a.revenue ?? F.NA}；財報 ${a.income ?? F.NA}${a.holders ? `；集保 ${F.when(a.holders)}` : ''}`)),
    epsNote, tabs, desc, form, count,
    all.length ? h('div', { class: 'ov-wrap' }, table) : h('p', { class: 'note' }, '選股資料尚未產生：下一次 GitHub Actions 完整更新後就會出現。'),
    h('p', { class: 'note' }, us
      ? 'S&P 500 成分股與美股追蹤清單。財報來自美國證管會 SEC EDGAR（最新一季；第四季由全年減前三季推算），股價與配息來自 Yahoo Finance，每天更新一次。'
        + '條件留空代表不使用；缺資料的股票不會被選入。★ 表示已在美股追蹤清單。'
      : '上市、上櫃個股（不含 ETF），資料來自證交所與櫃買中心開放資料。條件留空代表不使用。缺資料的股票不會被選入。'
        + 'ROE 為推估值（股價淨值比 ÷ 本益比）；EPS 與利益率為今年累計至最新一季。★ 表示已在追蹤清單。'),
    h('p', { class: 'note' }, '這是依條件篩選的結果，不是買賣建議。'),
    us ? null : btHost));
  return () => btChart?.destroy?.();
}

/** 舊名稱（測試與外部程式使用） */
export const PRESETS = TW_PRESETS;
