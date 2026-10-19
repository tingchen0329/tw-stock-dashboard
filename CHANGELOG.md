# 版本紀錄

格式：[語意化版本](https://semver.org/lang/zh-TW/)。每個版本都有 git tag，可用 `git checkout v5.1.0` 回到舊版。

## v6.0.0 — 2026-10-20

架構重寫：資料改由 GitHub Actions 伺服器端抓取，網頁只讀靜態 JSON。

### 安全
- FinMind token 改存 GitHub Secrets，只在 Actions 執行時使用；網頁不再有 token 輸入框
- token 只放 HTTP header（舊版放在網址 `?token=`，會出現在 proxy 與伺服器 log）
- 部署前自動掃描輸出，發現 token 即中止
- 所有外部文字改用 textContent（舊版 innerHTML 有 XSS 風險），並加上 Content-Security-Policy

### 修正
- 月營收月份晚一個月（FinMind `date` 是次月 1 日，改用 `revenue_year` / `revenue_month`）
- 日期用 UTC，台北 08:00 前會差一天
- 漲跌為 0 時顯示成缺資料
- Stooq 漲跌用「收盤 − 開盤」而非「收盤 − 昨收」
- 快速切換股票時可能顯示前一檔的資料（加入 AbortController）
- 圖表刻度未涵蓋資料範圍，線條超出圖框

### 新功能
- 全市場搜尋（上市、上櫃、興櫃、ETF，約 2,000+ 檔）：代號、名稱、部分名稱、全形、臺/台、產業別
- 鍵盤操作：`/` 聚焦搜尋、↑↓ 選擇、Enter 開啟；網址 `#2330` 可分享
- 技術指標（MA、KD、RSI、MACD、量比、區間報酬、價格位階）
- 本益比河流圖、月營收年增率圖、財報（近四季 EPS、三率、ROE、負債比）、籌碼（法人 5/20 日、外資持股、融資券）
- 總經列：加權、櫃買、匯率、美元指數、美債 10 年、黃金、費半、Fed 利率
- 資料完整度與各資料源狀態
- 「產生分析指令」：以真實數據組成深度分析 v2.0 提示詞
- Excel 匯出 5 個工作表（摘要、股價、月營收、三大法人、財報）
- 深色模式、手機版面
- FinMind Agent Skill（`/finmind`）與 `tw-stock-report` skill，終端機版 `scripts/summarize.mjs`

### 效能（詳見 docs/PERFORMANCE.md）
- 開頁到可用 3.94 s → 0.48 s；查詢 7.98 s → 0.10 s；公共 proxy 全掛時 60.7 s → 0.10 s

## v5.1.0 — 2026-05

單一 HTML；Stooq + FinMind + Yahoo + 證交所（透過公共 CORS proxy）；110 檔內建清單搜尋。
