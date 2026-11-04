/**
 * 產生「分析指令 v3（精簡版）」— 把網頁上的真實數據整理成可直接貼到任何 AI（Claude、ChatGPT、Gemini、Copilot）的提示詞
 *
 * 設計：
 *  - 數據一行一個主題、以「｜」分隔，日期只在與資料日不同時才標（v2 每行都重複來源與日期，約長一倍）
 *  - 指令只留會改變輸出的要求：結論先行、價位表附依據、引用數字、N/A 不推測
 *  - 參考價位是客觀計算值（前高前低、均線、河流圖價格帶），買賣區間由 AI 依這些數字判斷並說明依據
 */

import * as F from './format.js';
import { completeness } from './analytics.js';
import { marketLabel } from './search.js';

const pct = (v, dp = 1) => F.pct(v, dp, true);
const join = (parts) => parts.filter(Boolean).join('｜');
/** '2026-09-30' → '26Q3' */
const quarter = (d) => (d ? `${d.slice(2, 4)}Q${Math.ceil(Number(d.slice(5, 7)) / 3)}` : 'N/A');
/** 與資料日相同就不重複標日期 */
const dateIf = (d, dataDay) => (d && String(d).slice(0, 10) !== dataDay ? `（${F.when(d)}）` : '');

function macroLine(macro) {
  if (!macro.length) return 'N/A';
  return join(macro.map((m) => {
    if (m.key === 'fed') return `Fed ${F.pct(m.value, 2)}`;
    const val = m.key === 'us10y' ? F.pct(m.value, 2) : F.num(m.value, m.key === 'usdtwd' ? 3 : m.value > 1000 ? 0 : 2);
    const when = m.key === 'txf_night' ? `，${F.when(m.time)}` : '';
    return `${m.label} ${val}（${pct(m.changePct, 2)}${when}）`;
  }));
}

function techLines(t) {
  if (!t) return ['【技術】N/A（股價資料不足）'];
  const cross = (x) => (x ? (x === 'golden' ? ' 黃金交叉' : ' 死亡交叉') : '');
  const lv = t.levels;
  return [
    `【技術】${join([
      `MA5 ${F.price(t.ma[5])}、MA20 ${F.price(t.ma[20])}、MA60 ${F.price(t.ma[60])}、MA240 ${F.price(t.ma[240])}，${t.alignment}`,
      `K ${F.num(t.k, 1)} D ${F.num(t.d, 1)}${cross(t.kdCross)}`,
      `RSI14 ${F.num(t.rsi, 1)}`,
      `MACD 柱 ${F.signed(t.osc)}${cross(t.macdCross)}`,
      `量比 ${F.num(t.volRatio, 2)}`,
    ])}`,
    `【高/低點】20日 ${F.price(lv.high20)} / ${F.price(lv.low20)}｜60日 ${F.price(lv.high60)} / ${F.price(lv.low60)}｜52週 ${F.price(lv.high250)} / ${F.price(lv.low250)}`,
  ];
}

const instructions = (aspects, index) => `請用繁體中文輸出，先結論後理由，每個判斷都引用上方數字：
1. 結論：評級（偏多／中性偏多／中性／中性偏空／偏空）、操作週期、一句理由
2. 價位表（Markdown 表格，欄位：項目｜價位｜依據）：買進區間、加碼點、賣出區間、支撐 1、支撐 2、壓力 1、壓力 2、破線停損價、合理價（本益比 × EPS）
3. ${aspects}，各 2–3 句
4. 三大優勢、三大風險；壓力測試：${index}回檔 10% 時可能價位
5. 操作前要再確認的 3 個數字
規則：只用上方數據，N/A 照寫不推測；推估值標「推估」；不用 emoji；結尾註明「非投資建議」。`;

/** 相對大盤與風險（兩個版本共用） */
function riskLine(rk) {
  if (!rk) return '【相對大盤】N/A';
  const p = (x) => (x ? `${pct(x.stock)} vs ${pct(x.bench)}` : 'N/A');
  return `【相對大盤，比 ${rk.label}】${join([
    `1月 ${p(rk.periods.m1)}`, `3月 ${p(rk.periods.m3)}`, `6月 ${p(rk.periods.m6)}`, `1年 ${p(rk.periods.y1)}`,
  ])}\n　${join([`Beta ${F.num(rk.beta, 2)}`, `年化波動 ${F.pct(rk.vol, 1)}（大盤 ${F.pct(rk.benchVol, 1)}）`, `近一年最大回撤 ${F.pct(rk.mdd, 1)}`])}`;
}

