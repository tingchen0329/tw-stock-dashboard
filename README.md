# 台股分析儀表板 v5

> 一個可長期使用的台股即時資料查詢與分析工具。
> 整合 Stooq、FinMind、Yahoo、證交所多源資料,搭配 Claude AI 進行深度分析。

---

## ✨ 功能特色

- 📊 **即時行情**:股價、本益比、股價淨值比、殖利率
- 👥 **三大法人**:外資、投信、自營商買賣超
- 📈 **基本面**:近 6 個月月營收、年增率
- 💱 **總經面板**:加權指數、櫃買指數、USD/TWD、DXY 美元指數
- 🤖 **Claude AI 整合**:一鍵產生七段深度分析指令
- 📥 **匯出**:CSV / Excel 下載
- 🔄 **多源 Fallback**:任一資料源失敗自動切換
- 🔒 **隱私**:Token 只存本機 localStorage,不上傳

---

## 🚀 快速開始 (本機使用)

最簡單的方式:**雙擊 `index.html`** 用瀏覽器開啟,立刻就能用。

但建議搭配 FinMind Token 取得最完整資料:

1. 前往 https://finmindtrade.com/analysis/#/data/login 免費註冊
2. 在會員中心取得 token
3. 開啟儀表板 → 點 Token 區塊「設定」→ 貼上 token
4. Token 會儲存在你的瀏覽器,**不會經過任何第三方伺服器**

---

## 🌐 部署到免費網站 (三選一)

### 方案 A: GitHub Pages (最推薦)

**優點:** 永久免費、有自己的網址、可隨時更新

**步驟:**

1. 註冊 GitHub 帳號:https://github.com/signup
2. 點右上 `+` → New Repository
3. Repository name 填:`tw-stock-dashboard` (或任何你想要的名字)
4. 勾選 `Public`,點 Create repository
5. 在新建的 repo 頁面,點 `uploading an existing file`
6. 把 `index.html` 拖進去 → 點 `Commit changes`
7. 點上方 `Settings` → 左側 `Pages`
8. Source 選 `Deploy from a branch`,Branch 選 `main` / `/(root)` → Save
9. 等 1-2 分鐘,頁面會出現網址:`https://你的帳號.github.io/tw-stock-dashboard/`
10. 完成!以後直接用這個網址開啟,手機也能用

### 方案 B: Netlify (拖拉部署最快)

**優點:** 部署最簡單,3 分鐘搞定

**步驟:**

1. 註冊 Netlify:https://app.netlify.com/signup (可用 GitHub 帳號登入)
2. 登入後,在主畫面找到「Drag and drop your site folder here」區塊
3. 把整個包含 `index.html` 的資料夾拖進去
4. 自動部署完成,給你一個網址例如:`https://random-name-12345.netlify.app`
5. 可以在 Site settings → Change site name 改成你想要的名字

### 方案 C: Vercel

**優點:** 速度快,介面好看

**步驟:**

1. 註冊 Vercel:https://vercel.com/signup
2. 用 GitHub 帳號登入
3. 先把 `index.html` 上傳到一個 GitHub repo (參考方案 A 的 1-6 步)
4. 在 Vercel 主畫面點 `Add New...` → `Project`
5. 選擇剛剛建立的 repo → Import → Deploy
6. 完成,自動給網址

---

## 📚 資料來源與限制

| 資料源 | 涵蓋內容 | CORS | 免費額度 |
|---|---|---|---|
| **Stooq** (主力) | 股價、成交量、指數、外匯 | ✅ 直連 | 無限制 |
| **FinMind** | 月營收、財報、籌碼、技術指標 | ✅ 直連 | 60-600 次/小時 |
| **Yahoo Finance** | 即時報價 | ❌ 需 proxy | 不穩定 |
| **證交所 OpenAPI** | PE、PB、殖利率、三大法人 | ❌ 需 proxy | 無限制 |

### 已知限制

- **盤後幾分鐘**:資料可能延遲 5-15 分鐘
- **櫃買股 (上櫃)**:三大法人資料僅 FinMind 有
- **千張大戶、借券、技術指標**:FinMind 免費版不含,需付費版
- **總經 DXY**:Stooq 偶爾抓不到,會嘗試 fallback

---

## 🔧 修改與客製化

整個工具是**單一 HTML 檔案**,沒有任何外部依賴 (除了 SheetJS 從 CDN 載入)。

你可以用任何文字編輯器 (VS Code、記事本、Sublime) 開啟修改:

- 改 UI 樣式:找 `<style>` 區塊
- 改資料源邏輯:找 `// ============ 多源抓股票 ============`
- 加新欄位:找 `// ============ 渲染 ============`
- 改 Claude 指令模板:找 `$('bclaude').onclick`

---

## ❓ 常見問題

**Q: 為什麼總經面板有時 N/A?**
A: Stooq 偶爾會限流,點「重抓」通常就好。如果持續失敗,可能是你的網路 ISP 對該域名有限制。

**Q: 為什麼三大法人沒資料?**
A: 證交所 API 需要透過 proxy,如果 proxy 全部失敗就會抓不到。可以等幾分鐘再試,或啟用 FinMind Token (FinMind 也有法人資料,不需 proxy)。

**Q: Token 安全嗎?**
A: Token 只存在你的瀏覽器 localStorage,不會經過任何伺服器。但**不要把儀表板網址公開**,因為別人開了之後也能用你儲存的 token (除非他們在另一台瀏覽器,因為 localStorage 是綁瀏覽器的)。

**Q: 上櫃股票 (6689、5289、6669 等) 抓得到嗎?**
A: 抓得到。Stooq 用 `.two` 後綴、FinMind 不分上市上櫃。但證交所 API 只有上市股,所以上櫃股的 PE、PB、三大法人會優先用 FinMind 的資料。

**Q: 我的網路抓不到 Stooq?**
A: 部分台灣 ISP (尤其是中華電信) 偶爾會封鎖 stooq.com。可以試試手機 4G/5G 切換網路測試。

---

## ⚖️ 免責聲明

本工具僅供個人投資研究參考,所有數據來自公開 API,不保證即時性與正確性。
投資決策請以官方來源(證交所、櫃買中心、公開資訊觀測站)為準。

工具本身不收集任何使用者資料,所有運算都在你的瀏覽器本機進行。

---

## 📝 版本記錄

- **v5** (當前):加入 Stooq 做為主力資料源,免 proxy 也能用;改進月營收 YoY 計算邏輯
- **v4**:多 proxy fallback、資料完整度顯示
- **v3**:加入上櫃股票支援、總經面板
- **v2**:加入 FinMind 整合
- **v1**:初版,僅證交所 OpenAPI
