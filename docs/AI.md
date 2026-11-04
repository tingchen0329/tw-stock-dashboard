# AI 報告（Gemini 免費優先，Claude 備援）

個股頁標題列的 **產生 AI 報告**：把「產生分析指令」的內容交給 AI，報告顯示在個股頁最下方的「AI 報告」區塊。

```
網頁（GitHub Pages，公開）
   │  POST 分析指令 + 通關密碼（AI_ACCESS_CODE）
   ▼
AI 代理（Vercel Function，tw-stock-ai-proxy/，固定在美國東岸 iad1）── 保管 API 金鑰
   │  1. Google Gemini（免費）
   │  2. 失敗（額度用完、地區限制…）→ Anthropic Claude（預付）
   ▼
報告（Markdown → 網頁以純文字安全顯示）
```

## 為什麼用 Vercel，不用 Cloudflare Worker
Cloudflare 免費方案會在**離使用者最近的機房**執行，從台灣連線時常由香港機房送出，
而 Gemini 與 Claude 都不開放香港（實際錯誤：`FAILED_PRECONDITION User location is not supported`，
執行位置 `TW/HKG`）。Vercel 免費方案可以把函式固定在美國（`vercel.json` 的 `regions`）。

## 需要的 GitHub Secrets

| Name | 來源 | 必要性 |
|---|---|---|
| `VERCEL_TOKEN` | Vercel → Account Settings → Tokens | 必要 |
| `AI_ACCESS_CODE` | 自訂通關密碼（12 字以上） | 必要 |
| `GEMINI_API_KEY` | Google AI Studio（免費） | 與 Claude 至少一個 |
| `ANTHROPIC_API_KEY` | console.anthropic.com（預付） | 選用（Gemini 失敗時備援） |

設定步驟見 README「步驟 5」。設定好後到 Actions → **Deploy AI proxy** → **Run workflow**，
workflow 會自動把代理網址寫進 `assets/ai.json` 並重新部署網站。

## 調整
- **Gemini 模型**：部署時加環境變數 `GEMINI_MODELS`（逗號分隔、依序嘗試），預設 `gemini-3.8-flash`
- **Claude 模型**：GitHub Variable `CLAUDE_MODEL`，預設 `claude-sonnet-5-5`（可改 `claude-haiku-5-5` 省錢、`claude-opus-5-5` 最完整）
- **供應商順序**：GitHub Variable `AI_ORDER`，預設 `gemini,claude`；設 `claude,gemini` 改成 Claude 優先（改完重跑 Deploy AI proxy）
- Gemini 模型可在 `.github/workflows/ai-proxy.yml` 的 Deploy 步驟加 `--env "GEMINI_MODELS=..."`
- **只用 Gemini**：不要設定 `ANTHROPIC_API_KEY`；**只用 Claude**：不要設定 `GEMINI_API_KEY`
- **停用**：把 `assets/ai.json` 的 `url` 改成空字串

## 疑難排解（報告區塊顯示的訊息）
| 訊息 | 原因 / 解法 |
|---|---|
| 通關密碼錯誤 | 與 `AI_ACCESS_CODE` 不符（大小寫、空白） |
| 不允許的來源網站 | 從網站以外的網址開啟 |
| AI 免費額度暫時用完 | Gemini 額度用完且沒有設定 Claude；稍後再試或加上 `ANTHROPIC_API_KEY` |
| Claude 預付額度不足 | 到 console.anthropic.com → Billing 儲值 |
| API 金鑰無效 | 對應的 Secret 貼錯，更新後重跑 Deploy AI proxy |
| 報告下方寫「Gemini 無法使用，已改用 Claude」 | 正常的備援行為；括號原因可在瀏覽器開發者工具的回應中看到 |
| Deploy AI proxy 健康檢查失敗 | 看部署紀錄：`VERCEL_TOKEN` 錯誤或過期 |
