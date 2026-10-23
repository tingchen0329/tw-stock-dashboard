/**
 * 追蹤清單總覽表
 *
 * 每檔一列、一眼比較：股價、走勢、估值位階、成長、籌碼、技術。點欄位標題排序，點列開啟個股。
 * 資料來自 overview.json（scripts/build_overview.mjs 在 GitHub Actions 用 analytics.js 預先算好），
 * 所以這裡只負責顯示，不做計算。
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

/** 60 日走勢小圖：漲跌用台股紅綠，終點加圓點標出方向（色盲也能讀） */
function spark(values) {
  const v = (values || []).filter(F.isNum);
  if (v.length < 2) return h('span', { class: 'muted' }, 'N/A');
  const W = 88, H = 24, lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * W).toFixed(1)},${(H - 2 - ((y - lo) / span) * (H - 4)).toFixed(1)}`);
  const [lx, ly] = pts[pts.length - 1].split(',');
  return svg('svg', { class: `spark ${F.dir(v[v.length - 1] - v[0])}`, viewBox: `0 0 ${W + 3} ${H}`, width: W + 3, height: H, 'aria-hidden': 'true' },
    svg('polyline', { points: pts.join(' '), fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linejoin': 'round' }),
    svg('circle', { cx: lx, cy: ly, r: '2.2', fill: 'currentColor' }));
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

const signedPct = (v) => (F.isNum(v) ? h('span', { class: `num ${F.dir(v)}` }, F.pct(v, 1, true)) : h('span', { class: 'muted' }, 'N/A'));
const lots = (v) => (F.isNum(v) ? h('span', { class: `num ${F.dir(v)}` }, F.lots(v)) : h('span', { class: 'muted' }, 'N/A'));
const plain = (text) => h('span', { class: text === F.NA ? 'muted' : '' }, text);
const TREND = { 1: ['多頭', 'up'], '-1': ['空頭', 'down'], 0: ['糾結', 'flat'] };

/** 欄位定義：key 用來排序（sort: false 不可排序），tip 是滑鼠提示，cell 產生內容 */
export const COLUMNS = [
  { key: 'code', label: '股票', cell: (r) => [h('b', {}, r.code), h('span', { class: 'name' }, r.name)] },
  {
    key: 'chgPct', label: '股價', tip: '盤中為 Yahoo 報價（約延遲 20 分鐘），收盤後為證交所 / 櫃買收盤價',
    cell: (r) => [h('span', { class: 'px' }, F.price(r.price)),
      h('span', { class: `num ${F.dir(r.chgPct)} sub` }, F.isNum(r.chgPct) ? `${r.chgPct > 0 ? '▲' : r.chgPct < 0 ? '▼' : ''}${F.pct(r.chgPct, 2, true)}` : 'N/A')],
  },
  { key: 'spark', label: '60日走勢', sort: false, cell: (r) => spark(r.spark) },
  { key: 'r20', label: '20日', tip: '近 20 個交易日漲跌幅', cell: (r) => signedPct(r.r20) },
  { key: 'pe', label: '本益比', cell: (r) => plain(F.num(r.pe, 1)) },
  { key: 'riverPct', label: '河流圖位階', tip: '目前本益比在近三年的百分位：0 最便宜、100 最貴', cell: (r) => riverMeter(r.riverPct, r.zone) },
  { key: 'revYoY', label: '營收年增', tip: '最新月營收年增率', cell: (r) => signedPct(r.revYoY) },
  { key: 'epsYoY', label: 'EPS 年增', tip: '近四季 EPS 年增率', cell: (r) => signedPct(r.epsYoY) },
  { key: 'roe', label: 'ROE', tip: '近四季股東權益報酬率', cell: (r) => plain(F.pct(r.roe, 1)) },
  { key: 'f20', label: '外資 20日', tip: '近 20 日外資買賣超（張）', cell: (r) => lots(r.f20) },
  { key: 't20', label: '投信 20日', tip: '近 20 日投信買賣超（張）', cell: (r) => lots(r.t20) },
  {
    key: 'trend', label: '均線', tip: '多頭：MA5 > MA20 > MA60 > MA240；空頭相反；其餘為糾結',
    cell: (r) => { const [t, c] = TREND[r.trend] ?? [F.NA, 'muted']; return h('span', { class: c }, t); },
  },
  { key: 'k', label: 'K', tip: 'KD(9) 的 K 值；≥ 80 過熱、≤ 20 超賣', cell: (r) => h('span', { class: r.k >= 80 ? 'hot' : r.k <= 20 ? 'cold' : '' }, F.num(r.k, 0)) },
  { key: 'rsi', label: 'RSI', tip: 'RSI(14)；≥ 70 過熱、≤ 30 超賣', cell: (r) => h('span', { class: r.rsi >= 70 ? 'hot' : r.rsi <= 30 ? 'cold' : '' }, F.num(r.rsi, 0)) },
];

/** 排序：缺值永遠排最後；sort.key === null 代表維持清單原順序（Yahoo 自選股的順序） */
export function sortRows(rows, key, dir) {
  if (!key) return [...rows];
  const missing = (x) => x === null || x === undefined || Number.isNaN(x);
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    if (missing(x) || missing(y)) return missing(x) - missing(y);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

export const FILTERS = [
  ['all', '全部', () => true],
  ['stock', '個股', (r) => !r.etf],
  ['etf', 'ETF', (r) => r.etf],
];

// 排序與篩選在切換到個股再回來時保留（只存在記憶體，重新整理頁面會回到預設）
const view = { sort: { key: null, dir: 1 }, filter: 'all' };

export function renderOverview(host, data, { onPick }) {
  const all = data?.rows ?? [];
  const table = h('table', { class: 'ov' });
  const tabs = h('div', { class: 'ov-tabs', role: 'group', 'aria-label': '篩選' });
  const draw = () => {
    const test = FILTERS.find(([k]) => k === view.filter)?.[2] ?? (() => true);
    const rows = sortRows(all.filter(test), view.sort.key, view.sort.dir);
    tabs.replaceChildren(...FILTERS.map(([k, label, fn]) => h('button', {
      type: 'button', class: 'btn', 'aria-pressed': String(view.filter === k),
      on: { click: () => { view.filter = k; draw(); } },
    }, `${label} ${all.filter(fn).length}`)));
    table.replaceChildren(
      h('thead', {}, h('tr', {}, COLUMNS.map((c) => h('th', {
        scope: 'col',
        title: c.tip,
        class: c.sort === false ? 'nosort' : '',
        'aria-sort': c.sort !== false && c.key === view.sort.key ? (view.sort.dir > 0 ? 'ascending' : 'descending') : null,
        on: c.sort === false ? {} : {
          click: () => {
            // 第一次點：數字欄由大到小、代號由小到大；再點反向；第三次回到清單原順序
            const first = c.key === 'code' ? 1 : -1;
            view.sort = view.sort.key !== c.key ? { key: c.key, dir: first }
              : view.sort.dir === first ? { key: c.key, dir: -first } : { key: null, dir: 1 };
            draw();
          },
        },
      }, c.label)))),
      h('tbody', {}, rows.map((r) => h('tr', {
        dataset: { code: r.code },
        title: `${r.code} ${r.name}${r.industry ? `｜${r.industry}` : ''}`,
        on: { click: () => onPick(r.code) },
      }, COLUMNS.map((c) => h('td', {}, c.cell(r)))))),
    );
  };
  draw();
  host.replaceChildren(h('section', { class: 'overview' },
    h('div', { class: 'overview-head' },
      h('h2', {}, `追蹤清單總覽（${all.length} 檔）`),
      h('p', { class: 'note' }, `${data?.dataDay ? `${F.dayLabel(data.dataDay)}收盤資料；` : ''}點欄位標題排序，點一列開啟個股`)),
    tabs,
    all.length
      ? h('div', { class: 'ov-wrap' }, table)
      : h('p', { class: 'note' }, '總覽資料尚未產生：下一次 GitHub Actions 更新後就會出現。'),
    h('p', { class: 'note' }, '河流圖位階 = 目前本益比在近三年的百分位（0 最便宜、100 最貴）。K ≥ 80 / RSI ≥ 70 標示為過熱，K ≤ 20 / RSI ≤ 30 為超賣。ETF 沒有本益比、營收與財報，顯示 N/A。')));
}
