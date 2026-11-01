/**
 * Gemini AI 分析區塊（個股頁最下方）
 *
 * 流程：按標題列的「產生 AI 報告（Gemini）」或區塊內的按鈕 → 把「產生分析指令」同一份提示詞 POST 到 Cloudflare Worker（worker/ai.js）
 *       → Worker 用自己保管的 GEMINI_API_KEY 呼叫 Gemini → 回傳文字 → 這裡轉成畫面。
 * Gemini 金鑰永遠不會出現在網頁；網頁只需要「通關密碼」（AI_ACCESS_CODE，存在這台瀏覽器），
 * 避免公開網站被陌生人拿來耗用你的免費額度。
 *
 * AI 回覆是 Markdown；這裡自己解析成 DOM（只用 textContent），不使用 innerHTML，回覆內容無法注入 HTML。
 */
import { h } from './render.js';
import * as F from './format.js';

const CODE_KEY = 'ai:access-code';
const getCode = () => { try { return localStorage.getItem(CODE_KEY) || ''; } catch { return ''; } };
const setCode = (v) => { try { if (v) localStorage.setItem(CODE_KEY, v); else localStorage.removeItem(CODE_KEY); } catch { /* 無痕模式：每次重新輸入 */ } };

// 同一檔、同一資料日的結果保留在記憶體：個股頁因資料陸續載入而重畫時，不會把結果洗掉
const results = new Map();
// 同一檔可能因重畫而有新舊兩個區塊：分析完成時通知所有仍在畫面上的區塊
const views = new Map();
const notify = (key) => (views.get(key) || new Set()).forEach((v) => (v.section.isConnected ? v.show() : views.get(key).delete(v)));

/**
 * 標題列「產生 AI 報告（Gemini）」：捲到個股頁最下方的 AI 區塊並開始產生。
 * 已有報告就只捲過去；還沒輸入通關密碼就把游標放到密碼欄。
 */
export function triggerAi(code) {
  for (const [key, set] of views) {
    if (!key.startsWith(`${code}|`)) continue;
    const v = [...set].reverse().find((x) => x.section.isConnected);
    if (!v) continue;
    v.section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    v.start();
    return true;
  }
  return false;
}

/* ───────── Markdown → 區塊（純函式，可測試）───────── */

const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** @returns {Array<{type:'h',level,text}|{type:'p',text}|{type:'ul'|'ol',items}|{type:'table',head,rows}|{type:'hr'}>} */
export function parseMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { out.push({ type: 'h', level: Math.min(m[1].length, 4), text: m[2].trim() }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push({ type: 'hr' }); i++; continue; }
    if (isRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const head = cells(l);
      const rows = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      out.push({ type: 'table', head, rows });
      continue;
    }
    if (/^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l)) {
      const type = /^\s*\d/.test(l) ? 'ol' : 'ul';
      const items = [];
      while (i < lines.length && (type === 'ol' ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/).test(lines[i])) {
        items.push(lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim());
        i++;
        // 縮排的續行併入上一項
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) items[items.length - 1] += ` ${lines[i++].trim()}`;
      }
      out.push({ type, items });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s/.test(lines[i]) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])
      && !(isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1]))) para.push(lines[i++].trim());
    out.push({ type: 'p', text: para.join(' ') });
  }
  return out;
}

/** 行內：**粗體**、`程式碼`；其餘一律純文字 */
function inline(text) {
  const parts = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(m[1] !== undefined ? h('strong', {}, m[1]) : h('code', {}, m[2]));
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function renderMarkdown(md) {
  return parseMarkdown(md).map((b) => {
    if (b.type === 'h') return h(`h${b.level + 2 > 6 ? 6 : b.level + 2}`, {}, inline(b.text));
    if (b.type === 'hr') return h('hr');
    if (b.type === 'p') return h('p', {}, inline(b.text));
    if (b.type === 'ul' || b.type === 'ol') return h(b.type, {}, b.items.map((x) => h('li', {}, inline(x))));
    return h('div', { class: 'ai-table' }, h('table', {},
      h('thead', {}, h('tr', {}, b.head.map((c) => h('th', {}, inline(c))))),
      h('tbody', {}, b.rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, inline(c))))))));
  });
}

