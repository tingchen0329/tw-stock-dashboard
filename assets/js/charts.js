/**
 * 輕量 SVG 圖表（不載入任何圖表函式庫，整個檔案約 8 KB）
 *
 *  lineChart  折線（股價 + 均線）、可加區帶（本益比河流圖）
 *  barChart   正負長條（月營收年增率），以 0 為基準線
 *  tableView  每張圖附「表格檢視」，不靠滑鼠也讀得到每個數字（無障礙）
 *
 * 互動：滑鼠移動 → 十字線對齊最近的日期；鍵盤 ←/→/Home/End 也能操作（先 Tab 到圖上）
 * 安全：所有文字用 textContent 寫入，不用 innerHTML
 * 效能：寬度改變時用 ResizeObserver + requestAnimationFrame 重畫，不輪詢
 */

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function div(cls, parent, text) {
  const e = document.createElement('div');
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** 好讀的刻度：1、2、2.5、5 × 10^n */
export function niceTicks(min, max, count = 5) {
  if (!(Number.isFinite(min) && Number.isFinite(max))) return [];
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => raw <= s);
  // 第一個刻度往下取整、最後一個往上取整 → 刻度範圍一定涵蓋所有資料（線條不會超出圖框）
  const ticks = [];
  const end = Math.ceil(max / step - 1e-9) * step;
  for (let t = Math.floor(min / step + 1e-9) * step; t <= end + step * 1e-9; t += step) ticks.push(+t.toFixed(10));
  return ticks;
}

/** 依容器寬度重畫；回傳 { update(opts), destroy() } */
function responsive(host, draw) {
  let opts = null;
  let frame = 0;
  let lastW = 0;
  const redraw = () => {
    frame = 0;
    const w = Math.round(host.clientWidth);
    if (!w || !opts) return;
    lastW = w;
    draw(w, opts);
  };
  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => { if (Math.round(host.clientWidth) !== lastW && !frame) frame = requestAnimationFrame(redraw); })
    : null;
  ro?.observe(host);
  return {
    update(o) { opts = o; redraw(); },
    destroy() { ro?.disconnect(); host.replaceChildren(); },
  };
}

