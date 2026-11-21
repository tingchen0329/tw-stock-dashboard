/**
 * K 線圖（TradingView Lightweight Charts™ 5，Apache 2.0，放在 assets/vendor/，見該資料夾 README）
 *
 *   上方：K 線（開高低收）＋ MA20、MA60
 *   下方：成交量（漲紅跌綠，與台股習慣相同）
 *   游標移到任一天：上方圖例顯示當天的開高低收、漲跌、成交量
 *
 * 顏色一律讀 CSS 變數（--up、--down、--s2…），深色模式自動跟著變。
 * 圖上的 TradingView 標誌會插入行內 <style>，被本站的內容安全政策擋下 → 關閉，
 * 改由呼叫端在圖下方顯示文字姓名標示（render.js 的 klineCredit()）。
 */
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, CrosshairMode, ColorType }
  from '../vendor/lightweight-charts/lightweight-charts.standalone.production.mjs';

const css = (name, fallback) => {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; }
};

/** #rrggbb → rgba(r,g,b,a)；不是 hex 就原樣回傳 */
function alpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {HTMLElement} host   圖表容器（高度由 CSS .kline 決定）
 * @param {HTMLElement} legend 圖例（游標所在日的數字，textContent 寫入）
 * @param {{fmt:(v)=>string, volFmt:(v)=>string}} opt
 * @returns {{update(d), destroy()}}
 */
export function klineChart(host, legend, { fmt, volFmt }) {
  const up = css('--up', '#c42b2b');
  const down = css('--down', '#0e7a73');
  const ink = css('--ink-2', '#4b5768');
  const hair = css('--hair', '#dde2ea');
  const chart = createChart(host, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: 'transparent' },
      textColor: ink,
      fontSize: 11,
      fontFamily: getComputedStyle(document.body).fontFamily,
      attributionLogo: false,
      panes: { separatorColor: hair, separatorHoverColor: alpha(css('--s1', '#2a78d6'), 0.2), enableResize: true },
    },
    grid: { vertLines: { color: alpha(hair, 0.6) || hair }, horzLines: { color: alpha(hair, 0.6) || hair } },
    rightPriceScale: { borderColor: hair },
    timeScale: { borderColor: hair, rightOffset: 3, minBarSpacing: 1 },
    crosshair: { mode: CrosshairMode.Normal },
    // 不用 localization.priceFormatter：它會套到所有座標軸（成交量軸也變成股價格式）；改在各序列設定
    localization: { locale: 'zh-TW', dateFormat: 'yyyy/MM/dd' },
    handleScroll: { vertTouchDrag: false },        // 手機上下滑動捲頁面，不拖圖
  });
  const candles = chart.addSeries(CandlestickSeries, {
    upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
    priceLineVisible: false, priceFormat: { type: 'custom', formatter: fmt, minMove: 0.01 },
  });
  const line = (color) => chart.addSeries(LineSeries, {
    color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    priceFormat: { type: 'custom', formatter: fmt, minMove: 0.01 },
  });
  const ma20 = line(css('--s2', '#eb6834'));
  const ma60 = line(css('--s3', '#1baf7a'));
  const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: 'custom', formatter: volFmt }, priceLineVisible: false, lastValueVisible: false }, 1);
  try { chart.panes()[1]?.setHeight(70); } catch { /* 舊版沒有 panes API：成交量與 K 線同一區 */ }

  let byTime = new Map();
  let lastBar = null;
  const writeLegend = (bar) => {
    if (!bar) { legend.textContent = ''; return; }
    const chg = isNum(bar.prev) && bar.prev ? (bar.close / bar.prev - 1) * 100 : null;
    legend.textContent = `${bar.time}　開 ${fmt(bar.open)}　高 ${fmt(bar.high)}　低 ${fmt(bar.low)}　收 ${fmt(bar.close)}`
      + (isNum(chg) ? `（${chg > 0 ? '+' : ''}${chg.toFixed(2)}%）` : '')
      + (isNum(bar.volume) ? `　量 ${volFmt(bar.volume)}` : '')
      + (isNum(bar.ma20) ? `　MA20 ${fmt(bar.ma20)}` : '') + (isNum(bar.ma60) ? `　MA60 ${fmt(bar.ma60)}` : '');
    legend.dataset.dir = isNum(chg) ? (chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat') : 'flat';
  };
  const onMove = (p) => writeLegend((p?.time && byTime.get(p.time)) || lastBar);
  chart.subscribeCrosshairMove(onMove);

  return {
    /**
     * @param {{dates, open, high, low, close, volume, ma20, ma60, visible:number}} d  visible = 顯示最近幾根（Infinity = 全部）
     */
    update(d) {
      const n = d.dates.length;
      const bars = [];
      byTime = new Map();
      for (let i = 0; i < n; i++) {
        if (![d.open[i], d.high[i], d.low[i], d.close[i]].every(isNum)) continue;
        const b = { time: d.dates[i], open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i],
          prev: i ? d.close[i - 1] : null, volume: d.volume?.[i], ma20: d.ma20?.[i], ma60: d.ma60?.[i] };
        bars.push(b);
        byTime.set(b.time, b);
      }
      candles.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      const ln = (arr) => d.dates.map((t, i) => (isNum(arr?.[i]) ? { time: t, value: arr[i] } : null)).filter(Boolean);
      ma20.setData(ln(d.ma20));
      ma60.setData(ln(d.ma60));
      vol.setData(bars.map((b) => ({ time: b.time, value: isNum(b.volume) ? b.volume : 0,
        color: alpha(b.close >= (b.prev ?? b.open) ? up : down, 0.45) })));
      lastBar = bars[bars.length - 1] || null;
      writeLegend(lastBar);
      const k = Number.isFinite(d.visible) ? d.visible : bars.length;
      chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - k), to: bars.length - 1 + 3 });
    },
    destroy() {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      host.replaceChildren();
    },
  };
}
