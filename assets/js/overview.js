/**
 * 追蹤清單總覽表（模擬版 / mockup）
 *
 * 每檔一列、一眼比較：股價、走勢、估值位階、成長、籌碼、技術。點欄位標題排序，點列開啟個股。
 * 資料直接用 summarize() 的結果（與個股頁同一套計算），不另外寫公式。
 */
import * as F from './format.js';
import { h } from './render.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

/** summarize() 結果 → 總覽表一列（純資料，可測試） */
export function overviewRow(s) {
  const t = s.tech;
  const f = s.fundamentals;
  const align = t?.alignment ?? '';
  return {
    code: s.info.code,
    name: s.info.name,
    price: s.price?.price ?? null,
    chgPct: s.price?.changePct ?? null,
    spark: (s.series?.close ?? []).slice(-60),
    r20: t?.returns?.d20 ?? null,
    pe: s.valuation?.pe ?? null,
    riverPct: s.river?.percentile ?? null,
    zone: s.river?.zone ?? null,
    revYoY: s.revenue?.latest?.yoy ?? null,
    epsYoY: f?.eps4YoY ?? null,
    roe: f?.roe ?? null,
    f20: s.inst?.sum20?.foreign ?? null,
    t20: s.inst?.sum20?.trust ?? null,
    trend: align.startsWith('多頭') ? 1 : align.startsWith('空頭') ? -1 : align === '均線糾結' ? 0 : null,
    k: t?.k ?? null,
    rsi: t?.rsi ?? null,
  };
}