function tooltip(host) {
  const tip = div('tooltip', host);
  tip.hidden = true;
  return {
    show(x, y, head, rowsArr, width) {
      tip.replaceChildren();
      div('h', tip, head);
      for (const r of rowsArr) {
        const row = div('r', tip);
        if (r.color) { const i = document.createElement('i'); i.style.background = r.color; row.appendChild(i); }
        const b = document.createElement('b'); b.textContent = r.value; row.appendChild(b);
        const s = document.createElement('span'); s.textContent = r.label; row.appendChild(s);
      }
      tip.hidden = false;
      const tw = tip.offsetWidth;
      const left = x + 14 + tw > width ? x - 14 - tw : x + 14;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, y - 10)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

/** 依時間跨度挑 x 軸日期標籤 */
function dateLabel(d, spanDays) {
  return spanDays > 120 ? `${d.slice(2, 4)}/${d.slice(5, 7)}` : d.slice(5).replace('-', '/');
}

/**
 * 折線圖
 * @param {HTMLElement} host
 * @returns {{update(opts), destroy()}}
 * opts: {
 *   dates: string[],
 *   series: [{ name, values:number[], color:'var(--s1)', endLabel?:boolean }],
 *   bands?: [{ lower:number[], upper:number[], fill:'var(--band-1)' }],
 *   bandLabels?: [{ values:number[], text:string }],   右側標示（例：河流圖倍數）
 *   height?: number, fmt: (v)=>string, axisFmt: (v)=>string, ariaLabel: string
 * }
 */
export function lineChart(host) {
  host.classList.add('chart');
  let tip;
  return responsive(host, (W, o) => {
    host.replaceChildren();
    tip = tooltip(host);
    const H = o.height ?? 260;
    const m = { l: 52, r: o.bandLabels ? 58 : 64, t: 10, b: 24 };
    const n = o.dates.length;
    if (n < 2) { div('note', host, '資料不足，無法繪圖'); return; }

    // y 範圍：所有系列 + 區帶
    let lo = Infinity;
    let hi = -Infinity;
    const scan = (arr) => { for (const v of arr) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    o.series.forEach((s) => scan(s.values));
    (o.bands || []).forEach((b) => { scan(b.lower); scan(b.upper); });
    const pad = (hi - lo) * 0.05 || 1;
    // 股價不會是負的：資料全為正時，留白不可把座標推到 0 以下（舊版河流圖出現 -2,000 的刻度）
    const ticks = niceTicks(lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi + pad, 5);
    const y0 = ticks[0];
    const y1 = ticks[ticks.length - 1];
    const x = (i) => m.l + (i / (n - 1)) * (W - m.l - m.r);
    const y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', tabindex: 0, 'aria-label': o.ariaLabel || '' }, host);

    // 格線與 y 軸刻度
    for (const t of ticks) {
      el('line', { class: 'grid-line', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }, svg);
      el('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, svg).textContent = o.axisFmt(t);
    }
    // x 軸日期（約 5 個）
    const span = (Date.parse(o.dates[n - 1]) - Date.parse(o.dates[0])) / 864e5;
    const every = Math.ceil(n / Math.max(2, Math.floor((W - m.l - m.r) / 90)));
    for (let i = 0; i < n; i += every) {
      el('text', { x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : 'middle' }, svg).textContent = dateLabel(o.dates[i], span);
    }
    el('line', { class: 'axis-line', x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b }, svg);

    // 區帶（河流圖）：上緣正向 + 下緣反向 → 封閉多邊形
    for (const b of o.bands || []) {
      let d = '';
      for (let i = 0; i < n; i++) if (Number.isFinite(b.upper[i])) d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(b.upper[i]).toFixed(1)}`;
      for (let i = n - 1; i >= 0; i--) if (Number.isFinite(b.lower[i])) d += `L${x(i).toFixed(1)},${y(b.lower[i]).toFixed(1)}`;
      if (d) el('path', { d: d + 'Z', fill: b.fill, stroke: 'none' }, svg);
    }
    for (const bl of o.bandLabels || []) {
      const lastV = [...bl.values].reverse().find(Number.isFinite);
      if (Number.isFinite(lastV)) el('text', { x: W - m.r + 6, y: y(lastV) + 4, class: 'end-label' }, svg).textContent = bl.text;
    }

    // 折線：遇到 null 就斷開（例如 MA60 前 59 天）
    for (const s of o.series) {
      let d = '';
      let pen = false;
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v)) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width ?? 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
      if (s.endLabel) {
        const i = s.values.length - 1;
        if (Number.isFinite(s.values[i])) {
          el('circle', { cx: x(i), cy: y(s.values[i]), r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
          el('text', { x: x(i) + 8, y: y(s.values[i]) + 4, class: 'end-label' }, svg).textContent = o.fmt(s.values[i]);
        }
      }
    }

    // 十字線 + 提示框
    const cross = el('line', { class: 'crosshair', y1: m.t, y2: H - m.b, visibility: 'hidden' }, svg);
    const dots = o.series.map((s) => el('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }, svg));
    const hit = el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' }, svg);
    let cur = -1;
    const show = (i) => {
      cur = Math.max(0, Math.min(n - 1, i));
      cross.setAttribute('x1', x(cur)); cross.setAttribute('x2', x(cur)); cross.setAttribute('visibility', 'visible');
      const rowsArr = [];
      o.series.forEach((s, k) => {
        const v = s.values[cur];
        if (Number.isFinite(v)) {
          dots[k].setAttribute('cx', x(cur)); dots[k].setAttribute('cy', y(v)); dots[k].setAttribute('visibility', 'visible');
          rowsArr.push({ color: s.color, value: o.fmt(v), label: s.name });
        } else dots[k].setAttribute('visibility', 'hidden');
      });
      const scale = host.clientWidth / W || 1;
      tip.show(x(cur) * scale, m.t, o.dates[cur], rowsArr, host.clientWidth);
    };
    const hide = () => { cur = -1; cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); tip.hide(); };
    hit.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      show(Math.round(((px - m.l) / (W - m.l - m.r)) * (n - 1)));
    });
    hit.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => show(n - 1));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 20 : 1;
      const map = { ArrowLeft: cur - step, ArrowRight: cur + step, Home: 0, End: n - 1 };
      if (e.key in map) { e.preventDefault(); show(map[e.key]); } else if (e.key === 'Escape') hide();
    });
  });
}

/**
 * 正負長條圖（以 0 為基準）
 * opts: { labels, values, colorFor:(v)=>css, fmt, axisFmt, tipRows:(i)=>[{label,value}], ariaLabel, height }
 */
export function barChart(host) {
  host.classList.add('chart');
  let tip;
  return responsive(host, (W, o) => {
    host.replaceChildren();
    tip = tooltip(host);
    const H = o.height ?? 220;
    const m = { l: 46, r: 12, t: 18, b: 24 };
    const n = o.values.length;
    if (!n) { div('note', host, '資料不足'); return; }
    const vals = o.values.map((v) => (Number.isFinite(v) ? v : 0));
    const ticks = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), 4);
    const y0 = ticks[0];
    const y1 = ticks[ticks.length - 1];
    const y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
    const slot = (W - m.l - m.r) / n;
    const bw = Math.min(24, slot * 0.62);
    const cx = (i) => m.l + slot * (i + 0.5);

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', tabindex: 0, 'aria-label': o.ariaLabel || '' }, host);
    for (const t of ticks) {
      el('line', { class: t === 0 ? 'axis-line' : 'grid-line', x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }, svg);
      el('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, svg).textContent = o.axisFmt(t);
    }
    const labelEvery = slot < 34 ? 2 : 1;
    const bars = [];
    o.values.forEach((v, i) => {
      if (i % labelEvery === (n - 1) % labelEvery) {
        el('text', { x: cx(i), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = o.labels[i];
      }
      if (!Number.isFinite(v)) return;
      // 遠離基準線的一端做 4px 圓角，基準線那端保持直角
      const top = y(Math.max(v, 0));
      const bot = y(Math.min(v, 0));
      const h = Math.max(1, bot - top);
      const r = Math.min(4, h / 2, bw / 2);
      const xl = cx(i) - bw / 2;
      const xr = cx(i) + bw / 2;
      const d = v >= 0
        ? `M${xl},${bot}V${top + r}Q${xl},${top} ${xl + r},${top}H${xr - r}Q${xr},${top} ${xr},${top + r}V${bot}Z`
        : `M${xl},${top}V${bot - r}Q${xl},${bot} ${xl + r},${bot}H${xr - r}Q${xr},${bot} ${xr},${bot - r}V${top}Z`;
      bars[i] = el('path', { d, fill: o.colorFor(v) }, svg);
    });
    // 只標最後一根（最新月份）的數值
    const li = n - 1;
    if (Number.isFinite(o.values[li])) {
      const v = o.values[li];
      el('text', { x: cx(li), y: v >= 0 ? y(v) - 5 : y(v) + 13, 'text-anchor': 'middle', class: 'end-label' }, svg).textContent = o.fmt(v);
    }

    let cur = -1;
    const show = (i) => {
      cur = Math.max(0, Math.min(n - 1, i));
      bars.forEach((b, k) => b && b.setAttribute('opacity', k === cur ? 1 : 0.55));
      const scale = host.clientWidth / W || 1;
      tip.show(cx(cur) * scale, m.t, o.labels[cur], o.tipRows(cur), host.clientWidth);
    };
    const hide = () => { cur = -1; bars.forEach((b) => b && b.removeAttribute('opacity')); tip.hide(); };
    // 命中區 = 整個欄位寬度與高度（比長條本身大，好點選）
    for (let i = 0; i < n; i++) {
      const r = el('rect', { x: m.l + slot * i, y: m.t, width: slot, height: H - m.t - m.b, fill: 'transparent' }, svg);
      r.addEventListener('pointerenter', () => show(i));
    }
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => show(n - 1));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      const map = { ArrowLeft: cur - 1, ArrowRight: cur + 1, Home: 0, End: n - 1 };
      if (e.key in map) { e.preventDefault(); show(map[e.key]); } else if (e.key === 'Escape') hide();
    });
  });
}

/** 圖表下方的「表格檢視」 */
export function tableView(headers, rowsArr, { maxRows = 400, label = '表格檢視' } = {}) {
  const d = document.createElement('details');
  d.className = 'table-view';
  const s = document.createElement('summary');
  s.textContent = label;
  d.appendChild(s);
  const wrap = div('scroll', d);
  const t = document.createElement('table');
  const thead = t.createTHead().insertRow();
  headers.forEach((h) => { const th = document.createElement('th'); th.textContent = h; thead.appendChild(th); });
  const tb = t.createTBody();
  // 最新的在最上面；預設收合，展開時才付出 DOM 成本
  d.addEventListener('toggle', () => {
    if (!d.open || tb.rows.length) return;
    for (const r of rowsArr.slice(-maxRows).reverse()) {
      const tr = tb.insertRow();
      r.forEach((c) => { tr.insertCell().textContent = c; });
    }
  });
  wrap.appendChild(t);
  return d;
}
