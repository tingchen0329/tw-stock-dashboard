// AI 代理（tw-stock-ai-proxy/api/ai.js）：來源、通關密碼、Gemini → Claude 備援
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, generate, parseOrder } from '../../tw-stock-ai-proxy/api/ai.js';

const ENV = { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'c', AI_ACCESS_CODE: 'pw', ALLOWED_ORIGINS: 'https://site.test' };
const post = (body, headers = {}) => new Request('https://proxy.test/api/ai', {
  method: 'POST', headers: { origin: 'https://site.test', 'x-access-code': 'pw', 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const cfg = (o = {}) => ({ gemini: 'g', claude: 'c', geminiModels: ['gm'], claudeModel: 'cm', order: ['gemini', 'claude'], ...o });

test('Gemini 成功就不呼叫 Claude', async () => {
  let claude = 0;
  const r = await generate(cfg(), 'p', { gemini: async () => ({ text: 'G', model: 'gm' }), claude: async () => { claude++; return { text: 'C', model: 'cm' }; } });
  assert.deepEqual([r.provider, r.text, claude], ['gemini', 'G', 0]);
});

test('Gemini 額度用完 → 改用 Claude，並附上原因', async () => {
  const r = await generate(cfg(), 'p', {
    gemini: async () => { throw new Error('gm：HTTP 429 RESOURCE_EXHAUSTED'); },
    claude: async () => ({ text: 'C', model: 'cm' }),
  });
  assert.equal(r.provider, 'claude');
  assert.match(r.fallback, /429/);
});

test('只有 Claude 金鑰也能用；兩者都失敗時給出可讀的提示', async () => {
  const r = await generate(cfg({ gemini: '' }), 'p', { gemini: async () => assert.fail(), claude: async () => ({ text: 'C', model: 'cm' }) });
  assert.equal(r.provider, 'claude');
  await assert.rejects(generate(cfg(), 'p', {
    gemini: async () => { throw new Error('HTTP 400 User location is not supported'); },
    claude: async () => { throw new Error('HTTP 400 Your credit balance is too low'); },
  }), /Claude 預付額度不足/);
});

test('來源網站與通關密碼檢查', async () => {
  assert.equal((await handle(post({ prompt: 'x' }, { origin: 'https://evil.test' }), ENV)).status, 403);
  const bad = await handle(post({ prompt: 'x' }, { 'x-access-code': 'nope' }), ENV);
  assert.equal(bad.status, 401);
  assert.match((await bad.json()).error, /通關密碼/);
  assert.equal((await handle(post({ prompt: '' }), ENV)).status, 400);
});

test('健康檢查不洩漏金鑰', async () => {
  const res = await handle(new Request('https://proxy.test/api/ai'), ENV);
  const txt = await res.text();
  assert.match(txt, /"ok":true/);
  assert.doesNotMatch(txt, /"g"|"c"|"pw"/);
});

test('AI_ORDER：Claude 優先時不呼叫 Gemini；設定值寬鬆解析', async () => {
  assert.deepEqual(parseOrder('Claude, gemini'), ['claude', 'gemini']);
  assert.deepEqual(parseOrder('claude'), ['claude', 'gemini']);
  assert.deepEqual(parseOrder('xx'), ['gemini', 'claude']);
  let gem = 0;
  const r = await generate(cfg({ order: ['claude', 'gemini'] }), 'p', { gemini: async () => { gem++; return { text: 'G', model: 'gm' }; }, claude: async () => ({ text: 'C', model: 'cm' }) });
  assert.deepEqual([r.provider, gem, r.fallback], ['claude', 0, null]);
});