/* ───────── 區塊 ───────── */

/**
 * @param {object} o
 * @param {string|null} o.url       Worker 網址（assets/ai.json）；未設定時顯示說明
 * @param {string} o.code           股票代號
 * @param {string} o.dataDay        資料日（結果快取的鍵）
 * @param {() => string} o.getPrompt 產生分析指令
 */
export function renderAiPanel({ url, code, dataDay, getPrompt }) {
  const key = `${code}|${dataDay}`;
  const body = h('div', { class: 'ai-body' });
  const section = h('section', { class: 'panel ai-panel', id: 'ai-report' },
    h('h3', {}, 'AI 報告（Gemini）'),
    h('p', { class: 'note' }, '把「產生分析指令」的內容交給 Google Gemini 分析。AI 產生的內容可能有誤，僅供參考，非投資建議。'),
    body);

  const show = () => {
    const r = results.get(key);
    if (!url) {
      body.replaceChildren(h('p', { class: 'note' }, 'AI 報告服務尚未設定：需要 Gemini 金鑰與 Cloudflare Worker，設定步驟見 docs/AI.md。'));
      return;
    }
    if (r?.loading) {
      body.replaceChildren(h('p', { class: 'ai-loading', role: 'status' }, 'Gemini 正在產生報告，約 10–40 秒…'));
      return;
    }
    const actions = h('div', { class: 'ai-actions' });
    if (!getCode()) {
      const input = h('input', { type: 'password', autocomplete: 'off', placeholder: '通關密碼', 'aria-label': 'AI 分析通關密碼' });
      const save = () => { if (input.value.trim()) { setCode(input.value.trim()); run(false); } };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      actions.append(input, h('button', { type: 'button', class: 'btn primary', on: { click: save } }, '儲存並產生報告'));
      actions.append(h('span', { class: 'note' }, '第一次使用請輸入 AI_ACCESS_CODE（只存在這台瀏覽器）'));
    } else {
      actions.append(h('button', { type: 'button', class: 'btn primary', on: { click: () => run(!!r?.text) } }, r?.text ? '重新產生報告' : '產生 AI 報告'));
      actions.append(h('button', { type: 'button', class: 'btn', on: { click: () => { setCode(''); show(); } } }, '更換通關密碼'));
    }
    const parts = [actions];
    if (r?.error) parts.push(h('p', { class: 'banner warn' }, r.error));
    if (r?.text) {
      parts.push(h('div', { class: 'ai-result' }, renderMarkdown(r.text)));
      parts.push(h('p', { class: 'note' }, `模型 ${r.model}｜產生於 ${F.when(r.createdAt)}${r.cached ? '（快取）' : ''}｜資料日 ${dataDay || 'N/A'}`));
    }
    body.replaceChildren(...parts);
  };

  async function run(force) {
    const prev = results.get(key) || {};
    results.set(key, { ...prev, loading: true, error: null });
    notify(key);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Access-Code': getCode() },
        body: JSON.stringify({ code, dataDay, prompt: getPrompt(), force }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) setCode('');
      if (!res.ok || !data.text) throw new Error(data.error || `HTTP ${res.status}`);
      results.set(key, { ...data, loading: false });
    } catch (e) {
      results.set(key, { ...prev, loading: false, error: `分析失敗：${e.message || e}` });
    }
    notify(key);
  }

  if (!views.has(key)) views.set(key, new Set());
  views.get(key).add({ section, show, start: () => {
    const r = results.get(key);
    if (url && getCode() && !r?.loading && !r?.text) run(false);
    else section.querySelector('input')?.focus({ preventScroll: true });
  } });
  show();
  return section;
}