/** 美股版：資料來自 Yahoo 日線與 SEC 財報（沒有月營收、法人籌碼、本益比歷史） */
function buildPromptUS(s, macro) {
  const { info, price: px, valuation: v, tech: t, fundamentals: f } = s;
  const dataDay = t?.date || null;
  const etf = !f;
  const r = t?.returns;
  const L = [];
  L.push(`你是美股分析師，依下列數據分析 ${info.code} ${info.name}（${info.industry || '交易所 N/A'}${etf ? '｜無 SEC 財報，可能為 ETF 或外國公司' : ''}）。`);
  L.push(`資料日：${dataDay ? `${dataDay} 美東收盤` : 'N/A'}｜財報至 ${f?.latestQuarter ? quarter(f.latestQuarter) : 'N/A'}（SEC，日曆季）｜單位：美元`);
  L.push('來源：Yahoo Finance、美國證管會 SEC EDGAR；分析師預估、機構持股、內部人交易、選擇權、前瞻財測無資料');
  L.push('');
  L.push(`【總經】${macroLine(macro)}`);
  L.push(`【股價】${join([
    px ? `${F.price(px.price)}（${pct(px.changePct, 2)}）` : 'N/A',
    r && `5日 ${pct(r.d5)}、20日 ${pct(r.d20)}、60日 ${pct(r.d60)}、YTD ${pct(r.ytd)}、1年 ${pct(r.y1)}`,
    t && `位階 1年 ${F.num(t.pct1y, 0)}%、3年 ${F.num(t.pct3y, 0)}%`,
  ])}`);
  L.push(`【估值】${join([`本益比（近四季）${F.num(v.pe)}`, `股價淨值比 ${F.num(v.pb)}`])}（推估：收盤 ÷ SEC 財報）`);
  L.push(f
    ? `【財報】${join([
      `近四季 EPS ${F.num(f.eps4)}（年增 ${pct(f.eps4YoY)}）`,
      `最新一季營收年增 ${pct(f.revYoY)}`,
      `單季 EPS ${quarter(f.quarters.slice(-8)[0]?.date)} 起：${f.quarters.slice(-8).map((q) => F.num(q.eps)).join(', ') || 'N/A'}`,
    ])}\n　${join([
      `毛利/營益/淨利率 ${F.pct(f.margins?.gross, 1)} / ${F.pct(f.margins?.op, 1)} / ${F.pct(f.margins?.net, 1)}（去年同期 ${F.pct(f.marginsLastYear?.gross, 1)} / ${F.pct(f.marginsLastYear?.op, 1)} / ${F.pct(f.marginsLastYear?.net, 1)}）`,
      `ROE ${F.pct(f.roe, 1)}`, `ROA ${F.pct(f.roa, 1)}`, `負債比 ${F.pct(f.debtRatio, 1)}`, `流動比 ${F.pct(f.currentRatio, 0)}`,
    ])}\n　${join([
      `近四季自由現金流 ${F.usd(f.fcf4)}`,
      F.isNum(f.fcf4) && F.isNum(f.ni4) && f.ni4 > 0 && `FCF ÷ 淨利 ${F.num(f.fcf4 / f.ni4, 2)} 倍`,
      `單季營收年增 ${quarter(f.quarters.slice(-4)[0]?.date)} 起：${f.quarters.slice(-4).map((q) => pct(q.revYoY)).join(', ')}`,
    ])}`
    : '【財報】不適用（無 SEC us-gaap 財報）');
  L.push(riskLine(s.risk));
  L.push(...techLines(t));
  L.push('');
  L.push(instructions(etf ? '總經、股價、技術、估值' : '總經、股價、基本面、技術、估值', 'S&P 500 / 那斯達克'));
  return L.join('\n');
}

