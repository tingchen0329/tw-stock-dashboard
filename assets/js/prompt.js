/**
 * 產生「台股深度分析指令 v2.0」— 把網頁上的真實資料整理成給 Claude / ChatGPT 的提示詞
 *
 * 原則（對應 v2.0 指令的「資料驗證強制條款」）：
 *  - 每個數字都附來源與日期
 *  - 缺的欄位明確列在「缺少資料」，要求 AI 標 N/A，不准用記憶補
 *  - 參考價位是客觀計算值（前高前低、均線、河流圖價格帶），不是買賣建議
 */

import * as F from './format.js';
import { completeness } from './analytics.js';
import { marketLabel } from './search.js';

const line = (label, value) => `- ${label}：${value}`;

export function buildPrompt(s, meta, macro = []) {
  const { info, price: px, valuation: v, tech: t, river: rv, revenue: rev, inst, instToday, margin, holding, fundamentals: f } = s;
  const c = completeness(s);
  const L = [];

  L.push(`請以資深台灣股票分析師的身份，理性客觀分析 ${info.code} ${info.name}（${marketLabel(info.market)}，${info.industry || '產業 N/A'}）。`);
  L.push('');
  L.push('以下資料由我的儀表板從證交所 / 櫃買中心 OpenAPI、FinMind、Yahoo Finance 自動抓取，請以此為唯一數據來源，不要用記憶推測或補數字。');
  L.push(`資料產生時間：${meta?.generatedAt ?? 'N/A'}（台北時間）`);
  L.push(`資料完整度：${c.pct}%（${c.ok}/${c.total} 項）${c.missing.length ? `；缺少：${c.missing.join('、')}` : ''}`);
  L.push('');

  L.push('【總經（儀表板抓取）】');
  if (macro.length) {
    for (const m of macro) {
      const val = m.key === 'fed' || m.key === 'us10y' ? F.pct(m.value, 2) : F.num(m.value, m.key === 'usdtwd' ? 3 : 2);
      L.push(line(`${m.label}（${m.source}，${F.when(m.time)}）`, m.key === 'fed' ? val : `${val}，${F.change(m.change, m.changePct)}`));
    }
  } else L.push('- N/A');
  L.push('- 台灣景氣對策信號、製造業 PMI：N/A（免費資料源未提供）');
  L.push('');

  L.push('【股價與估值】');
  L.push(line(`股價（${px?.kind ?? ''}，${px?.source ?? 'N/A'}，${F.when(px?.asOf)}）`, `${F.price(px?.price)}，${F.change(px?.change, px?.changePct)}`));
  L.push(line(`本益比 / 股價淨值比 / 殖利率（${v.source ?? 'N/A'}，${F.when(v.asOf)}）`, `${F.num(v.pe)} 倍 / ${F.num(v.pb)} 倍 / ${F.pct(v.yield)}`));
  if (t) {
    const r = t.returns;
    L.push(line('區間漲跌幅', `5日 ${F.pct(r.d5, 1, true)}、20日 ${F.pct(r.d20, 1, true)}、60日 ${F.pct(r.d60, 1, true)}、年初至今 ${F.pct(r.ytd, 1, true)}、近一年 ${F.pct(r.y1, 1, true)}`));
    L.push(line('價格位階（收盤價百分位）', `近一年 ${F.num(t.pct1y, 0)}%、近三年 ${F.num(t.pct3y, 0)}%`));
  }
  L.push('');

  L.push('【基本面】');
  if (rev) {
    L.push(line(`最新月營收（${rev.latest.period}）`, `${F.twd(rev.latest.revenue)}，年增 ${F.pct(rev.latest.yoy, 1, true)}，月增 ${F.pct(rev.latest.mom, 1, true)}`));
    L.push(line('近 3 個月平均年增 / 今年累計年增 / 近 12 月累計年增', `${F.pct(rev.avgYoY3, 1, true)} / ${F.pct(rev.ytdYoY, 1, true)} / ${F.pct(rev.ttmYoY, 1, true)}`));
    L.push(line('近 12 個月營收年增率', rev.items.slice(-12).map((x) => `${x.period} ${F.pct(x.yoy, 1, true)}`).join('、')));
  } else L.push('- 月營收：N/A');
  if (f) {
    L.push(line(`近四季 EPS（至 ${f.latestQuarter ?? 'N/A'}，單季加總）`, `${F.num(f.eps4)} 元，年增 ${F.pct(f.eps4YoY, 1, true)}`));
    L.push(line('單季 EPS', f.quarters.slice(-8).map((q) => `${q.date.slice(0, 7)} ${F.num(q.eps)}`).join('、') || 'N/A'));
    L.push(line('最新一季 毛利率 / 營益率 / 淨利率', `${F.pct(f.margins?.gross, 1)} / ${F.pct(f.margins?.op, 1)} / ${F.pct(f.margins?.net, 1)}（去年同期 ${F.pct(f.marginsLastYear?.gross, 1)} / ${F.pct(f.marginsLastYear?.op, 1)} / ${F.pct(f.marginsLastYear?.net, 1)}）`));
    L.push(line(`ROE / ROA（近四季）/ 負債比 / 流動比（${f.balanceDate ?? 'N/A'}）`, `${F.pct(f.roe, 1)} / ${F.pct(f.roa, 1)} / ${F.pct(f.debtRatio, 1)} / ${F.pct(f.currentRatio, 0)}`));
  } else L.push('- 財報：N/A');
  L.push('');

  L.push('【籌碼面】（單位：張）');
  if (instToday) L.push(line(`三大法人當日（${instToday.source}，${F.when(instToday.date)}）`, `外資 ${F.lots(instToday.foreign)}、投信 ${F.lots(instToday.trust)}、自營商 ${F.lots(instToday.dealer)}、合計 ${F.lots(instToday.total)}`));
  if (inst) {
    L.push(line('近 5 日合計', `外資 ${F.lots(inst.sum5.foreign)}、投信 ${F.lots(inst.sum5.trust)}、自營商 ${F.lots(inst.sum5.dealer)}`));
    L.push(line('近 20 日合計', `外資 ${F.lots(inst.sum20.foreign)}、投信 ${F.lots(inst.sum20.trust)}、自營商 ${F.lots(inst.sum20.dealer)}`));
    L.push(line('外資連續', inst.foreignStreak > 0 ? `連 ${inst.foreignStreak} 日買超` : inst.foreignStreak < 0 ? `連 ${-inst.foreignStreak} 日賣超` : '無'));
  }
  L.push(holding ? line(`外資持股比例（${holding.date}）`, `${F.pct(holding.ratio)}，近 20 日 ${F.signed(holding.chg20)} 個百分點、近 60 日 ${F.signed(holding.chg60)} 個百分點`) : '- 外資持股比例：N/A');
  L.push(margin ? line(`融資 / 融券餘額（${margin.date}）`, `${F.num(margin.margin, 0)} / ${F.num(margin.short, 0)}，券資比 ${F.pct(margin.shortRatio)}，近 20 日融資 ${F.signed(margin.marginChg20, 0)}、融券 ${F.signed(margin.shortChg20, 0)}`) : '- 融資融券：N/A');
  L.push('- 借券、千張大戶、董監持股：N/A（免費資料源未提供）');
  L.push('');

  L.push('【技術面】');
  if (t) {
    L.push(line(`均線（${t.date}）`, `MA5 ${F.price(t.ma[5])}、MA20 ${F.price(t.ma[20])}、MA60 ${F.price(t.ma[60])}、MA240 ${F.price(t.ma[240])}；${t.alignment}`));
    L.push(line('KD(9)', `K ${F.num(t.k, 1)}、D ${F.num(t.d, 1)}${t.kdCross ? `（近 3 日${t.kdCross === 'golden' ? '黃金交叉' : '死亡交叉'}）` : ''}`));
    L.push(line('RSI(14)', F.num(t.rsi, 1)));
    L.push(line('MACD(12,26,9)', `DIF ${F.num(t.dif)}、DEA ${F.num(t.dea)}、柱狀 ${F.signed(t.osc)}${t.macdCross ? `（近 3 日${t.macdCross === 'golden' ? '黃金交叉' : '死亡交叉'}）` : ''}`));
    L.push(line('成交量 / 前 20 日均量', F.num(t.volRatio, 2) + ' 倍'));
    const lv = t.levels;
    L.push(line('參考價位（客觀計算）', `20日高低 ${F.price(lv.high20)} / ${F.price(lv.low20)}；60日高低 ${F.price(lv.high60)} / ${F.price(lv.low60)}；52週高低 ${F.price(lv.high250)} / ${F.price(lv.low250)}`));
  } else L.push('- 技術指標：N/A（股價資料不足）');
  L.push('');

  L.push('【本益比河流圖】');
  L.push(rv
    ? [line('目前本益比', `${F.num(rv.currentPE)} 倍（近三年 ${F.num(rv.percentile, 0)} 百分位，位於「${rv.zone}」區）`),
      line('隱含近四季 EPS', `${F.num(rv.currentEPS)} 元`),
      line('近三年本益比 10/25/50/75/90 百分位', rv.mults.map((m) => F.num(m, 1) + 'x').join(' / ')),
      line('對應價格帶（25/50/75 百分位）', `${F.price(rv.fair.low)} / ${F.price(rv.fair.mid)} / ${F.price(rv.fair.high)}`)].join('\n')
    : '- N/A（虧損或本益比資料不足 60 筆，河流圖不適用；可改用股價淨值比評估）');
  L.push('');

  L.push(`請依下列結構輸出：
1. 開頭先聲明資料截止日，列出上方「缺少」的項目並標註 N/A
2. 七段分析：總體經濟背景 / 股價表現與相對強弱 / 基本面 / 籌碼面 / 技術面 / 估值河流圖 / 綜合結論
   - 總經部分若無我提供的數據，請明確寫「資料不足」，不要自行假設利率或指數點位
3. 第七段用 Markdown 表格：投資評級（偏多/中性偏多/中性/中性偏空/偏空）、操作週期、第一買點 / 第二加碼點 / 停損點、合理估值區間（本益比 × EPS）、三大優勢、三大風險、壓力測試（大盤回檔 10% 時可能下探價位）、需追蹤的變數
4. 每個結論都要引用上方數字；不使用 emoji 與情緒性詞彙
5. 最後加上「分析師自我檢查」：哪些來自上方資料、哪些是推估、哪些是主觀判斷、操作前最該再驗證的 3 個數字
6. 結尾一句提醒：此為資料整理與研究參考，非投資建議`);
  return L.join('\n');
}
