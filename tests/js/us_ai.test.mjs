// 美股（usMarketRow、完整度、分析指令）與 Gemini 回覆的 Markdown 解析
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usMarketRow, summarize, completeness } from '../../assets/js/analytics.js';
import { buildPrompt } from '../../assets/js/prompt.js';
import { parseMarkdown } from '../../assets/js/ai.js';

const days = Array.from({ length: 300 }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10));
const detail = {
  shares: 1000,
  tables: {
    price: { cols: ['date', 'open', 'max', 'min', 'close', 'Trading_Volume'], rows: days.map((d, i) => [d, 100 + i, 101 + i, 99 + i, 100 + i, 1e6]) },
    income: { cols: ['date', 'type', 'value', 'origin_name'], rows: [
      ...['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'].flatMap((d) => [[d, 'EPS', 2, 'EPS'], [d, 'Revenue', 100, 'Revenue'], [d, 'IncomeAfterTaxes', 20, 'x']]),
      ['2026-03-31', 'EPS', 2.5, 'EPS'], ['2026-03-31', 'Revenue', 130, 'Revenue'], ['2026-03-31', 'IncomeAfterTaxes', 25, 'x']] },
    balance: { cols: ['date', 'type', 'value', 'origin_name'], rows: [['2026-03-31', 'Equity', 200000, 'Equity'], ['2026-03-31', 'TotalAssets', 400000, 'x']] },
  },
};

test('usMarketRow：本益比 = 收盤 ÷ 近四季 EPS，股價淨值比 = 收盤 ÷ 每股淨值', () => {
  const m = usMarketRow(detail);
  assert.equal(m.close, 399);
  assert.equal(m.change, 1);
  assert.equal(m.pe, 399 / 8.5);        // 2 + 2 + 2 + 2.5
  assert.equal(m.pb, 399 / 200);        // 權益 200,000 ÷ 1,000 股
  assert.equal(usMarketRow({ tables: {} }), null);
});

test('美股完整度不計台股專屬項目；分析指令用美股版', () => {
  const s = summarize({ info: { code: 'NVDA', name: 'NVIDIA', market: 'us', industry: 'NasdaqGS' }, mkt: usMarketRow(detail), tables: detail.tables, asOf: { twse: days.at(-1) } });
  const c = completeness(s);
  assert.ok(!c.missing.some((m) => /法人|融資|月營收|河流圖|殖利率/.test(m)), c.missing.join());
  assert.equal(s.fundamentals.revYoY, 30);                    // 130 vs 去年同季 100
  const p = buildPrompt(s, {}, []);
  assert.match(p, /^你是美股分析師，依下列數據分析 NVDA NVIDIA/);
  assert.match(p, /S&P 500/);
  assert.doesNotMatch(p, /undefined|NaN|籌碼|張/);
});

test('Markdown：標題、表格、清單、段落', () => {
  const b = parseMarkdown('## 結論\n評級 **偏多**\n\n| 項目 | 價位 |\n|---|---:|\n| 買進 | 100 |\n| 停損 | 90 |\n\n1. 第一\n2. 第二\n- a\n- b\n---\n結尾');
  assert.deepEqual(b.map((x) => x.type), ['h', 'p', 'table', 'ol', 'ul', 'hr', 'p']);
  assert.deepEqual(b[2], { type: 'table', head: ['項目', '價位'], rows: [['買進', '100'], ['停損', '90']] });
  assert.deepEqual(b[3].items, ['第一', '第二']);
});
