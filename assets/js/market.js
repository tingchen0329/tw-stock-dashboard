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
