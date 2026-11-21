# 與主要財經網站的功能比對（2026-11）

比對對象：台股 Goodinfo、財報狗、Yahoo 奇摩股市；美股 Finviz、Stock Analysis、Yahoo Finance、Koyfin、TradingView。
原則：只做**免費資料源做得到**的項目；需要付費資料或抓取有使用條款疑慮的網站（Goodinfo、Finviz 網頁）不做爬蟲，只放外部連結。

## 已具備
| 功能 | 參考網站 | 本專案 |
|---|---|---|
| 技術指標（均線、KD、RSI、MACD、52 週高低） | 全部 | ✅ 台股 / 美股 |
| 本益比河流圖 | Goodinfo、財報狗 | ✅ 台股（官方 PER）、美股（SEC EPS 推算） |
| 月營收年增 | Goodinfo、財報狗 | ✅ 台股（美股只有季報） |
| 三大法人、融資券、外資持股 | Goodinfo、Yahoo 奇摩 | ✅ 台股 |
| 毛利 / 營益 / 淨利率、ROE、負債比 | 全部 | ✅ 台股 / 美股 |
| 全市場選股（成長 / 殖利率） | Finviz、財報狗 | ✅ 上市櫃約 2,000 檔、S&P 500 |
| 追蹤清單總覽表 | Finviz、Koyfin watchlist | ✅ |

## 本版新增（v6.8.0）
| 功能 | 參考網站 | 說明 |
|---|---|---|
| 相對大盤報酬、Beta、波動度、最大回撤 | Finviz（Beta、Volatility、Perf）、Stock Analysis（Statistics） | 台股比加權指數、美股比 S&P 500；總覽表「1年 vs 大盤」 |
| 季度 EPS 趨勢圖 | 財報狗、Stock Analysis | 近 12 季，含營收年增、毛利率 |
| 自由現金流、FCF 殖利率、盈餘品質 | Stock Analysis、財報狗（現金流） | 美股（SEC 現金流量表）；台股需 FinMind 額外請求，暫不做 |
| VIX、S&P 500 | Finviz、Yahoo Finance | 總經列 |

## v6.9.0 新增
| 功能 | 參考網站 | 說明 |
|---|---|---|
| 總經卡片歷史紀錄 | Yahoo Finance、Investing.com | 點卡片看近一年走勢、區間高低、每日收盤 |
| 同業比較 | 財報狗、Finviz | 同產業本益比、營收年增、ROE、殖利率排名（screen.json，不花 FinMind 額度） |
| 股利政策與填息天數 | Goodinfo | FinMind TaiwanStockDividend / DividendResult，每檔 7 天更新一次 |
| 台股自由現金流 | 財報狗 | FinMind TaiwanStockCashFlowsStatement（年初累計拆單季） |
| 美股內部人買賣 | Finviz、OpenInsider | SEC Form 4，近 6 個月，依申報編號快取 |

## v7.0.0 新增（數據正確性）
| 功能 | 說明 |
|---|---|
| 還原股價 + 報酬指數 | 報酬率、相對大盤都含息；FinMind 還原股價限付費會員，改用除權息結果自己算 |
| 跨來源交叉比對 | 收盤價、月營收、EPS；異常值規則（漲跌幅限制、開高低收、停更） |
| TA-Lib / Hypothesis | 指標與業界標準逐筆比對；性質測試找邊界錯誤 |
| K 線圖 | TradingView Lightweight Charts™（Apache 2.0） |

## 後續可做（依價值排序）
| 功能 | 參考網站 | 免費資料源 | 難度 / 注意 |
|---|---|---|---|
| 美股機構持股（13F） | Yahoo Finance、WhaleWisdom | SEC 13F | 高：資料量大，季更新 |
| 財報公布日 / 法說會日期 | Yahoo Finance、MOPS | 證交所 OpenAPI（法說會）；美股無免費官方日曆 | 中 |
| 分析師目標價、EPS 預估 | Yahoo Finance、Finviz | 無可靠免費 API | 不做（只放外部連結） |
| 千張大戶（股權分散表） | Goodinfo、神秘金字塔 | 集保結算所開放資料（每週一次，免費；FinMind 的同資料集要付費） | 中：每週更新，要確認 API 欄位 |
| 全市場擔保維持率、融資占比 | 證交所「臺股儀表板」（2026-09-23 上線） | 證交所網站（是否有 API 待確認） | 中：可加進總經列 |
| 持股損益（庫存股） | 券商 App、CMoney | 本機輸入成本與股數（存在瀏覽器） | 低 |
| 到價 / 條件提醒（手機通知） | 券商 App | GitHub Actions + Discord webhook / Telegram（LINE Notify 已停止服務） | 低：金鑰放 Secrets |
| 選股條件回測 | Finviz、Portfolio123 | 現有 3 年日線；要注意倖存者偏差（只用現在的清單回測會高估） | 高 |
| 手機安裝（PWA） | — | manifest + service worker，離線可看上一份資料 | 低 |

## 參考
- 證交所「臺股儀表板」（全市場擔保維持率、違約、營收）：2026-09-23 上線
- 集保結算所開放資料 API（股權分散表）：https://openapi.tdcc.com.tw/tdcc-opendata-api-docs
- 證交所發行量加權股價報酬指數：https://www.twse.com.tw/rwd/zh/TAIEX/MFI94U
- TradingView Lightweight Charts™：https://www.tradingview.com/lightweight-charts/
- TA-Lib Python：https://pypi.org/project/TA-Lib/；Hypothesis：https://hypothesis.readthedocs.io/
- Finviz 個股頁（Beta、Volatility、Perf、Insider）：https://finviz.com
- Stock Analysis（Statistics、Cash Flow）：https://stockanalysis.com
- 財報狗：https://statementdog.com
- Goodinfo：https://goodinfo.tw
