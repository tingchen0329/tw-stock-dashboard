# 台股研究台 (tw-stock-dashboard)

個人台股 / 美股研究儀表板。打開網頁就能看到追蹤清單總覽、技術指標、本益比河流圖、月營收、籌碼、財報、全市場選股，
還能一鍵產生 AI 分析報告（Gemini）或可貼到任何 AI 的分析指令，並匯出 CSV / Excel。

**網站**：https://tingchen0329.github.io/tw-stock-dashboard/

![淺色模式（示範資料）](docs/screenshot-light.webp)

> 這份 README 前半段是**給初學者的完整設定教學**：照著做就能從零架好整個網站，不需要寫程式。
> 後半段是功能說明與開發者資訊。所有服務都有免費方案，預設 **每月 NT$0**。

---

## 目錄

1. [它是怎麼運作的](#1-它是怎麼運作的)
2. [先認識幾個名詞](#2-先認識幾個名詞)
3. [需要哪些帳號](#3-需要哪些帳號)
4. [設定總表（一張表看完）](#4-設定總表一張表看完)
5. [逐步設定](#5-逐步設定)
   - [步驟 1：FinMind token（必要）](#步驟-1finmind-token必要)
   - [步驟 2：開啟 GitHub Pages（必要）](#步驟-2開啟-github-pages必要)
   - [步驟 3：第一次更新資料（必要）](#步驟-3第一次更新資料必要)
   - [步驟 4：外部排程 cron-job.org（建議）](#步驟-4外部排程-cron-joborg建議)
   - [步驟 5：AI 報告 Gemini + Claude（選用）](#步驟-5ai-報告-gemini--claude選用)
   - [步驟 6：美股財報 SEC 聯絡資訊（選用）](#步驟-6美股財報-sec-聯絡資訊選用)
6. [日常使用](#6-日常使用)
7. [修改追蹤清單](#7-修改追蹤清單)
8. [金鑰與權杖管理](#8-金鑰與權杖管理)
9. [常見問題](#9-常見問題)
10. [費用](#10-費用)

---

## 1. 它是怎麼運作的

```
                    ┌──────────── GitHub（你的 repo）────────────┐
cron-job.org ──觸發──▶ Actions：抓資料（證交所、櫃買、FinMind、Yahoo、SEC）│
（準時排程）          │    └─ 用 Secrets 裡的 FinMind token（不公開）  │
                    │    ▼                                       │
                    │  Pages：公開網站（只有整理好的資料，沒有任何金鑰）│
                    └────────────────────┬───────────────────────┘
                                         ▼
                                   你的瀏覽器
                                         │ 按「產生 AI 報告」
                                         ▼
                    Vercel 代理（保管 AI 金鑰）──▶ Gemini（免費）→ 失敗改用 Claude
```

- **資料由 GitHub 幫你定時抓好**，網頁只讀整理好的檔案，所以打開很快
- **所有金鑰都不會出現在網頁上**：網站是公開的，任何人按「檢視原始碼」都看得到網頁裡的東西，
  所以金鑰只放在 GitHub Secrets 和 Vercel 這種「只有你看得到」的地方

## 2. 先認識幾個名詞

| 名詞 | 白話解釋 |
|---|---|
| **repo**（儲存庫） | 放這個專案所有檔案的地方：https://github.com/tingchen0329/tw-stock-dashboard |
| **GitHub Actions** | GitHub 提供的免費「自動執行程式」服務。本專案用它定時抓資料、部署網站。repo 上方的 **Actions** 分頁可以看每次執行結果 |
| **workflow** | 一份 Actions 的工作清單。本專案有 3 個：**Update data & deploy**（抓資料＋更新網站）、**Deploy AI proxy**（部署 AI 報告代理）、**CI**（測試） |
| **Run workflow** | 在 Actions 頁面手動執行某個 workflow 的按鈕 |
| **GitHub Pages** | GitHub 提供的免費網站空間，網址 `你的帳號.github.io/repo名稱` |
| **Secret（機密）** | 存在 GitHub 的加密值，例如 API 金鑰。存進去之後連你自己都看不到內容，只有 Actions 執行時能用 |
| **Variable（變數）** | 也存在 GitHub，但**不加密**、會出現在執行紀錄。只能放不機密的設定 |
| **API 金鑰 / token / 權杖** | 證明「這個請求是你本人」的一串字，像密碼一樣不能外流 |
| **commit** | 在 GitHub 網頁上改完檔案後按的「存檔」，存檔後網站會自動更新 |

## 3. 需要哪些帳號

| 服務 | 用途 | 必要性 | 註冊網址 |
|---|---|---|---|
| GitHub | 放程式、自動抓資料、架網站 | **必要** | https://github.com |
| FinMind | 追蹤清單的個股完整資料（3 年日線、法人、財報） | **必要** | https://finmindtrade.com |
| cron-job.org | 準時觸發更新（GitHub 內建排程常延遲數小時） | 建議 | https://cron-job.org |
| Google AI Studio | Gemini API 金鑰（AI 報告） | 選用 | https://aistudio.google.com |
| Vercel | 保管 AI 金鑰的小服務（代理） | 選用（用 AI 報告才需要） | https://vercel.com/signup |
| Anthropic Console | Claude API 金鑰（Gemini 的備援，需預付） | 選用 | https://console.anthropic.com |

除了 Claude（預付制，選用）之外都有免費方案，**不需要綁信用卡**。

## 4. 設定總表（一張表看完）

GitHub 的設定位置都在：repo → **Settings** → 左側 **Secrets and variables** → **Actions**。
上方有 **Secrets** 和 **Variables** 兩個分頁，注意放對地方。

| 步驟 | 在哪個網站產生 | 產生什麼 | 放到哪裡 | 名稱（完全照打） |
|---|---|---|---|---|
| 1 | FinMind 會員中心 | API token | GitHub → **Secrets** | `FINMIND_TOKEN` |
| 4 | GitHub → 頭像 → Settings → Developer settings | Fine-grained 權杖（`github_pat_…`） | **cron-job.org** 的 Header（不是 GitHub） | `Authorization: Bearer …` |
| 5 | Google AI Studio | Gemini 金鑰（`AIza…`） | GitHub → **Secrets** | `GEMINI_API_KEY` |
| 5 | Anthropic Console（選用） | Claude 金鑰（`sk-ant-…`） | GitHub → **Secrets** | `ANTHROPIC_API_KEY` |
| 5 | Vercel → Account Settings → Tokens | Vercel 權杖 | GitHub → **Secrets** | `VERCEL_TOKEN` |
| 5 | 自己想 | 通關密碼（12 字以上） | GitHub → **Secrets** | `AI_ACCESS_CODE` |
| 6 | 自己填 | 名稱 + email | GitHub → **Variables** | `SEC_USER_AGENT` |

> 這些設定都**不需要改程式碼、也不需要 push**。存好之後到 Actions 按 Run workflow 即可。

---

## 5. 逐步設定

### 步驟 1：FinMind token（必要）

1. 到 https://finmindtrade.com 註冊並登入
2. 進入 **會員中心**（或「使用者資訊」），找到 **API Token**，按複製
3. 打開 repo → **Settings** → **Secrets and variables** → **Actions** → 確認在 **Secrets** 分頁
4. 按綠色 **New repository secret**
   - **Name**：`FINMIND_TOKEN`
   - **Secret**：貼上 token
5. 按 **Add secret**

> ⚠️ 如果 token 曾經貼在對話、截圖或程式碼裡，請先在 FinMind 重新產生一組新的，舊的視同外洩。

### 步驟 2：開啟 GitHub Pages（必要）

1. repo → **Settings** → 左側 **Pages**
2. **Build and deployment** → **Source** 選 **GitHub Actions**（不是 Deploy from a branch）
3. 不用按其他按鈕，選好就自動儲存

> repo 必須是 **Public（公開）**。免費帳號把 repo 改成 Private，Pages 會被自動關閉，網站變成 404；
> 改回 Public 後要回到這一步重新選一次 **GitHub Actions**，再執行步驟 3。

### 步驟 3：第一次更新資料（必要）

1. repo 上方點 **Actions**
2. 左側選 **Update data & deploy** → 右側 **Run workflow** → mode 選 **full** → 綠色 **Run workflow**
3. 約 3–5 分鐘後出現綠色勾勾 ✅，點進去，頁面上方的 **Annotations** 會顯示「資料更新…個來源正常」
4. 打開網站 https://tingchen0329.github.io/tw-stock-dashboard/ ，看到追蹤清單總覽就成功了

### 步驟 4：外部排程 cron-job.org（建議）

**為什麼需要**：GitHub 內建排程在尖峰時常延遲好幾個小時甚至略過（實測盤中一次都沒跑）。
cron-job.org 會準時「按門鈴」叫 GitHub 開始更新。

**原理**：cron-job.org 需要一把「只能觸發這個 repo 更新」的 GitHub 權杖。
方向是單向的：GitHub 發鑰匙給 cron-job.org，cron-job.org 的資料不用放到 GitHub。

#### 4-1. 建立 GitHub 權杖

1. 直接打開 https://github.com/settings/personal-access-tokens/new
   （或：GitHub 右上角**頭像** → **Settings** → 左側最下方 **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens** → **Generate new token**）
   > 注意是**帳號**的 Settings（頭像選單），不是 repo 的 Settings；repo 的 Settings 裡沒有 Developer settings
2. 填寫：
   - **Token name**：`cron-job tw-stock-dashboard`
   - **Expiration**：選最長期限，並在行事曆記下到期日
   - **Repository access**：**Only select repositories** → 選 `tw-stock-dashboard`
   - **Permissions** → 按 **Add permissions** → 搜尋框輸入 `Actions` → 勾選 **Actions**（不是 Actions variables）
     → 把它的 Access 改成 **Read and write**（Metadata: Read-only 會自動出現，保留）
3. 按 **Generate token**，複製 `github_pat_` 開頭的整串（**只會顯示一次**）

#### 4-2. 在 cron-job.org 建立兩個排程

註冊 https://cron-job.org → **Cronjobs** → **Create cronjob**。兩個排程除了名稱和時間，其他完全相同：

**COMMON 分頁**

| 欄位 | 填寫 |
|---|---|
| Title | `台股交易日`（第二個填 `台股凌晨總經`） |
| URL | `https://api.github.com/repos/tingchen0329/tw-stock-dashboard/actions/workflows/deploy.yml/dispatches` |
| Execution schedule | 選 **Custom**（時間見下表） |

**排程時間**（Custom 清單可複選：按住 **Ctrl**（Mac 為 ⌘）點選多個；按住 **Shift** 選連續範圍）

| 排程 | Days of week | Hours | Minutes | 完成後的 Crontab expression |
|---|---|---|---|---|
| 台股交易日 | Monday～Friday | 9～14、16、19、21、23 | 30 | `30 9-14,16,19,21,23 * * 1-5` |
| 台股凌晨總經 | Tuesday～Saturday | 2、5 | 40 | `40 2,5 * * 2-6` |

Days of month、Months 保持全選（整列反灰）。

**ADVANCED 分頁**

| 欄位 | 填寫 |
|---|---|
| Time zone | **Asia/Taipei** |
| Request method | **POST**（預設是 GET，一定要改，否則會 404） |
| Headers（按 **+ ADD** 新增，共 4 列） | 見下表 |
| Request body | `{"ref":"main","inputs":{"mode":"smart"}}` |

| Key | Value |
|---|---|
| `Authorization` | `Bearer github_pat_……`（`Bearer` 後面**空一格**再貼權杖） |
| `Accept` | `application/vnd.github+json` |
| `X-GitHub-Api-Version` | `2022-11-28` |
| `Content-Type` | `application/json`（或按藍色提示框的 **ADD CONTENT-TYPE HEADER NOW**） |

**NOTIFICATIONS**：勾選 **execution fails**（失敗時寄信給你）

按 **SAVE**，再按 **TEST RUN**：

| 結果 | 意思 |
|---|---|
| **204 No Content** | 成功 ✅ GitHub Actions 頁面會出現一筆 `workflow_dispatch` 執行 |
| 401 Unauthorized | 權杖貼錯、少了 `Bearer ` 的空格，或 Key 拼錯（`Authorization`） |
| 403 | 權杖權限不是 Actions: Read and write |
| 404 Not Found | Request method 不是 POST，或網址打錯 |
| 422 | Request body 格式錯誤 |

> 程式會依時間自動判斷要做什麼（smart 模式）：盤中更新行情、16:15 / 19:30 後完整更新個股、夜間只更新總經。
> 重複或延遲觸發都不會浪費 FinMind 額度。

### 步驟 5：AI 報告 Gemini + Claude（選用）

**運作方式**：AI 金鑰不能放在公開網頁裡，所以用 **Vercel** 免費的小服務（代理）保管金鑰。
網頁把分析指令交給代理，代理**先問 Gemini（免費）**，Gemini 額度用完或失敗時**改問 Claude（預付）**。

> 為什麼不用 Cloudflare：Cloudflare 免費方案從台灣連線會走香港機房，Gemini、Claude 都不開放香港。
> Vercel 可以固定在美國執行。之前若設定過 Cloudflare，相關 Secrets 與 Worker 都可以刪除（見 5-7）。

#### 5-1. Gemini API 金鑰（免費）

1. 打開 https://aistudio.google.com/apikey ，用 Google 帳號登入
2. 按 **Create API key** → 選專案（沒有就讓它自動建立 Default Gemini Project）→ 建立
3. 在 **API Keys** 列表按該列的 **複製圖示 ⧉**，得到 `AIza` 開頭的金鑰
4. Billing Tier 顯示 **Free tier** 即可，**不要按 Set up billing**
   > Google AI Pro 等會員方案只適用 Gemini 網頁版 / App，**不會**增加 API 額度

#### 5-2. Claude API 金鑰（選用，Gemini 的備援，需預付）

1. 打開 https://console.anthropic.com ，註冊並登入
2. 左側 **Settings** → **Billing** → **Buy credits**，儲值最低金額（例如 US$5）
   - 這是**預付**：用完就停止，不會超額扣款；不要開 Auto reload 就不會自動扣款
   - 建議到 **Settings** → **Limits** 設定每月花費上限
3. 左側 **API Keys** → **Create Key** → Name 填 `tw-stock-dashboard` → **Create Key**
4. 複製 `sk-ant-` 開頭的金鑰（**只會顯示一次**）
5. 費用：每產生一份報告依字數計費，實際用量可在 console 的 **Usage** 查看

> 不想付費可以跳過 5-2，只用 Gemini；Gemini 額度用完時報告會顯示「額度暫時用完」，稍後再試即可。

#### 5-3. Vercel 帳號與權杖（免費）

1. 打開 https://vercel.com/signup → 方案選 **Hobby**（免費）→ **Continue with GitHub** 登入
2. 打開 https://vercel.com/account/settings/tokens
   （或：右上角**頭像** → **Account Settings** → 左側 **Tokens**）
3. **Create Token**：
   - **Token Name**：`github-actions-tw-stock`
   - **Scope**：選你的個人帳號（Hobby）
   - **Expiration**：選 **1 Year**（記下到期日）
4. **Create** → 複製權杖（**只會顯示一次**）
5. ⚠️ **不需要**在 Vercel 按 Add New / Import Project，代理會由 GitHub Actions 自動建立

#### 5-4. 想一組通關密碼 AI_ACCESS_CODE

網站是公開的，任何人都看得到「產生 AI 報告」按鈕。通關密碼的作用是：
**沒有密碼的人按了也不會呼叫 AI**，避免陌生人用光你的額度。

- 自己想一組 12 字以上的密碼，例如 `Ting-Stock-2026-ai!`，**自己記住**
- 第一次在網頁使用時輸入一次，之後會記在那台瀏覽器

| | AI 金鑰（Gemini / Claude） | AI_ACCESS_CODE |
|---|---|---|
| 是什麼 | Google / Anthropic 發的 API 金鑰 | 你自己訂的密碼 |
| 誰會輸入 | 沒有人（只存在 GitHub / Vercel） | 你第一次使用時在網頁輸入 |
| 外洩的後果 | 別人可以直接用你的額度 | 別人可以按你網站的 AI 按鈕；換掉密碼即可 |

#### 5-5. 放進 GitHub Secrets

repo → **Settings** → **Secrets and variables** → **Actions** → **Secrets** 分頁 → **New repository secret**，逐一新增：

| Name | Secret | 必要性 |
|---|---|---|
| `VERCEL_TOKEN` | 5-3 的 Vercel 權杖 | 必要 |
| `AI_ACCESS_CODE` | 5-4 的通關密碼 | 必要 |
| `GEMINI_API_KEY` | 5-1 的 Gemini 金鑰（`AIza…`） | 與下一個至少一個 |
| `ANTHROPIC_API_KEY` | 5-2 的 Claude 金鑰（`sk-ant-…`） | 選用 |

已經存在的 Secret（例如之前設定過的 `GEMINI_API_KEY`、`AI_ACCESS_CODE`）不用重設。

#### 5-6. 部署 AI 代理

1. repo → **Actions** → 左側 **Deploy AI proxy** → **Run workflow** → 綠色 **Run workflow**
2. 約 1–2 分鐘後 ✅，點進去看 **Annotations**：
   - **AI 供應商**：Gemini / Claude 是否已設定
   - **AI 代理網址**：`https://….vercel.app/api/ai`，後面要有 `"ok":true` 與 `"region":"iad1"`
   - **AI 報告已啟用**：網址已自動寫入網站並重新部署（**不用手動改檔或 push**）
3. 再等約 3 分鐘（Update data & deploy 跑完），網站按 **Ctrl + F5** 重新整理
4. 打開任一檔個股 → 按 **產生 AI 報告** → 頁面捲到最下方 → 輸入 `AI_ACCESS_CODE` → **儲存並產生報告**
5. 約 20–90 秒後報告出現，下方會註明用的是 Gemini 還是 Claude

#### 5-7. 清除舊的 Cloudflare 設定（之前設定過才需要）

- GitHub Secrets：刪除 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`（各列右邊的垃圾桶）
- Cloudflare：**Compute → Workers & Pages** → 點 `tw-stock-ai`、`tw-stock-gemini` → **Settings** → 最下方 **Delete**
- Cloudflare 權杖：**My Profile → API Tokens** → 該權杖右邊 **⋯ → Delete**

詳細說明與疑難排解：[docs/AI.md](docs/AI.md)

### 步驟 6：美股財報 SEC 聯絡資訊（選用）

美國證管會（SEC）要求程式存取時註明「名稱 + 聯絡 email」，沒有的話會被拒絕（美股的財報、本益比顯示 N/A）。

1. repo → **Settings** → **Secrets and variables** → **Actions** → 切到 **Variables** 分頁（不是 Secrets）
2. **New repository variable**
   - **Name**：`SEC_USER_AGENT`
   - **Value**：`TW Stock Dashboard 你的email@example.com`
3. **Actions** → **Update data & deploy** → **Run workflow**，mode 選 **full**

> Variable 不加密、會出現在執行紀錄，所以這裡只放 email，不要放任何密碼。

---

## 6. 日常使用

| 位置 | 功能 |
|---|---|
| 標題旁 **台股｜美股** | 切換市場 |
| 美股頁 **美股總覽｜美股選股** | 美股追蹤清單總覽；S&P 500 選股（成長型 / 殖利率型）。上方提示美股開休市與台北時間的開收盤時刻（含美國假日、提早收盤、夏令時間） |
| 追蹤列 **總覽** | 首頁：追蹤清單每檔一列，點標題排序、可篩選個股 / ETF，點一列開啟個股 |
| 追蹤列 **選股** | 全市場選股：成長型 / 殖利率型兩組條件，門檻可自行調整 |
| 搜尋框 | 輸入代號或名稱（2330、台積、２３３０都可以），按 `/` 快速跳到搜尋框 |
| 個股頁 **產生 AI 報告** | Gemini（失敗改用 Claude）產生的報告，顯示在個股頁最下方 |
| 個股頁 **產生分析指令** | 自動複製精簡版提示詞，可貼到 Claude、ChatGPT、Gemini 網頁版 |
| 個股頁 **下載 CSV / Excel** | 匯出股價、月營收、法人、財報 |
| 個股頁 **TradingView ↗** | 在新分頁開啟 TradingView 線圖 |
| 頁首 **資料更新 …** | 點開可看每個資料來源是否正常 |

網頁長時間開著不會自動更新，看到資料時間不對時按 **F5** 重新整理。

## 7. 修改追蹤清單

**台股**：`config/watchlist.csv`（順序 = 網頁顯示順序）

- **加減幾檔**：在 GitHub 打開 `config/watchlist.csv` → 右上角 **鉛筆圖示** → 新增或刪除一行 → 右上角 **Commit changes** → 再按一次 **Commit changes**
- **整份換掉**：整理好 CSV（有「股票代號」或「Symbol」欄即可，`2330`、`2330.TW`、`5347.TWO` 都看得懂）→
  打開 repo 的 `config` 資料夾 → **Add file** → **Upload files** → 檔名用 `watchlist.csv` 覆蓋 → **Commit changes**
- 存檔後幾分鐘網站自動更新，新加入的股票會自動補抓資料
- 上限約 **70 檔**（FinMind 免費額度每小時 600 次；個股每檔約 8 次、ETF 約 4 次）

**美股**：`config/us_watchlist.csv`，格式 `Symbol,Name`（例如 `NVDA,NVIDIA 輝達`），修改方式同上。

- **用 Yahoo Finance 自選清單匯入**：Yahoo Finance 網站 → **My Portfolios** → 選清單 → **Export**，下載的 CSV 直接改名
  `us_watchlist.csv` 上傳覆蓋即可（只取 Symbol 欄；同一檔買多次的重複列、指數 `^GSPC`、外國掛牌 `2330.TW` 會自動略過）
- 類股代號 `BRK.B` 會自動轉成 `BRK-B`
- 不在清單裡的股票仍可在「美股選股」看到數字，但沒有個股頁（股價圖、河流圖）

## 8. 金鑰與權杖管理

| 名稱 | 存放位置 | 會過期嗎 | 到期或外洩時 |
|---|---|---|---|
| `FINMIND_TOKEN` | GitHub Secrets | 依 FinMind 設定 | FinMind 重新產生 → 更新 Secret |
| GitHub Fine-grained 權杖 | cron-job.org 兩個排程的 Header | 是（建立時設定） | 重新建立（步驟 4-1）→ 更新兩個排程的 `Authorization` |
| `GEMINI_API_KEY` | GitHub Secrets → Vercel | 否 | AI Studio 刪除舊的、建新的 → 更新 Secret → 重跑 **Deploy AI proxy** |
| `ANTHROPIC_API_KEY` | GitHub Secrets → Vercel | 否 | console 刪除舊的、建新的 → 更新 Secret → 重跑 **Deploy AI proxy** |
| `VERCEL_TOKEN` | GitHub Secrets | 是（1 Year） | Vercel 重新建立 → 更新 Secret → 重跑 **Deploy AI proxy** |
| `AI_ACCESS_CODE` | GitHub Secrets → Vercel、你的瀏覽器 | 否 | 更新 Secret → 重跑 **Deploy AI proxy** → 網頁 AI 區塊按 **更換通關密碼** |
| `SEC_USER_AGENT` | GitHub Variables | 否 | — |

**安全原則**

- 金鑰只貼在各服務的設定頁和 GitHub Secrets，**不要貼在對話、截圖、Email 或任何檔案裡**
- 截圖前把金鑰欄位捲到看不到的位置
- 懷疑外洩：到產生它的網站按 **Revoke / Delete** 作廢，再建一把新的

## 9. 常見問題

| 狀況 | 原因 / 解法 |
|---|---|
| 網站顯示 404 | Pages 被關閉（常見原因：repo 曾改成 Private）。回到步驟 2 重新選 GitHub Actions，再執行步驟 3 |
| 網頁顯示「還沒有資料」 | 還沒跑過 Update data & deploy，或 Pages Source 不是 GitHub Actions |
| 橫幅「FinMind token 尚未設定」 | Secret 名稱不是 `FINMIND_TOKEN`，或放到了 Variables 分頁 |
| 資料時間很舊 | 網頁太久沒重新整理（按 F5）；或 cron-job.org 排程失效（看 cron-job.org 的 History） |
| cron-job.org TEST RUN 不是 204 | 見步驟 4-2 的結果對照表 |
| Actions 出現「資料來源失敗」黃色警告 | 該資料源暫時失敗，其他資料照常更新；連續失敗再處理 |
| 總覽表某檔顯示 N/A | 剛加入清單或額度用完，下一次執行會補抓；ETF 沒有本益比、營收、財報屬正常 |
| 選股頁 EPS 大多是 N/A | 新一季財報公布期間（季底後約 45 天），可先清空「EPS」「營業利益率」條件 |
| Deploy AI proxy 警告「缺少 GitHub Secrets」 | 步驟 5-5 的 Secret 名稱打錯或少放 |
| Deploy AI proxy 健康檢查失敗 | `VERCEL_TOKEN` 貼錯或過期 |
| AI 區塊「Claude 預付額度不足」 | console.anthropic.com → Billing 儲值 |
| AI 區塊「通關密碼錯誤」 | 輸入的和 `AI_ACCESS_CODE` 不同（大小寫、空白） |
| AI 區塊「API 金鑰無效」 | `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` 錯誤或不完整 |
| AI 區塊「免費額度暫時用完」 | Gemini 額度用完且沒有 Claude 備援；稍後再試，或設定 `ANTHROPIC_API_KEY` |
| AI 區塊「不接受這個地區的請求」 | 確認 Deploy AI proxy 的健康檢查顯示 `"region":"iad1"` |
| 美股財報 N/A、Actions 出現 sec_tickers 403 | 尚未設定步驟 6 的 `SEC_USER_AGENT` |
| 排程突然都不跑 | 公開 repo 60 天沒有任何 commit，GitHub 會停用排程；到 Actions 頁面按 Enable，或修改任一檔案 commit |
| 本機雙擊 index.html 是空白 | 瀏覽器禁止直接讀檔，請用 `./scripts/preview.sh` |

更多說明：[docs/SETUP.md](docs/SETUP.md)（資料更新時段）、[docs/SCHEDULER.md](docs/SCHEDULER.md)（外部排程）、[docs/AI.md](docs/AI.md)（AI 報告）

---

## 10. 費用

預設配置 **每月 NT$0**。

| 項目 | 方案 | 費用 | 本專案用量 / 說明 |
|---|---|---|---|
| GitHub repo + Actions | Free（公開 repo） | NT$0 | 公開 repo 的標準 runner 不計分鐘數。每交易日 13 次，各約 0.5–3 分鐘。若改私有 repo，每月有 2,000 分鐘免費額度，本專案約用 500 分鐘 |
| GitHub Pages | Free | NT$0 | 網站約 2 MB；軟上限 1 GB 容量、每月 100 GB 流量 |
| 證交所 / 櫃買 OpenAPI | 政府開放資料 | NT$0 | 全市場行情、本益比、三大法人 |
| Yahoo Finance chart API | 非官方、免費 | NT$0 | 指數、匯率、盤中價。無服務保證，偶爾限流 |
| FinMind 註冊會員 | Free | NT$0 | 每小時 600 次；收盤後完整更新約 510 次（68 檔），其他時段約 3 次。清單上限約 70 檔 |
| Claude | 你現有的方案 | 不增加 | 貼上「分析指令」或在 Claude Code 使用 skill |
| *選用* FinMind Backer | 付費 | NT$699/月 | 單日全市場批次下載（可做全市場篩選）、股權分散表（千張大戶）、還原股價 |
| *選用* FinMind Sponsor | 付費 | NT$999/月 | 盤中即時快照、分點進出、八大行庫 |
| Google Gemini API | 免費方案 | NT$0 | AI 報告優先使用，額度以 Google AI Studio 為準 |
| *選用* Claude API | 預付 | 最低儲值約 US$5 | Gemini 失敗時的備援，依用量扣除預付額度 |
| Vercel | Hobby（免費） | NT$0 | 保管 AI 金鑰的代理 |
| cron-job.org | Free | NT$0 | 外部排程，準時觸發更新（[設定](docs/SCHEDULER.md)） |
| *選用* 自訂網域 | 網域商 | 約 NT$400–1,000/年 | 例如 stock.你的網域.tw |

FinMind 價格取自 https://finmind.github.io/Pricing/ （2026-10）。分析框架中「千張大戶、借券、景氣燈號」
在免費方案沒有資料，網頁與分析指令都會明確標示 N/A。

---

# 開發者資訊

## 功能一覽

| 區塊 | 內容 | 資料來源 |
|---|---|---|
| 總覽（首頁） | 追蹤清單每檔一列：股價、60 日走勢、本益比、河流圖位階、營收 / EPS 年增、ROE、法人 20 日、均線、KD、RSI；可排序、篩選個股 / ETF | 同下 |
| 美股 | 標題旁切換「台股｜美股」：美股追蹤清單總覽與個股頁（技術指標、本益比、股價淨值比、殖利率、本益比河流圖、近四季 EPS、毛利率、ROE、季營收年增），開休市提示，可開 TradingView 看線圖 | Yahoo Finance（日線、配息）、美國證管會 SEC EDGAR |
| 美股選股 | S&P 500 成分股 + 美股追蹤清單：成長型（季營收 / EPS 年增、淨利率、ROE）、殖利率型（殖利率、本益比、ROE），門檻可自訂；每天完整更新時重算 | S&P 500 成分股清單、SEC EDGAR frames、Yahoo Finance |
| AI 報告 | 個股頁「產生 AI 報告」按鈕，把分析指令交給 Gemini（失敗改用 Claude），報告顯示在頁面最下方（[設定](docs/AI.md)） | Google Gemini / Anthropic Claude（經 Vercel 代理） |
| 選股 | 全市場上市櫃個股：成長型（營收、獲利成長）、殖利率型（高殖利率、低本益比）兩組條件，門檻可自訂 | 證交所、櫃買開放資料（月營收、損益表、本益比） |
| 搜尋 | 代號、名稱、部分名稱、全形數字、臺/台、產業別；`/` 快速聚焦、↑↓ Enter | FinMind TaiwanStockInfo |
| 報價與估值 | 收盤 / 盤中價、本益比、股價淨值比、殖利率、三大法人 | 證交所、櫃買、Yahoo |
| 技術面 | MA5/20/60/240、均線排列、KD、RSI、MACD、量比、區間報酬、價格位階、前高前低 | FinMind（3 年日線） |
| 估值 | 本益比河流圖（近 3 年 10/25/50/75/90 百分位） | FinMind PER |
| 基本面 | 月營收年增 / 月增 / 累計、近四季 EPS、三率、ROE、ROA、負債比、流動比 | FinMind |
| 籌碼 | 法人 5 / 20 日、外資連續買賣、外資持股比例、融資券、券資比 | FinMind |
| 總經 | 加權、櫃買、台指期夜盤、道瓊、那斯達克、費半、美元/台幣、美元指數、美債 10 年、黃金、Fed 利率 | Yahoo、FinMind、期交所 |
| 開休市 | 休市、盤前、盤中提示與資料日期；颱風等臨時休市由資料自動判斷 | 證交所休市日 OpenAPI |
| 輸出 | 分析指令（精簡版，可貼到 Claude / ChatGPT / Gemini）、CSV、Excel（5 個工作表） | — |

## FinMind Skill 與 AI 分析

| 用法 | 環境 | 怎麼用 | 費用 |
|---|---|---|---|
| 網頁「產生分析指令」 | 任何 AI（claude.ai、ChatGPT、Gemini、Copilot） | 按鈕 → 自動複製 → 貼到對話 | 免費 |
| `/finmind` 官方 Agent Skill | Claude Code（在此 repo 內） | `export FINMIND_TOKEN=...` 後輸入 `/finmind 2330 三大法人近一週買賣` | 免費（用 FinMind 額度） |
| `tw-stock-report` skill | Claude Code（在此 repo 內） | 「幫我分析 2330」→ 自動跑 `scripts/summarize.mjs` 並寫七段報告 | 免費 |
| `scripts/summarize.mjs` | 終端機 | `node scripts/summarize.mjs 台積電 --prompt` | 免費 |
| FinMind MCP Server | Claude Desktop / Claude Code | `/plugin marketplace add FinMind/FinMind-MCP` → `/plugin install finmind-mcp@finmind-official` | 免費 |
| FinMind llms.txt | claude.ai 網頁版 | 對話中貼上 https://finmind.github.io/llms.txt（或 llms-full.txt），請 AI 先讀；只會產生程式碼與說明，不會實際抓資料 | 免費 |

`/finmind` 與網頁使用**同一套** `assets/js/analytics.js` 計算，終端機與網頁的 KD、河流圖數字會一致。
Skill 檔案取自 FinMind 官方 repo（Apache-2.0，見 `.claude/commands/finmind-references/NOTICE.md`）。

## 本機開發

```bash
./scripts/preview.sh                 # 合成資料預覽（不需網路與 token）→ http://localhost:8000
./scripts/preview.sh --live          # 真實資料（需 export FINMIND_TOKEN）
python -m unittest discover -s tests/py
node --test "tests/js/*.test.mjs"
python tests/e2e/test_dashboard.py   # 需 pip install playwright && playwright install chromium
python tests/bench/run_bench.py      # 新舊版效能比較
```

## 版本控制

- 每個版本一個 tag：`v5.1.0`（舊版單檔）、`v6.0.0`（本版）。變更記錄見 [CHANGELOG.md](CHANGELOG.md)
- **回到舊版**：`git checkout v5.1.0 -- index.html` 或在 GitHub 的 Releases / Tags 下載
- **建議流程**：開分支 → push 後 CI 自動跑測試（`.github/workflows/ci.yml`）→ 開 PR → 合併到 main → 自動部署
- **改壞了**：`git revert <commit>` 後 push，網站會自動回復
- Dependabot 每月檢查 GitHub Actions 版本並開 PR

## 檔案結構

```
index.html                    網頁骨架（含 CSP）
assets/
  css/app.css                 樣式（淺色 / 深色，色票經色盲模擬驗證）
  datasets.json               FinMind 資料集規格（Python 與網頁共用）
  js/main.js                  進入點：狀態、事件、路由
  js/data.js                  載入靜態 JSON / FinMind 即時查詢
  js/net.js                   請求：快取、共用、逾時、取消
  js/search.js                全市場搜尋
  js/analytics.js             指標計算（純函式）
  js/charts.js                SVG 圖表
  js/render.js                畫面
  js/prompt.js                分析指令
  js/market.js                開休市狀態（純函式）
  js/overview.js              追蹤清單總覽表
  js/screen.js                全市場選股
  js/ai.js                    Gemini AI 分析區塊
  js/export.js                CSV / XLSX
  js/format.js                數字與日期格式
config/watchlist.csv          追蹤清單（Yahoo 自選股 CSV）
config/us_watchlist.csv       美股追蹤清單
tw-stock-ai-proxy/            AI 報告代理（Vercel Function：Gemini → Claude）
scripts/fetch_data.py         資料管線（GitHub Actions 執行）
scripts/us_data.py            美股資料（Yahoo + SEC EDGAR）
scripts/build_overview.mjs    總覽表資料（Actions 執行，與網頁同一套計算）
scripts/summarize.mjs         終端機版個股摘要
scripts/preview.sh            本機預覽
tests/                        py / js / e2e / bench / fixtures（合成資料產生器）
.github/workflows/            deploy.yml（排程 + 部署）、ci.yml（PR 測試）
.claude/                      FinMind skill、tw-stock-report skill
docs/                         SETUP、PERFORMANCE、截圖
```

## 已知限制

- 盤中價來自 Yahoo，約延遲 20 分鐘；即時報價需要 FinMind Sponsor
- 櫃買三大法人的公開欄位沒有穩定文件，採關鍵字比對；每次執行的 Summary 會顯示是否成功
- 財報 EPS 以 FinMind 單季數值加總；「隱含 EPS」（河流圖）= 收盤 ÷ 本益比
- 美股河流圖的本益比由「收盤 ÷ 已公布 45 天以上的近四季 EPS」推算，與券商數字可能略有差異；美股選股的第四季財報由全年減前三季推算
- 美股選股只涵蓋 S&P 500 成分股與美股追蹤清單；SEC 沒有財報的公司（外國公司、ETF）顯示 N/A
- 公開 repo 60 天沒有 commit，GitHub 會停用排程（見 SETUP 疑難排解）

僅供個人研究參考，非投資建議。資料來源：臺灣證券交易所、證券櫃檯買賣中心、FinMind、Yahoo Finance。
