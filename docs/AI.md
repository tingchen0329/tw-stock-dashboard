# Gemini AI 分析（Cloudflare Worker）

個股頁最下方的「Gemini AI 分析」：按下按鈕後，把「產生分析指令」的內容交給 Google Gemini，結論顯示在同一區塊。

```
網頁（GitHub Pages，公開）
   │  POST 分析指令 + 通關密碼（AI_ACCESS_CODE）
   ▼
Cloudflare Worker（worker/ai.js，免費方案）── 保管 GEMINI_API_KEY（Cloudflare 加密 Secret）
   │  檢查來源網站與通關密碼
   ▼
Google Gemini API
```

- **Gemini 金鑰不在網頁裡**：網站是公開的，金鑰放進網頁任何人都能拿去用。金鑰只存在 GitHub Secrets，
  由 `.github/workflows/ai-worker.yml` 部署時寫進 Cloudflare。網頁只知道 Worker 網址（`assets/ai.json`）
- **通關密碼**：防止陌生人用你的網站耗用 Gemini 免費額度。第一次使用時在網頁輸入，只存在那台瀏覽器
- AI 回覆以純文字顯示（自行解析 Markdown，不使用 innerHTML），回覆內容無法在網頁上執行程式

## 一次性設定

### 1. Gemini API 金鑰
1. https://aistudio.google.com/apikey → 用 Google 帳號登入 → **Create API key**
2. 選一個 Google Cloud 專案（沒有就讓它自動建立）→ 複製 `AIza` 開頭的金鑰
3. 免費方案不需要信用卡；不要按「Set up billing」

### 2. Cloudflare 帳號與權杖
1. https://dash.cloudflare.com/sign-up 註冊（免費）
2. 左側 **Workers & Pages**；第一次會要你設定 workers.dev 子網域，取一個名字即可
3. **Account ID**：Workers & Pages 頁面右側欄（或網址 `dash.cloudflare.com/` 後的 32 碼）
4. 右上角頭像 → **My Profile** → **API Tokens** → **Create Token** → 範本 **Edit Cloudflare Workers** →
   Account Resources 選你的帳號、Zone Resources 選 All zones → **Create Token** → 複製

### 3. GitHub Secrets
Settings → Secrets and variables → Actions → **New repository secret**，新增 4 個：

| Name | 內容 |
|---|---|
| `GEMINI_API_KEY` | 步驟 1 的金鑰 |
| `CLOUDFLARE_API_TOKEN` | 步驟 2 的權杖 |
| `CLOUDFLARE_ACCOUNT_ID` | 步驟 2 的 Account ID |
| `AI_ACCESS_CODE` | 自訂通關密碼（12 字以上） |

### 4. 部署
Actions → **Deploy AI worker** → **Run workflow**。完成後執行頁面上方會顯示 Worker 網址，
把它填進 `assets/ai.json` 的 `url`（例如 `{"url": "https://tw-stock-ai.xxx.workers.dev"}`）並 push。

## 調整
- **換模型**：`worker/wrangler.toml` 的 `GEMINI_MODEL`（模型名稱見 https://ai.google.dev/gemini-api/docs/models ），push 後自動重新部署
- **換通關密碼**：更新 GitHub Secret `AI_ACCESS_CODE` → 重新執行 Deploy AI worker → 網頁按「更換通關密碼」
- **停用**：把 `assets/ai.json` 的 `url` 改成空字串

## 疑難排解
| 訊息 | 原因 |
|---|---|
| 通關密碼錯誤 | 與 `AI_ACCESS_CODE` 不符（大小寫、空白） |
| 不允許的來源網站 | 從 `ALLOWED_ORIGINS`（wrangler.toml）以外的網址開啟 |
| Gemini 免費額度暫時用完 | 等一段時間再試，額度見 Google AI Studio |
| Gemini 拒絕請求 | 金鑰錯誤或模型名稱已停用：檢查 `GEMINI_API_KEY` 與 `GEMINI_MODEL` |
