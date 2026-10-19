/**
 * 股票搜尋：代號或名稱都能找（全市場，約 2,000–3,000 檔）
 *
 * 舊版問題：只搜一份手打的 110 檔清單（還有重複），清單外的股票用名稱找不到。
 * 新版：清單來自 FinMind TaiwanStockInfo（每次部署自動更新），涵蓋上市、上櫃、興櫃、ETF。
 *
 * 支援的輸入：
 *   "2330"        代號完全相符（最優先）
 *   "23"          代號開頭
 *   "台積"        名稱開頭 / 包含
 *   "臺積電"      臺 → 台 自動轉換
 *   "２３３０"    全形數字自動轉半形
 *   "2330.TW"     去掉 Yahoo 後綴
 *   "2330 台積電" 代號 + 名稱
 *   "台積體"      名稱字元依序出現（模糊比對）
 *   "半導體"      產業別
 *
 * 效能：建索引時就把名稱正規化好，搜尋時只做字串比對；
 *       3,000 檔單次搜尋 < 1 毫秒（見 tests/bench/search_bench.mjs）。
 */

/** 正規化：全形→半形 (NFKC)、小寫、臺→台、去空白與 .TW/.TWO 後綴 */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/臺/g, '台')
    .replace(/\s+/g, '')              // 先去空白，否則 "2330.TW " 的後綴比對不到
    .replace(/\.(tw|two)$/i, '');
}

/** 字元依序出現（不必相連）："台積體" 可以比對到 "台灣積體電路" */
function isSubsequence(q, s) {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}

const MARKET_LABEL = { twse: '上市', tpex: '上櫃', emerging: '興櫃' };
export const marketLabel = (m) => MARKET_LABEL[m] ?? m ?? '';

/**
 * 建立索引
 * @param {Array<[string,string,string,string]>} rows  [代號, 名稱, 市場, 產業]
 * @param {Iterable<string>} [boost] 追蹤清單代號：同分時排前面
 */
export function buildIndex(rows, boost = []) {
  const boosted = new Set(boost);
  return rows.map(([code, name, market, industry]) => ({
    code, name, market, industry,
    n: normalize(name),
    ni: normalize(industry),
    bonus: (boosted.has(code) ? 30 : 0) + (market === 'emerging' ? 0 : 10),
  }));
}

/** 單筆評分；0 = 不相符 */
function score(item, q, qCode, qName) {
  let s = 0;
  if (qCode) {
    if (item.code === qCode) s = 1000;
    else if (item.code.startsWith(qCode)) s = 800 - (item.code.length - qCode.length);
    else if (!qName && item.code.includes(qCode)) s = 300;
    if (qName && s) {
      // "2330 台積電"：代號與名稱都要對得上
      if (!item.n.includes(qName)) s = 0;
    }
    return s;
  }
  const n = item.n;
  if (n === q) s = 950;
  else if (n.startsWith(q)) s = 700 - n.length;
  else if (n.includes(q)) s = 500 - n.indexOf(q);
  else if (q.length >= 2 && isSubsequence(q, n)) s = 250;
  else if (q.length >= 2 && item.ni.includes(q)) s = 100;
  return s;
}

/**
 * 搜尋
 * @returns {Array<{item, score}>} 依分數排序
 */
export function search(index, query, limit = 8) {
  const q = normalize(query);
  if (!q) return [];
  // 開頭是數字 → 視為代號；後面若接中文/英文 → 一併比對名稱
  const m = q.match(/^(\d[\da-z]{0,5})(.*)$/);
  const qCode = m ? m[1] : '';
  const qName = m ? m[2] : '';

  const out = [];
  for (const item of index) {
    const s = score(item, q, qCode, qName);
    if (s > 0) out.push({ item, score: s + item.bonus });
  }
  out.sort((a, b) => b.score - a.score || a.item.code.localeCompare(b.item.code));
  return out.slice(0, limit);
}

/**
 * 輸入框按 Enter 時要直接開哪一檔：
 * 只有在「代號完全相符」或「名稱完全相符」或「只有一個結果」時才自動開，避免猜錯。
 */
export function resolveExact(index, query) {
  const res = search(index, query, 2);
  if (!res.length) return null;
  const q = normalize(query);
  const top = res[0].item;
  if (top.code === q || top.n === q || res.length === 1) return top;
  const m = q.match(/^(\d{4,6})/);
  if (m && top.code === m[1]) return top;
  return null;
}

/** 把查詢字串在名稱中標示出來：回傳 [前段, 相符段, 後段]（交給 render 用 textContent 組合，避免 XSS） */
export function highlightParts(name, query) {
  const q = normalize(query).replace(/^\d+/, '');
  if (!q) return [name, '', ''];
  const n = normalize(name);
  // 只有正規化前後長度相同時（沒有被去掉的空白等），位置才能直接套回原字串
  const i = n.length === name.length ? n.indexOf(q) : -1;
  if (i < 0) return [name, '', ''];
  return [name.slice(0, i), name.slice(i, i + q.length), name.slice(i + q.length)];
}
