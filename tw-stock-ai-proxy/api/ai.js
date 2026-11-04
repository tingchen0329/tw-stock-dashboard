/**
 * AI 報告代理（Vercel Function，免費 Hobby 方案）
 *
 * 為什麼需要它：Gemini / Claude 的 API 金鑰不能放在公開網頁裡。金鑰只存在 GitHub Secrets，
 * 部署時由 .github/workflows/ai-proxy.yml 交給 Vercel；網頁只把「分析指令」送來這裡。
 *
 * 為什麼是 Vercel 而不是 Cloudflare Worker：Cloudflare 免費方案會在離使用者最近的機房執行，
 * 台灣的請求常從香港送出，而 Gemini、Claude 都不開放香港（FAILED_PRECONDITION / 403）。
 * Vercel 可以把函式固定在美國（vercel.json 的 regions）。
 *
 * 流程：依 AI_ORDER 依序嘗試（預設先 Gemini 免費、失敗改 Claude 預付）；前一個失敗才換下一個。
 *
 * 防濫用：只接受網站網域（Origin 檢查）＋ 通關密碼（X-Access-Code = AI_ACCESS_CODE）＋ 指令長度上限。
 *
 * 環境變數（部署時設定）：
 *   GEMINI_API_KEY、ANTHROPIC_API_KEY（兩者至少一個）、AI_ACCESS_CODE、
 *   AI_ORDER（供應商順序，預設 gemini,claude；想 Claude 優先設 claude,gemini）、
 *   GEMINI_MODELS（預設 gemini-3.8-flash）、CLAUDE_MODEL（預設 claude-sonnet-5-5）、ALLOWED_ORIGINS、BUILD
 */

const SYSTEM = [
  '你是嚴謹的股票研究分析師，以繁體中文（台灣用語）回答。',
  '只根據使用者提供的數據分析，不得自行補充數字；缺資料就寫 N/A，推估值標「推估」。',
  '依使用者要求的結構輸出，價位表用 Markdown 表格。不用 emoji，結尾註明「非投資建議」。',
].join('\n');
const MAX_PROMPT = 12000;
const DEFAULT_ORIGINS = 'https://tingchen0329.github.io,http://localhost:8000';

/** 固定時間比較，避免從回應時間猜出通關密碼 */
function safeEqual(a, b) {
  const x = new TextEncoder().encode(a || '');
  const y = new TextEncoder().encode(b || '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

/** 'claude,gemini' → ['claude','gemini']；不認得的名稱略過，沒列到的補在後面 */
export function parseOrder(text) {
  const all = ['gemini', 'claude'];
  const picked = String(text || '').toLowerCase().split(',').map((s) => s.trim()).filter((s) => all.includes(s));
  return [...new Set([...picked, ...all])];
}

function config(env = process.env) {
  return {
    gemini: env.GEMINI_API_KEY || '',
    claude: env.ANTHROPIC_API_KEY || '',
    code: env.AI_ACCESS_CODE || '',
    geminiModels: (env.GEMINI_MODELS || 'gemini-3.8-flash').split(',').map((s) => s.trim()).filter(Boolean),
    claudeModel: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
    order: parseOrder(env.AI_ORDER),
    origins: (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean),
    build: env.BUILD || '?',
  };
}

async function callGemini(cfg, prompt) {
  const errors = [];
  for (const m of cfg.geminiModels) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.gemini },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
      if (text) return { text, model: m };
      errors.push(`${m}：沒有回覆內容（${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || '未知原因'}）`);
      continue;
    }
    errors.push(`${m}：HTTP ${res.status} ${data.error?.status || ''} ${String(data.error?.message || '').slice(0, 140)}`.trim());
  }
  throw new Error(errors.join('｜'));
}

async function callClaude(cfg, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.claude, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: cfg.claudeModel, max_tokens: 8192, temperature: 0.3, system: SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${cfg.claudeModel}：HTTP ${res.status} ${data.error?.type || ''} ${String(data.error?.message || '').slice(0, 140)}`.trim());
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  if (!text) throw new Error(`${cfg.claudeModel}：沒有回覆內容（${data.stop_reason || '未知原因'}）`);
  return { text, model: cfg.claudeModel };
}

const LABEL = { gemini: 'Gemini', claude: 'Claude' };

/** 依 cfg.order 依序嘗試（預設 Gemini → Claude）。回傳 {text, model, provider, fallback} 或丟出彙整後的錯誤 */
export async function generate(cfg, prompt, call = { gemini: callGemini, claude: callClaude }) {
  const errors = [];
  for (const p of cfg.order || ['gemini', 'claude']) {
    if (!cfg[p]) continue;                      // 沒設定金鑰的供應商跳過
    try { return { ...(await call[p](cfg, prompt)), provider: p, fallback: errors[0] || null }; } catch (e) { errors.push(`${LABEL[p]}：${e.message}`); }
  }
  if (!cfg.gemini && !cfg.claude) errors.push('沒有設定 GEMINI_API_KEY 或 ANTHROPIC_API_KEY');
  const all = errors.join('｜');
  const hint = /credit balance|billing/i.test(all) ? 'Claude 預付額度不足，請到 console.anthropic.com 儲值'
    : /location is not supported/i.test(all) ? 'AI 服務不接受這個地區的請求'
      : /429|RESOURCE_EXHAUSTED|rate_limit/i.test(all) ? 'AI 免費額度暫時用完，請稍後再試'
        : /API key|authentication|401/i.test(all) ? 'API 金鑰無效，請重新設定' : 'AI 服務拒絕請求';
  throw new Error(`${hint}（${all}）`);
}

/** 處理一個請求（Web 標準 Request → Response），可直接單元測試 */
export async function handle(req, env = process.env) {
  const cfg = config(env);
  const origin = req.headers.get('origin') || '';
  const cors = {
    'Access-Control-Allow-Origin': cfg.origins.includes(origin) ? origin : cfg.origins[0] || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
  });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method === 'GET') {
    return json({
      ok: true, build: cfg.build, region: process.env.VERCEL_REGION || '?', order: cfg.order.filter((p) => cfg[p]),
      gemini: cfg.gemini ? cfg.geminiModels : null, claude: cfg.claude ? cfg.claudeModel : null,
      accessCodeConfigured: !!cfg.code,
    });
  }
  if (req.method !== 'POST') return json({ error: '只接受 POST' }, 405);
  if (!cfg.origins.includes(origin)) return json({ error: '不允許的來源網站' }, 403);
  if (!cfg.code || (!cfg.gemini && !cfg.claude)) return json({ error: '服務尚未設定金鑰' }, 503);
  if (!safeEqual(req.headers.get('x-access-code'), cfg.code)) return json({ error: '通關密碼錯誤，請重新輸入' }, 401);

  let body;
  try { body = await req.json(); } catch { return json({ error: '請求格式錯誤' }, 400); }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt || prompt.length > MAX_PROMPT) return json({ error: `分析指令需為 1–${MAX_PROMPT} 字` }, 400);

  try {
    const r = await generate(cfg, prompt);
    return json({ ...r, createdAt: new Date().toISOString(), cached: false });
  } catch (e) {
    return json({ error: `${e.message}｜執行位置 ${process.env.VERCEL_REGION || '?'}` }, 502);
  }
}

export const GET = (req) => handle(req);
export const POST = (req) => handle(req);
export const OPTIONS = (req) => handle(req);
