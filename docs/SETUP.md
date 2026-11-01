# 設定指南：FinMind token（GitHub Secrets）與 GitHub Pages

全部只需做一次，約 5 分鐘。

## 為什麼 token 要放在 Secrets，而不是網頁裡？

GitHub Pages 是靜態網站，**放在網頁裡的任何東西，任何人按「檢視原始碼」都看得到**。
就算把 token 在部署時「注入」到 HTML，它一樣會公開在網站上。

所以本專案的做法是：

```
GitHub Secrets (FINMIND_TOKEN)
   │  只在 Actions 執行期間以環境變數提供
   ▼
scripts/fetch_data.py（GitHub 伺服器上執行）
   │  token 放在 HTTP Authorization header 呼叫 FinMind
   │  輸出前掃描所有檔案，發現 token 就中止、不部署
   ▼
_site/data/*.json（不含 token）
   ▼
GitHub Pages ── 瀏覽器只讀這些 JSON
```

> 如果你之前曾把 token 貼在任何對話、截圖或程式碼裡，請先到 FinMind 會員中心**重新產生一組新的**，
> 再放進 Secrets。舊的視同已外洩。

## 步驟 1：新增 Secret

1. 打開 repo → **Settings** → 左側 **Secrets and variables** → **Actions**
2. 按 **New repository secret**
3. Name：`FINMIND_TOKEN`（必須完全一致）
4. Secret：貼上 FinMind token（登入 https://finmindtrade.com/ → 會員中心取得）
5. **Add secret**

Secret 存入後連你自己都無法再查看內容，只能覆寫；Actions log 中也會自動遮蔽成 `***`。

## 步驟 2：Pages 改用 GitHub Actions 部署

1. **Settings** → **Pages**
2. **Build and deployment** → **Source** 選 **GitHub Actions**（原本是 Deploy from a branch）

## 步驟 3：第一次執行

1. **Actions** 分頁 → 左側 **Update data & deploy** → **Run workflow**
2. 約 2 分鐘後完成。點進該次執行，**Summary** 會列出每個資料源的狀態表
3. 打開 `https://tingchen0329.github.io/tw-stock-dashboard/`

## 步驟 4：外部排程（建議）

GitHub 內建排程常延遲數小時，請依 [docs/SCHEDULER.md](SCHEDULER.md) 設定 cron-job.org（免費）準時觸發。
每次執行都先取回網站上目前的資料，再由 smart 模式依時間只更新需要的部分：

| 時段（台北） | 模式 | 更新內容 | FinMind 請求 |
|---|---|---|---|
| 交易日 09:40–14:40 每小時、push | auto | 全市場行情、選股資料、追蹤清單盤中價、總經；個股只抓新加入清單的 | 約 3 次（+ 新股每檔 8 次） |
| 交易日 16:40、19:40 | full | 全部，含追蹤清單每檔 3 年個股資料 | 約 510 次（68 檔） |
| 21:40、23:40、02:40、05:40 | macro | 總經（台指期夜盤、美股） | 約 2–4 次 |

沒有設定外部排程時，GitHub 備援排程（19:37、05:17）每天仍會更新，只是可能延遲。

FinMind 的個股資料（日線、法人、融資券、財報）本來就只在收盤後更新，所以只在收盤後完整重抓。
網站讀不到時會自動改成 full；FinMind 額度用完時，沒抓到的個股沿用上一份，下一次執行再補。
Actions 頁面手動 **Run workflow** 時可以選模式（預設 auto）。
GitHub 排程在尖峰時段常延遲 5–20 分鐘，偶爾會略過一次，屬正常現象。

## 修改追蹤清單

清單在 `config/watchlist.csv`，順序就是網頁上的顯示順序。兩種改法：

- **整份換掉**：從 Yahoo 股市整理好清單後存成 CSV，到 GitHub 的 `config/` 資料夾 → **Add file → Upload files**，
  檔名用 `watchlist.csv` 覆蓋 → Commit。格式寬鬆：有「股票代號」或「Symbol」欄就行，`2330`、`2330.TW`、`5347.TWO` 都看得懂
- **加減幾檔**：在 GitHub 上打開 `config/watchlist.csv` → 鉛筆圖示 → 新增或刪除一行 → Commit

存檔後自動部署：新加入的股票幾分鐘內就有完整資料，移除的會從網站上刪掉。

**美股清單**在 `config/us_watchlist.csv`（`Symbol,Name` 兩欄，例如 `NVDA,NVIDIA`），改法相同。
美股資料來自 Yahoo 與 SEC，不使用 FinMind 額度；SEC 財報只在每天收盤後完整更新時重抓。

額度：每次完整更新每檔約 8 個 FinMind 請求（ETF 4 個，沒有本益比、營收、財報），免費會員每小時 600 次，
清單上限約 **70 檔**（測試會檢查這個上限）。清單外的股票仍然可以搜尋，網頁會用 FinMind 免 token 額度即時查詢（每個 IP 每小時 300 次）。

## 疑難排解

| 狀況 | 原因 / 解法 |
|---|---|
| 網頁顯示「還沒有資料」 | 步驟 2 沒改成 GitHub Actions，或還沒跑過 workflow |
| 橫幅「FinMind token 尚未設定」 | Secret 名稱不是 `FINMIND_TOKEN`，或設在 Environment secrets 而非 Repository secrets |
| Summary 中某個來源 ❌、筆數 0 | 該來源暫時失敗或改了欄位名稱。其他來源照常部署；連續失敗請開 issue 附上 Summary |
| `tpex_inst` 0 筆 | 櫃買三大法人沒有穩定的公開欄位文件，採關鍵字比對（best-effort）。追蹤清單內的上櫃股仍有 FinMind 法人資料 |
| `FinMind 額度用完 (HTTP 402)` | 一小時內請求太多；減少追蹤清單或等下一個小時。全市場行情不受影響 |
| 排程突然不跑了 | 公開 repo **60 天沒有任何 commit**，GitHub 會自動停用排程。到 Actions 頁面按 Enable 或 push 任何變更即可 |
| 總覽表某檔顯示 N/A | 那檔的個股資料還沒抓到（剛加入清單或額度用完），下一次執行會補；ETF 的本益比、營收、財報本來就是 N/A |
| 夜間執行的 Summary 寫「只更新總經」 | 正常。個股與全市場資料夜間不會變，沿用上一次完整更新；頁首會分別顯示資料更新與總經時間 |
| 平日出現「臨時休市」橫幅 | 15:00 後證交所收盤資料與加權指數都停在前一個交易日（颱風停市等）。若誤判，通常是證交所資料延遲，下一次排程會自動更正 |
| 本機雙擊 index.html 是空白 | 瀏覽器禁止 file:// 讀 JSON。改用 `./scripts/preview.sh` |

## 本機使用 token（選用）

```bash
export FINMIND_TOKEN="你的 token"     # Windows PowerShell：$env:FINMIND_TOKEN="你的 token"
./scripts/preview.sh --live           # 用真實資料預覽
node scripts/summarize.mjs 2330       # 終端機個股摘要
```
不要把 token 寫進任何檔案；`.env` 已列在 `.gitignore`。
