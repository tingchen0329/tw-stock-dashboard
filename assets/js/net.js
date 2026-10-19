/**
 * 網路層：一個 fetchJSON 處理所有請求
 *
 * 相較舊版的效能 / 穩定性改善：
 *  1. 記憶體快取 + sessionStorage 快取：同一份資料一個分頁只下載一次
 *     （舊版每次搜尋都重新下載證交所全市場 JSON，約 1 MB × 3）
 *  2. 進行中請求共用（in-flight dedupe）：兩個地方同時要同一個網址，只發一次請求
 *  3. 自己的逾時機制（AbortController + setTimeout）：
 *     舊版用 AbortSignal.timeout()，Safari 16 以前不支援 → 直接拋錯
 *  4. 呼叫端可傳 signal 取消（使用者換查另一檔股票時，舊請求的結果直接丟棄）
 */

const memory = new Map();    // url → { at: 時間戳, data }
const inflight = new Map();  // url → Promise

/** 請求失敗的錯誤，帶 HTTP 狀態碼讓呼叫端判斷（例如 FinMind 402 = 額度用完） */
export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status}`);
    this.status = status;
    this.url = url;
  }
}

function readStore(key, ttl) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return undefined;
    const { at, data } = JSON.parse(raw);
    return Date.now() - at < ttl ? data : undefined;
  } catch {
    return undefined;           // 隱私模式、配額滿、非瀏覽器環境：快取失效不影響功能
  }
}

function writeStore(key, data) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), data }));
  } catch { /* 配額滿就算了 */ }
}

/** 讓「共用的請求」可以被單一呼叫端取消，而不影響其他等待者 */
function withSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

/**
 * @param {string} url
 * @param {object} [opt]
 * @param {number} [opt.timeout=12000]  逾時毫秒
 * @param {number} [opt.ttl=0]          快取有效毫秒；0 = 不快取
 * @param {boolean} [opt.persist=false] 是否也寫入 sessionStorage（重新整理後仍有效）
 * @param {RequestCache} [opt.cache]    瀏覽器 HTTP 快取策略（meta.json 用 'no-cache' 確保看到最新部署）
 * @param {AbortSignal} [opt.signal]
 * @param {(url:string)=>Promise<Response>} [opt.fetchImpl] 測試時注入假的 fetch
 */
export function fetchJSON(url, opt = {}) {
  const { timeout = 12000, ttl = 0, persist = false, cache, signal, fetchImpl = globalThis.fetch } = opt;

  if (ttl > 0) {
    const hit = memory.get(url);
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data);
    if (persist) {
      const stored = readStore('tsd:' + url, ttl);
      if (stored !== undefined) {
        memory.set(url, { at: Date.now(), data: stored });
        return Promise.resolve(stored);
      }
    }
  }

  if (!inflight.has(url)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const p = fetchImpl(url, { signal: ctrl.signal, cache })
      .then((res) => {
        if (!res.ok) throw new HttpError(res.status, url);
        return res.json();
      })
      .then((data) => {
        if (ttl > 0) {
          memory.set(url, { at: Date.now(), data });
          if (persist) writeStore('tsd:' + url, data);
        }
        return data;
      })
      .finally(() => {
        clearTimeout(timer);
        inflight.delete(url);
      });
    inflight.set(url, p);
  }
  return withSignal(inflight.get(url), signal);
}

/** 測試用：清空快取 */
export function _resetCache() {
  memory.clear();
  inflight.clear();
}