export function buildPrompt(s, meta, macro = []) {
  if (s.info.market === 'us') return buildPromptUS(s, macro);
  const { info, price: px, valuation: v, tech: t, river: rv, revenue: rev, inst, instToday, margin, holding, fundamentals: f } = s;
  const c = completeness(s);
  const dataDay = meta?.market?.lastTradingDay || t?.date || null;
  const na = String(info.code).startsWith('00') ? '不適用（ETF）' : 'N/A';   // ETF 沒有本益比、營收、財報
  const L = [];

  L.push(`你是台股分析師，依下列數據分析 ${info.code} ${info.name}（${marketLabel(info.market)}｜${info.industry || '產業 N/A'}）。`);
  L.push(`資料日：${dataDay ? `${F.dayLabel(dataDay)}收盤` : 'N/A'}｜完整度 ${c.pct}%${c.missing.length ? `｜缺：${c.missing.join('、')}` : ''}`);
  L.push('來源：證交所、櫃買中心、FinMind、Yahoo、期交所；景氣燈號、PMI、借券、千張大戶、董監持股無資料');
  L.push('');

  L.push(`【總經】${macroLine(macro)}`);

  const r = t?.returns;
  L.push(`【股價】${join([
    px ? `${F.price(px.price)}（${pct(px.changePct, 2)}${px.kind === '盤中' ? `，盤中 ${F.when(px.asOf)}` : dateIf(px.asOf, dataDay)}）` : 'N/A',
    r && `5日 ${pct(r.d5)}、20日 ${pct(r.d20)}、60日 ${pct(r.d60)}、YTD ${pct(r.ytd)}、1年 ${pct(r.y1)}`,
    t && `位階 1年 ${F.num(t.pct1y, 0)}%、3年 ${F.num(t.pct3y, 0)}%`,
  ])}`);
  L.push(`【估值】${join([`本益比 ${F.num(v.pe)}`, `股價淨值比 ${F.num(v.pb)}`, `殖利率 ${F.pct(v.yield)}`])}${dateIf(v.asOf, dataDay)}`);

  L.push(rev
    ? `【營收】${join([
      `${rev.latest.period} ${F.twd(rev.latest.revenue)}，年增 ${pct(rev.latest.yoy)}、月增 ${pct(rev.latest.mom)}`,
      `近3月平均年增 ${pct(rev.avgYoY3)}`, `今年累計 ${pct(rev.ytdYoY)}`, `近12月累計 ${pct(rev.ttmYoY)}`,
    ])}\n　近12月年增（${rev.items.slice(-12)[0]?.period ?? ''} 起）：${rev.items.slice(-12).map((x) => pct(x.yoy)).join(', ')}`
    : `【營收】${na}`);

  L.push(f
    ? `【獲利】${join([
      `近四季 EPS ${F.num(f.eps4)}（年增 ${pct(f.eps4YoY)}，至 ${quarter(f.latestQuarter)}）`,
      `單季 EPS ${quarter(f.quarters.slice(-8)[0]?.date)} 起：${f.quarters.slice(-8).map((q) => F.num(q.eps)).join(', ') || 'N/A'}`,
    ])}\n　${join([
      `毛利/營益/淨利率 ${F.pct(f.margins?.gross, 1)} / ${F.pct(f.margins?.op, 1)} / ${F.pct(f.margins?.net, 1)}（去年同期 ${F.pct(f.marginsLastYear?.gross, 1)} / ${F.pct(f.marginsLastYear?.op, 1)} / ${F.pct(f.marginsLastYear?.net, 1)}）`,
      `ROE ${F.pct(f.roe, 1)}`, `ROA ${F.pct(f.roa, 1)}`, `負債比 ${F.pct(f.debtRatio, 1)}`, `流動比 ${F.pct(f.currentRatio, 0)}`,
    ])}`
    : `【獲利】${na}`);

  const lots = (o) => `外資 ${F.lots(o.foreign)}、投信 ${F.lots(o.trust)}、自營 ${F.lots(o.dealer)}`;
  L.push(`【籌碼，張】${join([
    instToday && `當日${dateIf(instToday.date, dataDay)} ${lots(instToday)}`,
    inst && `5日 ${lots(inst.sum5)}`,
    inst && `20日 ${lots(inst.sum20)}`,
    inst?.foreignStreak && `外資連${inst.foreignStreak > 0 ? '買' : '賣'} ${Math.abs(inst.foreignStreak)} 日`,
  ]) || 'N/A'}\n　${join([
    holding ? `外資持股 ${F.pct(holding.ratio)}（20日 ${F.signed(holding.chg20)}、60日 ${F.signed(holding.chg60)} 百分點）` : '外資持股 N/A',
    margin ? `融資 ${F.num(margin.margin, 0)}（20日 ${F.signed(margin.marginChg20, 0)}）、融券 ${F.num(margin.short, 0)}（20日 ${F.signed(margin.shortChg20, 0)}）、券資比 ${F.pct(margin.shortRatio)}` : '融資券 N/A',
  ])}`);

  L.push(riskLine(s.risk));
  L.push(...techLines(t));

  L.push(rv
    ? `【本益比河流圖】${join([
      `目前 ${F.num(rv.currentPE)} 倍，3年 ${F.num(rv.percentile, 0)} 百分位（${rv.zone}）`,
      `隱含 EPS ${F.num(rv.currentEPS)}`,
      `10/25/50/75/90 分位 ${rv.mults.map((m) => F.num(m, 1)).join(' / ')} 倍`,
      `對應價 25/50/75 分位 ${F.price(rv.fair.low)} / ${F.price(rv.fair.mid)} / ${F.price(rv.fair.high)}`,
    ])}`
    : `【本益比河流圖】${na === 'N/A' ? 'N/A（虧損或資料不足，改用股價淨值比）' : na}`);
  L.push('');

  L.push(instructions('總經、股價、基本面、籌碼、技術、估值', '加權指數'));
  return L.join('\n');
}
