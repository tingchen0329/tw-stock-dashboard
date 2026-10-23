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

之後每個交易日會自動執行（台北時間 09:12–13:12 每小時、13:47、16:23、19:37；夜盤與美股時段 21:47、23:47、02:17、05:17），push 到 main 時也會重新部署。
GitHub 排程在尖峰時段常延遲 5–20 分鐘，偶爾會略過一次，屬正常現象。

## 修改追蹤清單

編輯 `config/watchlist.json` 的 `stocks` 陣列並 push。每檔每次約 8 個 FinMind 請求；
免費會員每小時 600 次，以每小時最多跑 1 次計算，清單建議 **40 檔以內**。
清單外的股票仍然可以搜尋，網頁會用 FinMind 免 token 額度即時查詢（每個 IP 每小時 300 次）。

## 疑難排解

| 狀況 | 原因 / 解法 |
|---|---|
| 網頁顯示「還沒有資料」 | 步驟 2 沒改成 GitHub Actions，或還沒跑過 workflow |
| 橫幅「FinMind token 尚未設定」 | Secret 名稱不是 `FINMIND_TOKEN`，或設在 Environment secrets 而非 Repository secrets |
| Summary 中某個來源 ❌、筆數 0 | 該來源暫時失敗或改了欄位名稱。其他來源照常部署；連續失敗請開 issue 附上 Summary |
| `tpex_inst` 0 筆 | 櫃買三大法人沒有穩定的公開欄位文件，採關鍵字比對（best-effort）。追蹤清單內的上櫃股仍有 FinMind 法人資料 |
| `FinMind 額度用完 (HTTP 402)` | 一小時內請求太多；減少追蹤清單或等下一個小時。全市場行情不受影響 |
| 排程突然不跑了 | 公開 repo **60 天沒有任何 commit**，GitHub 會自動停用排程。到 Actions 頁面按 Enable 或 push 任何變更即可 |
| 本機雙擊 index.html 是空白 | 瀏覽器禁止 file:// 讀 JSON。改用 `./scripts/preview.sh` |

## 本機使用 token（選用）

```bash
export FINMIND_TOKEN="你的 token"     # Windows PowerShell：$env:FINMIND_TOKEN="你的 token"
./scripts/preview.sh --live           # 用真實資料預覽
node scripts/summarize.mjs 2330       # 終端機個股摘要
```
不要把 token 寫進任何檔案；`.env` 已列在 `.gitignore`。
