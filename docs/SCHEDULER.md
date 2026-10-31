# 外部排程設定（cron-job.org，免費）

GitHub 內建排程在尖峰時段常延遲數小時甚至直接略過（2026-10 實測：盤中一次都沒跑、收盤後延遲 6–7 小時）。
改由外部排程服務在指定時間呼叫 GitHub API 觸發更新，幾乎準時到分鐘。全部只需做一次，約 10 分鐘。

```
cron-job.org（台北時間 09:40、10:40…）
   │  POST https://api.github.com/.../dispatches   （帶存取權杖，只能觸發這個 repo 的 Actions）
   ▼
GitHub Actions「Update data & deploy」mode=smart
   │  依時間自動判斷：盤中 / 收盤後只更新行情；16:15、19:30 後完整更新個股；夜間只更新總經
   ▼
GitHub Pages
```

`smart` 模式由程式依「現在時間」和「上次完整更新時間」決定要做什麼，所以排程重複觸發、
或某次失敗後下一次補跑，都不會多花 FinMind 額度。repo 內仍保留每天 2 次 GitHub 排程當備援。

## 步驟 1：建立 GitHub 存取權杖（只給「觸發 Actions」的權限）

1. GitHub 右上角頭像 → **Settings** → 左側最下方 **Developer settings**
   → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
2. **Token name**：`cron-job tw-stock-dashboard`
3. **Expiration**：選你能接受的最長期限，並在行事曆記下到期日（到期後外部排程會失效，網站只剩備援排程）
4. **Repository access**：**Only select repositories** → 選 `tw-stock-dashboard`
5. **Permissions → Repository permissions → Actions**：**Read and write**（其他全部維持 No access）
6. **Generate token**，複製 `github_pat_...` 開頭的字串（只會顯示這一次）

這個權杖只能觸發這個 repo 的 workflow，不能讀寫程式碼或 Secrets。
不要貼到對話、截圖或任何檔案裡；外洩的話到同一頁按 **Revoke** 即可作廢。

## 步驟 2：cron-job.org 建立兩個排程

註冊 https://cron-job.org （免費）→ **Create cronjob**。兩個排程除了「時間」之外設定都一樣：

| 欄位 | 填寫 |
|---|---|
| Title | `台股 交易日`（第二個：`台股 凌晨總經`） |
| URL | `https://api.github.com/repos/tingchen0329/tw-stock-dashboard/actions/workflows/deploy.yml/dispatches` |
| Execution schedule | **Custom**，Time zone 選 **Asia/Taipei**（時間見下表） |
| Advanced → Request method | **POST** |
| Advanced → Headers | `Authorization`：`Bearer github_pat_...（步驟 1 的權杖）`<br>`Accept`：`application/vnd.github+json`<br>`X-GitHub-Api-Version`：`2022-11-28` |
| Advanced → Request body | `{"ref":"main","inputs":{"mode":"smart"}}` |
| Notifications | 勾選 **execution fails**（失敗時寄信給你） |

| 排程 | Days of week | Hours | Minutes | smart 會做的事 |
|---|---|---|---|---|
| 台股 交易日 | 週一至週五 | 9, 10, 11, 12, 13, 14, 16, 19, 21, 23 | 40 | 09:40–14:40 行情與盤中價；16:40、19:40 完整更新；21:40、23:40 總經 |
| 台股 凌晨總經 | 週二至週六 | 2, 5 | 40 | 02:40、05:40 台指期夜盤與美股收盤 |

## 步驟 3：測試

在排程編輯頁按 **Test run**（或等下一個整點 40 分）：

- 回應 **HTTP 204**：成功。到 GitHub **Actions** 頁面會看到一筆 `workflow_dispatch` 執行
- **401**：權杖貼錯，或 `Bearer ` 後面少了空格
- **403 / 404**：權杖沒有勾選這個 repo，或 Actions 權限不是 Read and write
- **422**：Request body 格式錯誤（`ref` 必須是 `main`）

## 停用 / 恢復

- 暫停：cron-job.org 把排程切成 Disabled
- 權杖到期或換新：重新做步驟 1，再把兩個排程的 `Authorization` 換成新權杖
- 不使用外部排程時，網站仍會靠 GitHub 備援排程（台北 19:37、05:17）每天更新，只是可能延遲
