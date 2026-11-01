/**
 * Cloudflare Worker：網頁「Gemini AI 分析」按鈕的代理（免費方案即可）
 *
 * 為什麼需要它：Gemini API 金鑰不能放在公開網頁裡（任何人都看得到、拿去用）。
 * 金鑰只存在 GitHub Secrets → 部署時由 GitHub Actions 寫進 Cloudflare 的加密 Secret（.github/workflows/ai-worker.yml），
 * 網頁只把「分析指令」送來這裡，這裡代為呼叫 Gemini。
 *
 * 防濫用：
 *   * 只接受來自網站網域的請求（CORS + Origin 檢查）
 *   * 必須帶通關密碼（X-Access-Code = AI_ACCESS_CODE）
 *   * 同一檔、同一資料日、同一份指令的結果快取 6 小時，不重複呼叫 Gemini
 *   * 指令長度上限 12,000 字
 *
 * 環境變數（wrangler.toml [vars]）：GEMINI_MODEL、ALLOWED_ORIGINS
 * Secrets（GitHub Actions 寫入）：GEMINI_API_KEY、AI_ACCESS_CODE
 */

const SYSTEM = [
  '你是嚴謹的股票研究分析師，以繁體中文（台灣用語）回答。',
  '只根據使用者提供的數據分析，不得自行補充數字；缺資料就寫 N/A，推估值標「推估」。',
  '依使用者要求的結構輸出，價位表用 Markdown 表格。不用 emoji，結尾註明「非投資建議」。',
].join('\n');
const MAX_PROMPT = 12000;
const CACHE_SECONDS = 6 * 3600;

const json = (obj, status, headers) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
});

/** 固定時間比較，避免從回應時間猜出通關密碼 */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(a || '');
  const y = new TextEncoder().encode(b || '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const model = env.GEMINI_MODEL || 'gemini-3.8-flash';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, model, keyConfigured: !!env.GEMINI_API_KEY, accessCodeConfigured: !!env.AI_ACCESS_CODE }, 200, cors);
    }
    if (req.method !== 'POST') return json({ error: '只接受 POST' }, 405, cors);
    if (!allowed.includes(origin)) return json({ error: '不允許的來源網站' }, 403, cors);
    if (!env.GEMINI_API_KEY || !env.AI_ACCESS_CODE) return json({ error: '服務尚未設定金鑰' }, 503, cors);
    if (!safeEqual(req.headers.get('X-Access-Code'), env.AI_ACCESS_CODE)) return json({ error: '通關密碼錯誤，請重新輸入' }, 401, cors);

    let body;
    try { body = await req.json(); } catch { return json({ error: '請求格式錯誤' }, 400, cors); }
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const code = String(body.code || '').slice(0, 12);
    if (!prompt || prompt.length > MAX_PROMPT) return json({ error: `分析指令需為 1–${MAX_PROMPT} 字` }, 400, cors);

    // 快取：同模型 + 同一份指令（指令裡已含代號與資料日）
    const cacheKey = new Request(`https://ai-cache.internal/${model}/${encodeURIComponent(code)}/${await sha256(prompt)}`);
    const cache = caches.default;
    if (!body.force) {
      const hit = await cache.match(cacheKey);
      if (hit) return json({ ...(await hit.json()), cached: true }, 200, cors);
    }

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = res.status === 429 ? 'Gemini 免費額度暫時用完，請稍後再試'
        : res.status === 400 || res.status === 403 ? `Gemini 拒絕請求（${data.error?.status || res.status}）：請確認 GEMINI_API_KEY 與模型 ${model}`
          : `Gemini 錯誤 HTTP ${res.status}`;
      return json({ error: msg }, 502, cors);
    }
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (!text) return json({ error: `Gemini 沒有回覆內容（${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || '未知原因'}）` }, 502, cors);

    const result = { text, model, createdAt: new Date().toISOString() };
    ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_SECONDS}` },
    })));
    return json({ ...result, cached: false }, 200, cors);
  },
};
