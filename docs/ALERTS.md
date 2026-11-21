# 到價通知（推播到手機）

GitHub Actions 每次更新資料後（盤中約每 30 分鐘、收盤後、夜間）會執行 `scripts/alerts.mjs`，
檢查你設定的條件；條件**由不成立變成成立**時推播一次到 Discord 或 Telegram，不會每次更新都重複通知。

LINE Notify 已於 2025-03-31 停止服務，所以改用 Discord / Telegram（都免費）。

## 1. 設定推播管道（擇一，或兩個都設）

所有值都放 **GitHub Secrets**（repo → Settings → Secrets and variables → Actions → **Secrets** 分頁 → New repository secret）。
**不要**貼在聊天、Issue 或 commit 裡；Secret 存進去之後連你自己都看不到內容，只有 Actions 執行時能用。

### Discord（最簡單）

1. 在自己的 Discord 伺服器建一個頻道（例如 `#股票通知`），手機 App 開啟通知
2. 頻道 ⚙ 編輯頻道 → **整合** → **Webhook** → **新 Webhook** → **複製 Webhook 網址**
3. GitHub Secret：名稱 `DISCORD_WEBHOOK_URL`，值貼上剛剛的網址

### Telegram

1. 在 Telegram 搜尋 **@BotFather** → `/newbot` → 照指示取名 → 得到 bot token（`123456:ABC…`）
2. 搜尋你剛建立的機器人，按 **Start**，隨便傳一句話
3. 用瀏覽器開 `https://api.telegram.org/bot<你的token>/getUpdates`，找 `"chat":{"id":` 後面的數字（chat id）
4. GitHub Secrets：`TELEGRAM_BOT_TOKEN`（token）、`TELEGRAM_CHAT_ID`（chat id）

## 2. 設定規則

網站 **持股 → 到價通知** 可以用表單產生規則（或按「依持股成本產生停損 −10% / 停利 +20%」），
按「複製規則」後存成 GitHub Secret **`ALERT_RULES`**。

一行一條：`代號,條件,數值,備註`，`#` 開頭是註解：

```
# 台股
2330,價格<=,900,停損
2330,價格>=,1200,停利
2454,跌幅>=,5,單日大跌
2317,RSI<=,30
3037,跌破MA20
# 美股（US: 可省略）
US:NVDA,價格<=,150
# 總經：MACRO:keep = 全市場擔保維持率；也可用 taiex、otc、vix、usdtwd、us10y…
MACRO:keep,<=,160,融資斷頭壓力
MACRO:vix,>=,30
```

| 條件 | 意思 |
|---|---|
| `價格<=`、`價格>=`（也可寫 `<=`、`>=`） | 最新價（台股追蹤清單為盤中價，約延遲 20 分鐘） |
| `漲幅>=`、`跌幅>=` | 今日漲跌幅（%） |
| `RSI<=`、`RSI>=` | RSI(14)，只有追蹤清單 |
| `本益比<=` | 本益比 |
| `千張大戶週增減>=` | 集保千張大戶持股比例週變化（百分點），只有台股追蹤清單 |
| `站上MA20`、`跌破MA20` | 最新價與 20 日均線（不用填數值），只有追蹤清單 |

規則放在 Secret（不公開）。網站上只顯示「幾條規則、推播管道、最後檢查時間」，
狀態檔 `alerts_state.json` 只存規則的雜湊 id 與是否成立，不含代號與價位。

> 也可以把規則放在 `config/alerts.csv`（沒有 `ALERT_RULES` 時才讀），但 repo 是公開的，**大家都看得到你的價位**。

## 3. 確認

**Actions → Update data & deploy → Run workflow**，跑完後：

- 執行紀錄的 **Price alerts** 步驟會顯示「N 條規則，本次觸發 M 條；推播管道：Discord」
- 規則格式錯誤會以黃色 warning 列出行號
- 網站 **持股** 頁的「到價通知」狀態會顯示規則條數與最後檢查時間

推播失敗（例如 Webhook 被刪除）只會出現 warning，不影響網站更新；沒送出的通知下次執行會再試。