/** 60 日走勢小圖：漲跌用台股紅綠，另有起訖點讓色盲也能讀方向 */
function spark(values) {
  const v = values.filter(F.isNum);
  if (v.length < 2) return h('span', { class: 'muted' }, 'N/A');
  const W = 88, H = 24, lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * W).toFixed(1)},${(H - 2 - ((y - lo) / span) * (H - 4)).toFixed(1)}`);
  const last = pts[pts.length - 1].split(',');
  return svg('svg', { class: `spark ${F.dir(v[v.length - 1] - v[0])}`, viewBox: `0 0 ${W + 3} ${H}`, width: W + 3, height: H, 'aria-hidden': 'true' },
    svg('polyline', { points: pts.join(' '), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round' }),
    svg('circle', { cx: last[0], cy: last[1], r: '2.2', fill: 'currentColor' }));
}

/** 河流圖位階：0–100 百分位的小刻度條 + 區間文字 */
function riverMeter(pct, zone) {
  if (!F.isNum(pct)) return h('span', { class: 'muted' }, 'N/A');
  const W = 56;
  return h('span', { class: 'meter' },
    svg('svg', { viewBox: `0 0 ${W} 10`, width: W, height: 10, 'aria-hidden': 'true' },
      svg('rect', { x: 0, y: 4, width: W, height: 2, rx: 1, class: 'track' }),
      ...[0.25, 0.5, 0.75].map((q) => svg('rect', { x: W * q - 0.5, y: 2, width: 1, height: 6, class: 'tick' })),
      svg('circle', { cx: Math.max(4, Math.min(W - 4, (pct / 100) * W)), cy: 5, r: 4, class: `dot z-${zone}` })),
    h('span', {}, `${zone} ${F.num(pct, 0)}`));
}

const signedPct = (v) => h('span', { class: `num ${F.dir(v)}` }, F.pct(v, 1, true));
const lots = (v) => h('span', { class: `num ${F.dir(v)}` }, F.lots(v));
const trendText = { 1: ['多頭', 'up'], '-1': ['空頭', 'down'], 0: ['糾結', 'flat'] };

/** 欄位定義：key 用來排序，cell 產生內容 */
export const COLUMNS = [
  { key: 'code', label: '股票', sort: (r) => r.code, cell: (r) => [h('b', {}, r.code), h('span', { class: 'name' }, r.name)] },
  { key: 'chgPct', label: '股價', cell: (r) => [h('span', { class: 'px' }, F.price(r.price)), h('span', { class: `num ${F.dir(r.chgPct)} sub` }, F.isNum(r.chgPct) ? `${r.chgPct > 0 ? '▲' : r.chgPct < 0 ? '▼' : ''}${F.pct(r.chgPct, 2, true)}` : 'N/A')] },
  { key: 'r20', label: '60日走勢', sort: null, cell: (r) => spark(r.spark) },
  { key: 'r20', label: '20日', cell: (r) => signedPct(r.r20) },
  { key: 'pe', label: '本益比', cell: (r) => F.num(r.pe, 1) },
  { key: 'riverPct', label: '河流圖位階', cell: (r) => riverMeter(r.riverPct, r.zone) },
  { key: 'revYoY', label: '營收年增', cell: (r) => signedPct(r.revYoY) },
  { key: 'epsYoY', label: 'EPS 年增', cell: (r) => signedPct(r.epsYoY) },
  { key: 'roe', label: 'ROE', cell: (r) => F.pct(r.roe, 1) },
  { key: 'f20', label: '外資 20日', cell: (r) => lots(r.f20) },
  { key: 't20', label: '投信 20日', cell: (r) => lots(r.t20) },
  { key: 'trend', label: '均線', cell: (r) => { const [t, c] = trendText[r.trend] ?? ['N/A', 'muted']; return h('span', { class: c }, t); } },
  { key: 'k', label: 'K', cell: (r) => h('span', { class: r.k >= 80 ? 'hot' : r.k <= 20 ? 'cold' : '' }, F.num(r.k, 0)) },
  { key: 'rsi', label: 'RSI', cell: (r) => h('span', { class: r.rsi >= 70 ? 'hot' : r.rsi <= 30 ? 'cold' : '' }, F.num(r.rsi, 0)) },
];

/** 排序：缺值永遠排最後 */
export function sortRows(rows, key, dir) {
  const col = COLUMNS.find((c) => c.key === key && c.sort !== null);
  const val = col?.sort ?? ((r) => r[key]);
  return [...rows].sort((a, b) => {
    const x = val(a), y = val(b);
    const nx = x === null || x === undefined || Number.isNaN(x), ny = y === null || y === undefined || Number.isNaN(y);
    if (nx || ny) return nx - ny;
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

export function renderOverview(host, rows, { onPick, loading = 0, dataDay }) {
  let sort = { key: 'code', dir: 1 };
  const table = h('table', { class: 'ov' });
  const draw = () => {
    const sorted = sortRows(rows, sort.key, sort.dir);
    table.replaceChildren(
      h('thead', {}, h('tr', {}, COLUMNS.map((c) => h('th', {
        scope: 'col',
        class: c.sort === null ? 'nosort' : '',
        'aria-sort': c.sort !== null && c.key === sort.key ? (sort.dir > 0 ? 'ascending' : 'descending') : null,
        on: c.sort === null ? {} : { click: () => { sort = { key: c.key, dir: sort.key === c.key ? -sort.dir : c.key === 'code' ? 1 : -1 }; draw(); } },
      }, c.label)))),
      h('tbody', {}, sorted.map((r) => h('tr', { on: { click: () => onPick(r.code) }, title: `開啟 ${r.code} ${r.name}` },
        COLUMNS.map((c) => h('td', {}, c.cell(r)))))),
    );
  };
  draw();
  host.replaceChildren(h('section', { class: 'overview' },
    h('div', { class: 'overview-head' },
      h('h2', {}, `追蹤清單總覽（${rows.length} 檔）`),
      h('p', { class: 'note' }, `${dataDay ? `${F.dayLabel(dataDay)}收盤；` : ''}點欄位標題排序，點一列開啟個股${loading ? `；載入中 ${loading} 檔…` : ''}`)),
    h('div', { class: 'ov-wrap' }, table),
    h('p', { class: 'note' }, '河流圖位階 = 目前本益比在近三年的百分位（0 最便宜、100 最貴）。K ≥ 80 / RSI ≥ 70 標示為過熱，K ≤ 20 / RSI ≤ 30 為超賣。')));
}
