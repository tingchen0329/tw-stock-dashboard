/**
 * 台股開休市狀態（純函式，不碰 DOM，可在 Node 測試）
 *
 * 輸入 meta.market（scripts/fetch_data.py 產生）：
 *   lastTradingDay  最近一個有收盤資料的交易日
 *   holidays        證交所排定休市日 [{date, name}]
 *   closures        由資料推斷的臨時休市日（颱風等）
 *   holidaysOk      休市表是否抓取成功（失敗時推斷出的休市不標「臨時」）
 * 「現在」用瀏覽當下的時間計算，所以網頁開著過午夜也會正確。
 */
import * as F from './format.js';

const OPEN = 9 * 60;            // 09:00
const CLOSE = 13 * 60 + 30;     // 13:30

/** 任意時區的 Date → 台北日期與分鐘數 */
export function tpeClock(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** 這天休市的原因；有開盤回傳 null */
export function closedReason(iso, market = {}) {
  const wd = new Date(iso + 'T00:00:00Z').getUTCDay();
  if (wd === 0 || wd === 6) return '週末';
  const h = (market.holidays || []).find((x) => x.date === iso);
  if (h) return h.name;
  if ((market.closures || []).includes(iso)) return market.holidaysOk === false ? '休市' : '臨時休市';
  return null;
}

/** iso 之後的下一個開盤日 */
export function nextOpen(iso, market) {
  let d = iso;
  for (let i = 0; i < 30; i++) {
    d = F.daysBefore(d, -1);
    if (!closedReason(d, market)) return d;
  }
  return null;
}

/**
 * @returns {{state: 'closed'|'pre'|'open'|'after', today: string, reason: string|null,
 *            dataDay: string|null, nextOpen: string|null}}
 */
export function marketStatus(now, market = {}) {
  const { date: today, minutes } = tpeClock(now);
  const reason = closedReason(today, market);
  const base = { today, reason, dataDay: market.lastTradingDay || null };
  if (reason) return { ...base, state: 'closed', nextOpen: nextOpen(today, market) };
  if (minutes < OPEN) return { ...base, state: 'pre', nextOpen: today };
  if (minutes < CLOSE) return { ...base, state: 'open', nextOpen: null };
  return { ...base, state: 'after', nextOpen: nextOpen(today, market) };
}

/** 橫幅文字 {level, text}；收盤後且資料已是今天 → null（不打擾） */
export function marketNotice(st) {
  const data = st.dataDay ? `${F.dayLabel(st.dataDay)}收盤` : '最近一次收盤';
  switch (st.state) {
    case 'closed':
      return {
        level: st.reason === '週末' ? 'info' : 'warn',
        text: `今天 ${F.dayLabel(st.today)}台股休市（${st.reason}）。下列為 ${data}資料`
          + `${st.nextOpen ? `，下次開盤 ${F.dayLabel(st.nextOpen)}` : ''}。`,
      };
    case 'pre':
      return { level: 'info', text: `盤前：下列為 ${data}資料，今天 09:00 開盤。` };
    case 'open':
      return { level: 'info', text: `盤中：追蹤清單與總經為盤中價（約延遲 20 分鐘）；本益比、法人、財報為 ${data}資料。` };
    case 'after':
      return st.dataDay && st.dataDay < st.today
        ? { level: 'info', text: `今天的收盤資料還沒更新，下列為 ${data}資料。` }
        : null;
    default:
      return null;
  }
}

/* ───────── 美股（NYSE / NASDAQ）───────── */

// 紐約證交所休市日（官方公布；每年底補下一年）與提早收盤（美東 13:00）
const NYSE_HOLIDAYS = {
  '2026-01-01': '元旦', '2026-01-19': '馬丁路德金恩紀念日', '2026-02-16': '總統日', '2026-04-03': '耶穌受難日',
  '2026-05-25': '陣亡將士紀念日', '2026-06-19': '六月節', '2026-07-03': '獨立紀念日（補假）', '2026-09-07': '勞動節',
  '2026-11-26': '感恩節', '2026-12-25': '聖誕節',
  '2027-01-01': '元旦', '2027-01-18': '馬丁路德金恩紀念日', '2027-02-15': '總統日', '2027-03-26': '耶穌受難日',
  '2027-05-31': '陣亡將士紀念日', '2027-06-18': '六月節（補假）', '2027-07-05': '獨立紀念日（補假）', '2027-09-06': '勞動節',
  '2027-11-25': '感恩節', '2027-12-24': '聖誕節（補假）',
};
const NYSE_EARLY = { '2026-11-27': 13 * 60, '2026-12-24': 13 * 60, '2027-11-26': 13 * 60 };
const ET = 'America/New_York';

/** 任意時區的 Date → 指定時區的日期與分鐘數 */
function zoned(now, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** 美東某日某時（分鐘）→ Date（自動處理夏令 / 冬令時間） */
export function etToDate(iso, minutes) {
  let t = Date.parse(`${iso}T00:00:00Z`) + (minutes + 5 * 60) * 60000;   // 先假設 UTC-5
  for (let i = 0; i < 2; i++) {
    const z = zoned(new Date(t), ET);
    const diff = (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${z.date}T00:00:00Z`)) / 60000 + (minutes - z.minutes);
    t += diff * 60000;
  }
  return new Date(t);
}

export function usClosedReason(iso) {
  const wd = new Date(iso + 'T00:00:00Z').getUTCDay();
  if (wd === 0 || wd === 6) return '週末';
  return NYSE_HOLIDAYS[iso] || null;
}

function usNextOpen(iso) {
  let d = iso;
  for (let i = 0; i < 14; i++) {
    d = F.daysBefore(d, -1);
    if (!usClosedReason(d)) return etToDate(d, 9 * 60 + 30);
  }
  return null;
}

/**
 * 美股現在的狀態（美東時間）：盤前 04:00–09:30、盤中 09:30–16:00（提早收盤日 13:00）、盤後 16:00–20:00
 * @returns {{state:'closed'|'pre'|'open'|'after'|'night', reason, etDate, open:Date|null, close:Date|null, nextOpen:Date|null}}
 */
export function usMarketStatus(now) {
  const { date, minutes } = zoned(now, ET);
  const reason = usClosedReason(date);
  const closeMin = NYSE_EARLY[date] ?? 16 * 60;
  const open = etToDate(date, 9 * 60 + 30);
  const close = etToDate(date, closeMin);
  const base = { etDate: date, reason, early: date in NYSE_EARLY };
  if (reason) return { ...base, state: 'closed', open: null, close: null, nextOpen: usNextOpen(date) };
  if (minutes < 4 * 60) return { ...base, state: 'night', open, close, nextOpen: open };
  if (minutes < 9 * 60 + 30) return { ...base, state: 'pre', open, close, nextOpen: open };
  if (minutes < closeMin) return { ...base, state: 'open', open, close, nextOpen: null };
  if (minutes < 20 * 60) return { ...base, state: 'after', open, close, nextOpen: usNextOpen(date) };
  return { ...base, state: 'night', open, close, nextOpen: usNextOpen(date) };
}

/** 台北時間 '11/03（二）22:30' */
export function tpeLabel(d) {
  if (!d) return F.NA;
  const { date, minutes } = tpeClock(d);
  return `${F.dayLabel(date)} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** 美股頁上方提示 {level, text}；dataDay = 資料的最新交易日（美東） */
export function usMarketNotice(st, dataDay) {
  const data = dataDay ? `下列為 ${F.dayLabel(dataDay)}（美東）的資料` : '下列為最近一次更新的資料';
  const next = st.nextOpen ? `，下次開盤：台北 ${tpeLabel(st.nextOpen)}` : '';
  switch (st.state) {
    case 'closed':
      return { level: st.reason === '週末' ? 'info' : 'warn', text: `美股休市（${st.reason}）。${data}${next}。` };
    case 'pre':
      return { level: 'info', text: `美股盤前：台北 ${tpeLabel(st.open)} 開盤。${data}。` };
    case 'open':
      return { level: 'info', text: `美股盤中：台北 ${tpeLabel(st.close)} 收盤${st.early ? '（今天提早收盤）' : ''}。${data}，盤中價約延遲 15 分鐘。` };
    case 'after':
      return { level: 'info', text: `美股已收盤（盤後交易進行中）。${data}${next}。` };
    default:
      return { level: 'info', text: `美股已收盤。${data}${next}。` };
  }
}
