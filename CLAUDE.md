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
- `assets/js/`：`analytics.js`（純計算）、`market.js`（開休市，純計算）、`search.js`、`charts.js`（SVG）、`render.js`（DOM）、`overview.js`（總覽表）、`screen.js`（選股）、`prompt.js`（分析指令）、`main.js`（狀態與事件）。
- `fetch_data.py --mode full|auto|macro --base-url`：先取回網站上的上一份資料。full（16:23、19:37）個股全部重抓；auto（盤中、push）個股只抓缺的；macro（夜間）只更新總經。取不到網站資料就改 full。
- `--mode smart`（排程用）：`decide_mode()` 依現在時間與 meta.fullAt 選 full / auto / macro；主要由 cron-job.org 呼叫 workflow_dispatch（docs/SCHEDULER.md），GitHub schedule 只留 2 個備援。
- `screen.json`：全市場選股資料（證交所 t187ap05_L / t187ap06_L_*、櫃買 mopsfin_t187ap05_O / mopsfin_t187ap06_O_*），條件在 `assets/js/screen.js`。不花 FinMind 額度。
- `scripts/build_overview.mjs`：fetch 之後執行，用 analytics.js 產生 `overview.json`（網頁首頁總覽表）。
- `config/watchlist.csv`：追蹤清單（Yahoo 自選股 CSV，順序即顯示順序）。約 70 檔是 FinMind 免費額度上限（`test_repo_watchlist_is_valid` 會檢查）。
- 測試用清單是 `tests/fixtures/watchlist.json`（對應 fixtures 的合成資料），不是正式清單。

## 必守規則
- **FinMind token 絕不可出現在前端程式、網站輸出或 commit 中。** 只存在 GitHub Secrets `FINMIND_TOKEN` 與本機環境變數。
- 外部資料（股票名稱等）寫進 DOM 一律用 `textContent` / `render.js` 的 `h()`，不用 `innerHTML`。
- `index.html` 有 CSP（`script-src 'self'`）：不可加行內 `<script>` 或 `style="..."` 屬性。
- FinMind 月營收的月份用 `revenue_year` / `revenue_month`，不要用 `date`（date 是次月 1 日）。
- 缺資料顯示 N/A，不要用 0 或推估值填補。

## Skills
- `/finmind`：FinMind 官方 Agent Skill（`.claude/commands/finmind.md`），自然語言查 75+ 資料集。需 `FINMIND_TOKEN`。
- `tw-stock-report`：用與網頁相同的計算產生分析報告（結論、價位表、六面向）（`.claude/skills/tw-stock-report/`）。
