# 台股研究台 (tw-stock-dashboard)

個人台股研究儀表板。GitHub Actions 定時抓資料 → 靜態 JSON → GitHub Pages 網頁。

## 常用指令
```bash
python -m unittest discover -s tests/py        # Python 測試（資料管線）
node --test "tests/js/*.test.mjs"              # JS 測試（搜尋、指標、匯出）
python tests/e2e/test_dashboard.py             # 瀏覽器端對端測試（需 playwright）
./scripts/preview.sh                           # 本機預覽（合成資料）→ http://localhost:8000
./scripts/preview.sh --live                    # 本機預覽（真實資料，需 FINMIND_TOKEN）
node scripts/summarize.mjs 2330 --prompt       # 終端機版個股摘要 / 分析指令
python tests/bench/run_bench.py                # 新舊版效能比較
```

## 架構
- `scripts/fetch_data.py`：伺服器端抓資料（只用標準函式庫）。FinMind token 只從環境變數讀、只放 HTTP header。
- `assets/datasets.json`：FinMind 資料集規格，Python 與網頁共用 —— 改欄位要兩邊一起生效，只改這一個檔。
- `assets/js/`：`analytics.js`（純計算）、`market.js`（開休市，純計算）、`search.js`、`charts.js`（SVG）、`render.js`（DOM）、`overview.js`（總覽表）、`screen.js`（選股）、`ai.js`（AI 報告區塊）、`prompt.js`（分析指令）、`main.js`（狀態與事件）。
- `fetch_data.py --mode full|auto|macro --base-url`：先取回網站上的上一份資料。full（16:23、19:37）個股全部重抓；auto（盤中、push）個股只抓缺的；macro（夜間）只更新總經。取不到網站資料就改 full。
- `--mode smart`（排程用）：`decide_mode()` 依現在時間與 meta.fullAt 選 full / auto / macro；主要由 cron-job.org 呼叫 workflow_dispatch（docs/SCHEDULER.md），GitHub schedule 只留 2 個備援。
- `screen.json`：全市場選股資料（證交所 t187ap05_L / t187ap06_L_*、櫃買 mopsfin_t187ap05_O / mopsfin_t187ap06_O_*），條件在 `assets/js/screen.js`。不花 FinMind 額度。
- 美股：`scripts/us_data.py`（Yahoo 3 年日線 + SEC companyfacts，轉成與 FinMind 相同的表格格式）→ `us/stock/<代號>.json`；`config/us_watchlist.csv`。網頁路由 `#us`、`#us/NVDA`、`#us-screen`，`analytics.usMarketRow()` 算本益比 / 股價淨值比；`per_table()` 產生每日 PER（只用公布 45 天以上的 EPS）。
- 美股選股：`scripts/us_screen.py`（S&P 500 清單 + SEC frames API + Yahoo）→ `us/screen.json`，只在 full 或檔案不存在時重建；條件在 `screen.js` 的 `US_PRESETS`。美股開休市在 `market.js` 的 `usMarketStatus()`（NYSE_HOLIDAYS 每年要補）。
- AI 報告：`tw-stock-ai-proxy/api/ai.js`（Vercel Function，固定 iad1；供應商順序由 `AI_ORDER` 決定（預設 gemini,claude），`CLAUDE_MODEL` 換模型；保管 GEMINI_API_KEY / ANTHROPIC_API_KEY / AI_ACCESS_CODE，由 `.github/workflows/ai-proxy.yml` 部署並自動寫 `assets/ai.json`）。不用 Cloudflare：免費方案從台灣走香港機房，Gemini / Claude 都不開放香港。AI 金鑰絕不可出現在網頁。
- 相對大盤與風險：`macro.json` 的 `bench`（Yahoo ^TWII / ^GSPC 2 年日線）→ `analytics.riskStats()`（Beta、波動度、最大回撤、相對報酬）。美股現金流量表是年初至今累計，`us_data.quarterly_from_ytd()` 拆成單季算自由現金流。
- 總經：`macro.json`（精簡，每次載入）+ `macro_hist.json`（約一年日線，點總經卡片才讀，`write_macro()` 寫）。Yahoo 漲跌用交易所當地日期判斷昨收（美股收盤在台北隔天凌晨）。
- 慢速資料集（`datasets.json` 的 `wave: 3`：股利、除權息、現金流量表）：網頁不即時查；`refresh_slow()` 每次執行只更新 `SLOW_BUDGET` 檔（最久沒更新優先、7 天內不重抓），避免超過 FinMind 每小時 600 次。
- 美股內部人：`us_data.fetch_insider()`（SEC submissions + Form 4 XML，依 accession 快取，只在 full 抓）→ us/stock 檔的 `insider`。
- 同業比較：`analytics.peerStats()` 用 screen.json（產業別）/ us/screen.json（GICS sector），個股頁背景載入。
- `scripts/build_overview.mjs`：fetch 之後執行，用 analytics.js 產生 `overview.json`（網頁首頁總覽表）。
- `config/watchlist.csv`：追蹤清單（Yahoo 自選股 CSV，順序即顯示順序）。約 70 檔是 FinMind 免費額度上限（`test_repo_watchlist_is_valid` 會檢查）。
- 測試用清單是 `tests/fixtures/watchlist.json`（對應 fixtures 的合成資料），不是正式清單。

## 必守規則
- **FinMind token、Gemini / Claude 金鑰、Vercel 權杖絕不可出現在前端程式、網站輸出或 commit 中。** 只存在 GitHub Secrets `FINMIND_TOKEN` 與本機環境變數。
- 外部資料（股票名稱等）寫進 DOM 一律用 `textContent` / `render.js` 的 `h()`，不用 `innerHTML`。
- `index.html` 有 CSP（`script-src 'self'`）：不可加行內 `<script>` 或 `style="..."` 屬性。
- FinMind 月營收的月份用 `revenue_year` / `revenue_month`，不要用 `date`（date 是次月 1 日）。
- 缺資料顯示 N/A，不要用 0 或推估值填補。

## Skills
- `/finmind`：FinMind 官方 Agent Skill（`.claude/commands/finmind.md`），自然語言查 75+ 資料集。需 `FINMIND_TOKEN`。
- `tw-stock-report`：用與網頁相同的計算產生分析報告（結論、價位表、六面向）（`.claude/skills/tw-stock-report/`）。
