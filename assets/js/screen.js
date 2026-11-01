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

/** 預設條件。op：'>=' 至少、'<=' 至多、'>' 大於。value 清空代表不使用該條件 */
export const PRESETS = {
  growth: {
    label: '成長型',
    desc: '營收與獲利同步成長、本業賺錢，估值不過熱',
    sort: { key: 'revCumYoY', dir: -1 },
    criteria: [
      { key: 'revYoY', op: '>=', value: 20, label: '月營收年增', unit: '%' },
      { key: 'revCumYoY', op: '>=', value: 15, label: '今年累計營收年增', unit: '%' },
      { key: 'eps', op: '>', value: 0, label: '今年累計 EPS', unit: '元' },
      { key: 'om', op: '>=', value: 5, label: '營業利益率', unit: '%' },
      { key: 'roe', op: '>=', value: 12, label: 'ROE（推估）', unit: '%' },
      { key: 'pe', op: '<=', value: 35, label: '本益比', unit: '倍' },
      { key: 'volume', op: '>=', value: 500, label: '成交量', unit: '張' },
    ],
  },
  yield: {
    label: '殖利率型',
    desc: '高殖利率、仍在獲利、營收沒有明顯衰退，估值偏低',
    sort: { key: 'yield', dir: -1 },
    criteria: [
      { key: 'yield', op: '>=', value: 5, label: '殖利率', unit: '%' },
      { key: 'eps', op: '>', value: 0, label: '今年累計 EPS', unit: '元' },
      { key: 'roe', op: '>=', value: 8, label: 'ROE（推估）', unit: '%' },
      { key: 'pe', op: '<=', value: 18, label: '本益比', unit: '倍' },
      { key: 'revCumYoY', op: '>=', value: -10, label: '今年累計營收年增', unit: '%' },
      { key: 'volume', op: '>=', value: 300, label: '成交量', unit: '張' },
    ],
  },
};

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

const STORE = 'screen:v1';
const load = () => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } };
const save = (o) => { try { localStorage.setItem(STORE, JSON.stringify(o)); } catch { /* 無痕模式等：不記也能用 */ } };

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
  ];
}

const MAX_ROWS = 300;   // 條件全部清空時避免一次畫 2,000 列

export function renderScreen(host, screen, { watchlist = [], onPick }) {
  const all = toObjects(screen);
  const watch = new Set(watchlist);
  const cols = columns(watch);
  const saved = load();
  const state = { preset: saved.preset in PRESETS ? saved.preset : 'growth', values: saved.values || {}, sort: null };

  const criteriaOf = (p) => PRESETS[p].criteria.map((c) => ({ ...c, value: (state.values[p] ?? {})[c.key] !== undefined ? state.values[p][c.key] : c.value }));
  const tabs = h('div', { class: 'ov-tabs', role: 'group', 'aria-label': '選股類型' });
  const form = h('div', { class: 'screen-form' });
  const count = h('p', { class: 'screen-count' });
  const desc = h('p', { class: 'note' });
  const table = h('table', { class: 'ov' });

  const persist = () => save({ preset: state.preset, values: state.values });

  const drawTable = () => {
    const crit = criteriaOf(state.preset);
    const sort = state.sort ?? PRESETS[state.preset].sort;
    const hits = sortRows(applyScreen(all, crit), sort.key, sort.dir);
    count.replaceChildren(`符合 ${hits.length.toLocaleString()} 檔（全市場 ${all.length.toLocaleString()} 檔）`,
      hits.length > MAX_ROWS ? `，顯示前 ${MAX_ROWS} 檔` : '');
    table.replaceChildren(
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', {
        scope: 'col', title: c.tip,
        'aria-sort': c.key === sort.key ? (sort.dir > 0 ? 'ascending' : 'descending') : null,
        on: { click: () => { state.sort = { key: c.key, dir: c.key === sort.key ? -sort.dir : (c.key === 'code' || c.key === 'industry' ? 1 : -1) }; drawTable(); } },
      }, c.label)))),
      h('tbody', {}, hits.slice(0, MAX_ROWS).map((r) => h('tr', {
        dataset: { code: r.code }, title: `${r.code} ${r.name}`, on: { click: () => onPick(r.code) },
      }, cols.map((c) => h('td', {}, c.cell(r)))))),
    );
    if (!hits.length) table.append(h('tbody', {}, h('tr', {}, h('td', { colspan: String(cols.length), class: 'muted' }, '沒有符合條件的股票，請放寬門檻。'))));
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
  const epsNote = all.length && withEps < all.length / 2
    ? h('p', { class: 'banner warn' }, `財報公布期間：目前只有 ${withEps.toLocaleString()} 檔有最新財報（EPS、利益率），其餘顯示 N/A 並會被條件排除。`
      + '要納入全部股票，請清空「今年累計 EPS」與「營業利益率」兩個條件。')
    : null;
  host.replaceChildren(h('section', { class: 'overview screen' },
    h('div', { class: 'overview-head' },
      h('h2', {}, '全市場選股'),
      h('p', { class: 'note' }, `收盤 ${F.when(a.twse)}；月營收 ${a.revenue ?? F.NA}；財報 ${a.income ?? F.NA}`)),
    epsNote, tabs, desc, form, count,
    all.length ? h('div', { class: 'ov-wrap' }, table) : h('p', { class: 'note' }, '選股資料尚未產生：下一次 GitHub Actions 更新後就會出現。'),
    h('p', { class: 'note' }, '上市、上櫃個股（不含 ETF），資料來自證交所與櫃買中心開放資料。條件留空代表不使用。缺資料的股票不會被選入。'
      + 'ROE 為推估值（股價淨值比 ÷ 本益比）；EPS 與利益率為今年累計至最新一季。★ 表示已在追蹤清單。'),
    h('p', { class: 'note' }, '這是依條件篩選的結果，不是買賣建議。')));
}
