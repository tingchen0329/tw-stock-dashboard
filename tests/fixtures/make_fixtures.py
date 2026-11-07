#!/usr/bin/env python3
"""
產生「合成」測試資料（假資料，非真實行情），格式與真實 API 回應相同。

用途：
  * 單元 / 端對端測試（tests/）
  * 本機離線預覽：scripts/preview.sh
  * 效能測試（tests/bench/）：資料量與真實市場同級（上市約 1,000 檔、上櫃約 800 檔）

所有數字由固定亂數種子產生 → 每次執行結果完全一樣，測試可重現。
網頁讀到 meta.demo=true 時會顯示「示範資料」橫幅，避免誤認為真實價格。

用法：python tests/fixtures/make_fixtures.py <輸出資料夾> [--today 2026-10-19] [--xss]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import zlib
from pathlib import Path

# 追蹤清單股票的名稱 / 市場 / 產業（名稱為公開資訊；價格全部是合成的）
WATCH = {
    "2330": ("台積電", "twse", "半導體業", 980), "2454": ("聯發科", "twse", "半導體業", 1200),
    "2317": ("鴻海", "twse", "其他電子業", 180), "2308": ("台達電", "twse", "電子零組件業", 600),
    "2409": ("友達", "twse", "光電業", 15), "2324": ("仁寶", "twse", "電腦及週邊設備業", 30),
    "6669": ("緯穎", "twse", "電腦及週邊設備業", 2300), "2451": ("創見", "twse", "電腦及週邊設備業", 110),
    "8114": ("振樺電", "twse", "電腦及週邊設備業", 140), "6689": ("伊雲谷", "twse", "資訊服務業", 90),
    "3704": ("合勤控", "twse", "通信網路業", 40), "2303": ("聯電", "twse", "半導體業", 48),
    "1519": ("華城", "twse", "電機機械", 600), "7610": ("聯友金屬-創", "twse", "綠能環保", 300),
    "2344": ("華邦電", "twse", "半導體業", 22), "1504": ("東元", "twse", "電機機械", 55),
    "5289": ("宜鼎", "tpex", "電腦及週邊設備業", 280), "3037": ("欣興", "twse", "電子零組件業", 150),
    "3189": ("景碩", "twse", "半導體業", 90), "0050": ("元大台灣50", "twse", "ETF", 160),
}
INST_NAMES = ["Foreign_Investor", "Foreign_Dealer_Self", "Investment_Trust", "Dealer_self", "Dealer_Hedging"]


def trading_days(end: dt.date, n_cal: int) -> list[dt.date]:
    d0 = end - dt.timedelta(days=n_cal)
    return [d0 + dt.timedelta(days=i) for i in range(n_cal + 1)
            if (d0 + dt.timedelta(days=i)).weekday() < 5]


def roc(d: dt.date) -> str:
    return f"{d.year - 1911}{d:%m%d}"


def walk(rng: random.Random, base: float, n: int, drift: float = 0.0004, vol: float = 0.018) -> list[float]:
    """幾何隨機漫步：產生 n 個收盤價，最後一天約落在 base 附近。"""
    raw, p = [], 1.0
    for _ in range(n):
        p *= 1 + rng.gauss(drift, vol)
        raw.append(p)
    k = base / raw[-1]
    return [round(x * k, 2) for x in raw]


def make(out: Path, today: dt.date, xss: bool) -> None:
    out.mkdir(parents=True, exist_ok=True)
    w = lambda name, obj: (out / name).write_text(json.dumps(obj, ensure_ascii=False), "utf-8")  # noqa: E731
    rng = random.Random(20261019)

    # ── 市場清單：追蹤清單 + 填充股票（讓檔案大小接近真實市場）──
    universe = {c: v[:3] for c, v in WATCH.items()}
    for i in range(1, 1000):
        universe.setdefault(f"{1100 + i * 7 % 8800:04d}", (f"上市測試{i:03d}", "twse", "測試產業"))
    for i in range(1, 800):
        universe.setdefault(f"{3200 + i * 11 % 6700:04d}", (f"上櫃測試{i:03d}", "tpex", "測試產業"))
    for i in range(1, 400):
        universe.setdefault(f"{6400 + i * 13 % 3500:04d}", (f"興櫃測試{i:03d}", "emerging", "測試產業"))
    if xss:
        universe["9999"] = ('<img src=x onerror="window.__xss=1">', "twse", "<b>XSS</b>")

    # 最近交易日：平日就是今天，週末退回週五
    last_day = today - dt.timedelta(days=max(0, today.weekday() - 4))
    days = trading_days(last_day, 1100)

    # FinMind TaiwanStockInfo（同一檔可能出現多筆不同產業 → 測試去重）
    info = [{"industry_category": ind, "stock_id": c, "stock_name": n, "type": m, "date": str(today)}
            for c, (n, m, ind) in universe.items()]
    info.append({"industry_category": "電子工業", "stock_id": "2330", "stock_name": "台積電",
                 "type": "twse", "date": str(today)})
    info.append({"industry_category": "Index", "stock_id": "Electronic", "stock_name": "電子類指數",
                 "type": "twse", "date": str(today)})
    for row in info:                       # 7610：FinMind 仍標興櫃，但行情在證交所（應顯示上市）
        if row["stock_id"] == "7610":
            row["type"] = "emerging"
    w("finmind_TaiwanStockInfo.json", {"msg": "success", "status": 200, "data": info})

    closes: dict[str, list[float]] = {}
    for c, (n, m, _) in universe.items():
        if m == "emerging":
            continue
        base = WATCH[c][3] if c in WATCH else round(rng.uniform(12, 400), 1)
        closes[c] = walk(random.Random(zlib.crc32(c.encode())), base, len(days))  # crc32：跨執行穩定（hash() 每次不同）

    def row_quote(c):
        cl = closes[c]
        last, prev = cl[-1], cl[-2]
        hi, lo = round(max(last, prev) * 1.01, 2), round(min(last, prev) * 0.99, 2)
        vol = rng.randint(200, 90000) * 1000
        return last, prev, hi, lo, vol

    # ── 證交所 OpenAPI ──
    twse_q, twse_v, t86 = [], [], []
    tpex_q, tpex_v, tpex_i = [], [], []
    for c, (n, m, _) in universe.items():
        if c not in closes:
            continue
        last, prev, hi, lo, vol = row_quote(c)
        pe = round(rng.uniform(6, 45), 2) if rng.random() > 0.08 else ""
        pb = round(rng.uniform(0.6, 8), 2)
        yld = round(rng.uniform(0, 7), 2)
        f_net, t_net, d_net = (rng.randint(-8000, 8000) * 1000, rng.randint(-1500, 1500) * 1000,
                               rng.randint(-900, 900) * 1000)
        if m == "twse":
            twse_q.append({"Date": roc(last_day), "Code": c, "Name": n, "TradeVolume": str(vol),
                           "TradeValue": str(int(vol * last)), "OpeningPrice": f"{prev:.2f}",
                           "HighestPrice": f"{hi:.2f}", "LowestPrice": f"{lo:.2f}",
                           "ClosingPrice": f"{last:.2f}", "Change": f"{last - prev:+.2f}",
                           "Transaction": str(rng.randint(100, 50000))})
            if not c.startswith("00"):                       # 證交所本益比表不含 ETF
                twse_v.append({"Date": roc(last_day), "Code": c, "Name": n, "PEratio": str(pe),
                               "DividendYield": str(yld), "PBratio": str(pb)})
            t86.append([c, n, "0", "0", f"{f_net:,}", "0", "0", "0", "0", "0", f"{t_net:,}",
                        f"{d_net:,}", "0", "0", "0", "0", "0", "0", f"{f_net + t_net + d_net:,}"])
        else:
            tpex_q.append({"Date": roc(last_day), "SecuritiesCompanyCode": c, "CompanyName": n,
                           "Close": f"{last:.2f}", "Change": f"{last - prev:+.2f}", "Open": f"{prev:.2f}",
                           "High": f"{hi:.2f}", "Low": f"{lo:.2f}", "TradingShares": str(vol)})
            tpex_v.append({"Date": roc(last_day), "SecuritiesCompanyCode": c, "CompanyName": n,
                           "PriceEarningRatio": str(pe), "YieldRatio": str(yld), "PriceBookRatio": str(pb)})
            tpex_i.append({"Date": roc(last_day), "SecuritiesCompanyCode": c, "CompanyName": n,
                           "ForeignInvestorsIncludeMainlandAreaInvestors-Difference": str(f_net),
                           "SecuritiesInvestmentTrustCompanies-Difference": str(t_net),
                           "Dealers-Difference": str(d_net), "TotalDifference": str(f_net + t_net + d_net)})
    w("v1_exchangeReport_STOCK_DAY_ALL.json", twse_q)
    w("v1_exchangeReport_BWIBBU_ALL.json", twse_v)
    w("openapi_v1_tpex_mainboard_quotes.json", tpex_q)
    w("openapi_v1_tpex_mainboard_peratio_analysis.json", tpex_v)
    w("openapi_v1_tpex_3insti_daily_trading.json", tpex_i)
    t86_fields = ["證券代號", "證券名稱", "外陸資買進股數(不含外資自營商)", "外陸資賣出股數(不含外資自營商)",
                  "外陸資買賣超股數(不含外資自營商)", "外資自營商買進股數", "外資自營商賣出股數",
                  "外資自營商買賣超股數", "投信買進股數", "投信賣出股數", "投信買賣超股數", "自營商買賣超股數",
                  "自營商買進股數(自行買賣)", "自營商賣出股數(自行買賣)", "自營商買賣超股數(自行買賣)",
                  "自營商買進股數(避險)", "自營商賣出股數(避險)", "自營商買賣超股數(避險)", "三大法人買賣超股數"]
    w(f"twse_T86_{last_day:%Y%m%d}.json",
      {"stat": "OK", "date": f"{last_day:%Y%m%d}", "fields": t86_fields, "data": t86})

    # ── FinMind 個股（追蹤清單）──
    def fm(name, data):
        w(name, {"msg": "success", "status": 200, "data": data})

    for c in WATCH:
        etf = c.startswith("00")                  # ETF：沒有本益比、月營收、財報（pipeline 也不會查）
        r = random.Random(int(c))
        cl = closes[c]
        price = []
        for d, v in zip(days, cl):
            o = round(v * (1 + r.gauss(0, 0.006)), 2)
            price.append({"date": str(d), "stock_id": c, "Trading_Volume": r.randint(500, 60000) * 1000,
                          "Trading_money": 0, "open": o, "max": round(max(o, v) * (1 + abs(r.gauss(0, .006))), 2),
                          "min": round(min(o, v) * (1 - abs(r.gauss(0, .006))), 2), "close": v,
                          "spread": 0, "Trading_turnover": 0})
        fm(f"finmind_TaiwanStockPrice_{c}.json", price)
        eps0 = WATCH[c][3] / r.uniform(12, 25)
        per = [{"date": str(d), "stock_id": c, "dividend_yield": round(r.uniform(1.5, 4.5), 2),
                "PER": round(v / (eps0 * (1 + 0.15 * i / len(days))), 2), "PBR": round(v / (eps0 * 6), 2)}
               for i, (d, v) in enumerate(zip(days, cl))]
        if not etf:
            fm(f"finmind_TaiwanStockPER_{c}.json", per)
        rev, base_rev = [], r.uniform(2e9, 3e11)
        for k in range(26, 0, -1):
            y, mth = (today.year, today.month - k) if today.month - k > 0 else (today.year - 1, today.month - k + 12)
            while mth <= 0:
                y, mth = y - 1, mth + 12
            nxt = dt.date(y + (mth == 12), mth % 12 + 1, 1)
            rev.append({"date": str(nxt), "stock_id": c, "country": "Taiwan",
                        "revenue": int(base_rev * (1 + 0.012 * (26 - k)) * r.uniform(0.85, 1.15)),
                        "revenue_month": mth, "revenue_year": y, "create_time": ""})
        if not etf:
            fm(f"finmind_TaiwanStockMonthRevenue_{c}.json", rev)
        inst = [{"date": str(d), "stock_id": c, "name": nm, "buy": r.randint(0, 9000) * 1000,
                 "sell": r.randint(0, 9000) * 1000} for d in days[-40:] for nm in INST_NAMES]
        fm(f"finmind_TaiwanStockInstitutionalInvestorsBuySell_{c}.json", inst)
        mb, sb = r.randint(2000, 40000), r.randint(10, 3000)
        margin = []
        for d in days[-40:]:
            mb, sb = max(0, mb + r.randint(-500, 500)), max(0, sb + r.randint(-80, 80))
            margin.append({"date": str(d), "stock_id": c, "MarginPurchaseTodayBalance": mb, "ShortSaleTodayBalance": sb})
        fm(f"finmind_TaiwanStockMarginPurchaseShortSale_{c}.json", margin)
        ratio = r.uniform(10, 75)
        holding = []
        for d in days[-80:]:
            ratio = min(99, max(0, ratio + r.gauss(0, 0.15)))
            holding.append({"date": str(d), "stock_id": c, "ForeignInvestmentShares": 0,
                            "ForeignInvestmentSharesRatio": round(ratio, 2)})
        fm(f"finmind_TaiwanStockShareholding_{c}.json", holding)
        inc, bal = [], []
        qrev = base_rev * 3
        for q in range(9):
            y, qq = today.year - 2 + (q + 2) // 4, (q + 2) % 4 + 1
            qe = dt.date(y, qq * 3, 30 if qq in (2, 3) else 31)
            if qe >= today:
                continue
            rv = qrev * (1 + 0.04 * q) * r.uniform(0.92, 1.08)
            gp, op = rv * r.uniform(0.25, 0.55), rv * r.uniform(0.08, 0.4)
            ni = op * r.uniform(0.75, 0.95)
            for t, v, o in [("Revenue", rv, "營業收入合計"), ("GrossProfit", gp, "營業毛利（毛損）"),
                            ("OperatingIncome", op, "營業利益（損失）"), ("IncomeAfterTaxes", ni, "本期淨利（淨損）"),
                            ("EPS", round(ni / 2.6e9, 2), "基本每股盈餘（元）"), ("CostOfGoodsSold", rv - gp, "營業成本合計"),
                            ("Revenue_per", 100, "營業收入合計")]:
                inc.append({"date": str(qe), "stock_id": c, "type": t, "value": round(v, 2), "origin_name": o})
            ta = rv * 6
            for t, v, o in [("TotalAssets", ta, "資產總計"), ("Liabilities", ta * r.uniform(.15, .6), "負債總計"),
                            ("Equity", ta * .55, "權益總計"), ("CurrentAssets", ta * .4, "流動資產合計"),
                            ("CurrentLiabilities", ta * .18, "流動負債合計"), ("CashAndCashEquivalents", ta * .2, "現金及約當現金"),
                            ("Liabilities_per", 40, "負債總計")]:
                bal.append({"date": str(qe), "stock_id": c, "type": t, "value": round(v, 2), "origin_name": o})
        if not etf:
            fm(f"finmind_TaiwanStockFinancialStatements_{c}.json", inc)
            fm(f"finmind_TaiwanStockBalanceSheet_{c}.json", bal)
        # 現金流量表：與台灣財報相同，是「年初至今累計」（Q2 = 上半年合計）
        cf, ytd = [], {}
        for q in range(9):
            y, qq = today.year - 2 + (q + 2) // 4, (q + 2) % 4 + 1
            qe = dt.date(y, qq * 3, 30 if qq in (2, 3) else 31)
            if qe >= today:
                continue
            if qq == 1:
                ytd = {"ocf": 0.0, "capex": 0.0}
            elif not ytd:
                continue                                   # 第一筆不是 Q1：沒有年初累計基準 → 跳過（測試推算邏輯）
            ytd["ocf"] += qrev * r.uniform(0.25, 0.4)
            ytd["capex"] += qrev * r.uniform(0.05, 0.15)
            for t, v, o in [("CashFlowsFromOperatingActivities", ytd["ocf"], "營業活動之淨現金流入（流出）"),
                            ("PropertyAndPlantAndEquipment", -ytd["capex"], "取得不動產、廠房及設備"),
                            ("Depreciation", qrev * 0.05, "折舊費用")]:
                cf.append({"date": str(qe), "stock_id": c, "type": t, "value": round(v, 2), "origin_name": o})
        if not etf:
            fm(f"finmind_TaiwanStockCashFlowsStatement_{c}.json", cf)
        # 股利政策（每年一次）與除權息結果；填息與否由股價決定
        div, divr = [], []
        for k, y in enumerate(range(today.year - 6, today.year)):
            cash_d = round(eps0 * r.uniform(2.2, 3.2) * (1 + 0.05 * k), 2)
            exd = next((d for d in days if d >= dt.date(y, 7, 15)), None) if dt.date(y, 7, 15) >= days[0] else None
            div.append({"date": f"{y}-03-10", "stock_id": c, "year": f"{y - 1912}年",
                        "CashEarningsDistribution": cash_d, "CashStatutorySurplus": 0.0,
                        "StockEarningsDistribution": 0.5 if k == 2 and not etf else 0.0, "StockStatutorySurplus": 0.0,
                        "CashExDividendTradingDate": str(exd) if exd else "", "CashDividendPaymentDate": f"{y}-08-10"})
            if exd:
                i = days.index(exd)
                before = cl[i - 1] if i else cl[i]
                divr.append({"date": str(exd), "stock_id": c, "before_price": before,
                             "after_price": round(before - cash_d, 2), "stock_and_cache_dividend": cash_d,
                             "stock_or_cache_dividend": "息"})
        fm(f"finmind_TaiwanStockDividend_{c}.json", div)
        fm(f"finmind_TaiwanStockDividendResult_{c}.json", divr)

    # ── 總經 ──
    fm("finmind_InterestRate_FED.json", [
        {"country": "FED", "date": "2025-09-17", "full_country_name": "", "interest_rate": 4.25},
        {"country": "FED", "date": "2025-12-10", "full_country_name": "", "interest_rate": 3.75},
        {"country": "FED", "date": "2026-09-16", "full_country_name": "", "interest_rate": 3.5}])

    US_TZ = {"IDX_DJI", "IDX_IXIC", "IDX_GSPC", "IDX_SOX", "IDX_VIX", "IDX_TNX"}

    def yahoo(sym: str, base: float, vol: float = 0.01, n: int = 64) -> None:
        n = min(n, len(days))
        ser = walk(random.Random(sym), base, n, 0.0003, vol)
        if sym in US_TZ:
            # 美股：K 棒時間 = 紐約 09:30（UTC 14:30），收盤時間 = 16:00（UTC 21:00 = 台北隔天 05:00）
            utc = dt.timezone.utc
            ts = [int(dt.datetime.combine(d, dt.time(14, 30), utc).timestamp()) for d in days[-n:]]
            meta = {"regularMarketPrice": ser[-1], "gmtoffset": -18000,
                    "regularMarketTime": int(dt.datetime.combine(days[-1], dt.time(21, 0), utc).timestamp())}
        else:
            ts = [int(dt.datetime.combine(d, dt.time(13, 30)).timestamp()) for d in days[-n:]]
            meta = {"regularMarketPrice": ser[-1], "regularMarketTime": ts[-1], "chartPreviousClose": ser[0]}
        w(f"yahoo_{sym}.json", {"chart": {"result": [{
            "meta": meta, "timestamp": ts, "indicators": {"quote": [{"close": ser}]}}], "error": None}})

    # 櫃買指數不提供 Yahoo fixture：正式環境 ^TWOII 已 404，改由 FinMind TPEx 提供
    for idx_id, base in [("TAIEX", 27000), ("TPEx", 260)]:
        ser = walk(random.Random(idx_id), base, 80, 0.0003, 0.01)
        fm(f"finmind_TaiwanStockPrice_{idx_id}.json",
           [{"date": str(d), "stock_id": idx_id, "close": v, "open": v, "max": v, "min": v, "spread": 0,
             "Trading_Volume": 0, "Trading_money": 0, "Trading_turnover": 0} for d, v in zip(days[-80:], ser)])
    # 台指期夜盤：期交所行情格式（含現貨列、兩個月份、價差組合，測試近月挑選）
    w("taifex_quotes_1.json", {"RtCode": "0", "RtMsg": "", "RtData": {"QuoteList": [
        {"SymbolID": "TXF-S", "DispCName": "臺指現貨", "CLastPrice": "27000.00", "CRefPrice": "26900.00", "CTotalVolume": "0"},
        {"SymbolID": "TXFK6-M", "DispCName": "臺指期116", "CLastPrice": "27050.00", "CRefPrice": "27120.00",
         "CDiff": "-70.00", "CTotalVolume": "41235", "CTime": "215803"},
        {"SymbolID": "TXFL6-M", "DispCName": "臺指期126", "CLastPrice": "27010.00", "CRefPrice": "27080.00",
         "CDiff": "-70.00", "CTotalVolume": "512", "CTime": "215801"},
        {"SymbolID": "TXFK6/L6-M", "DispCName": "臺指期116/126", "CLastPrice": "40.00", "CRefPrice": "40.00",
         "CTotalVolume": "99999", "CTime": "215700"}]}})
    # 全市場選股：月營收彙總表與綜合損益表（上市 opendata、上櫃 mopsfin，欄位名稱相同）
    rr = random.Random(7)
    pm = dt.date(today.year, today.month, 1) - dt.timedelta(days=1)          # 上個月
    ym = f"{pm.year - 1911}{pm.month:02d}"
    revs = {"twse": [], "tpex": []}
    incs = {"twse": [], "tpex": []}
    for c, (n, m, ind) in universe.items():
        if m not in revs or c.startswith("00"):
            continue
        yoy = round(rr.uniform(-35, 70), 2)
        revs[m].append({"出表日期": roc(today), "資料年月": ym, "公司代號": c, "公司名稱": n, "產業別": ind,
                        "營業收入-當月營收": str(rr.randint(10**5, 10**8)), "營業收入-上月比較增減(%)": str(round(rr.uniform(-20, 25), 2)),
                        "營業收入-去年同月增減(%)": str(yoy), "累計營業收入-前期比較增減(%)": str(round(yoy * rr.uniform(0.5, 1.1), 2)),
                        "備註": "-"})
        rv = rr.randint(10**6, 10**9)
        incs[m].append({"出表日期": roc(today), "年度": str(today.year - 1911), "季別": "2", "公司代號": c, "公司名稱": n,
                        "營業收入": str(rv), "營業毛利（毛損）淨額": str(int(rv * rr.uniform(0.05, 0.6))),
                        "營業利益（損失）": str(int(rv * rr.uniform(-0.1, 0.35))),
                        "基本每股盈餘（元）": str(round(rr.uniform(-2, 18), 2))})
    w("v1_opendata_t187ap05_L.json", revs["twse"])
    w("openapi_v1_mopsfin_t187ap05_O.json", revs["tpex"])
    for k in ["ci", "basi", "bd", "fh", "ins", "mim"]:
        w(f"v1_opendata_t187ap06_L_{k}.json", incs["twse"] if k == "ci" else [])
        w(f"openapi_v1_mopsfin_t187ap06_O_{k}.json", incs["tpex"] if k == "ci" else [])

    # 證交所休市日（含兩筆「有開盤」的說明列，應被排除）
    w("v1_holidaySchedule_holidaySchedule.json", [
        {"Name": n, "Date": roc(dt.date.fromisoformat(d)), "Weekday": wd, "Description": desc}
        for n, d, wd, desc in [
            ("國慶日", "2026-10-09", "五", "依規定放假1日"),
            ("臺灣光復暨金門古寧頭大捷紀念日", "2026-10-26", "一", "補假1日"),
            ("中華民國開國紀念日", "2027-01-01", "五", "依規定放假1日"),
            ("國曆新年開始交易日", "2027-01-04", "一", "國曆新年開始交易"),
            ("農曆春節前最後交易日", "2027-02-03", "三", "農曆春節前最後交易日"),
            ("農曆除夕", "2027-02-05", "五", "")]])
    # FinMind 備援：TaiwanFuturesDaily（position = 日盤、after_market = 夜盤）
    txs = walk(random.Random("TXN"), 26000, 250, 0.0003, 0.01)
    tx_hist = [{"date": str(d), "futures_id": "TX", "contract_date": "202611", "open": 0, "max": 0, "min": 0,
                "close": round(v), "spread": 0, "spread_per": 0, "volume": 30000, "settlement_price": 0,
                "open_interest": 0, "trading_session": "after_market"} for d, v in zip(days[-251:-1], txs)]
    fm("finmind_TaiwanFuturesDaily_TX.json", tx_hist + [
        {"date": str(last_day), "futures_id": "TX", "contract_date": cd, "open": 0, "max": 0, "min": 0,
         "close": c, "spread": sp, "spread_per": 0, "volume": v, "settlement_price": 0, "open_interest": 0,
         "trading_session": ses}
        for cd, c, sp, v, ses in [("202611", 27120, 80, 90000, "position"), ("202611", 26990, -40, 38000, "after_market"),
                                  ("202612", 26950, -42, 300, "after_market"),
                                  ("202611/202612", 40, 0, 50000, "after_market")]])
    for sym, base in [("IDX_TWII", 27000), ("TWD_X", 30.6), ("DX-Y.NYB", 98.2), ("IDX_DJI", 46000), ("IDX_IXIC", 22800),
                      ("IDX_TNX", 4.1), ("GC_F", 3900), ("IDX_SOX", 6200), ("IDX_GSPC", 6500), ("IDX_VIX", 16)]:
        # 加權指數、S&P 500 兼做「相對大盤」的 2 年日線 → 給長一點
        yahoo(sym, base, n=520 if sym in ("IDX_TWII", "IDX_GSPC") else 64)
    for c, (n, m, _, base) in WATCH.items():
        yahoo(f"{c}.{'TWO' if m == 'tpex' else 'TW'}", closes[c][-1] if c in closes else base)
    # ── 美股：Yahoo 3 年日線 + SEC companyfacts（NVDA、AAPL 有財報；SPY 是 ETF，SEC 查無）──
    us = {"NVDA": ("NVIDIA Corporation", 180.0, 1045810), "AAPL": ("Apple Inc.", 260.0, 320193), "SPY": ("SPDR S&P 500 ETF Trust", 680.0, None)}
    for sym, (name, base, _) in us.items():
        ser = walk(random.Random(sym), base, 760, 0.0006, 0.017)
        ts = [int(dt.datetime.combine(d, dt.time(20, 0)).timestamp()) for d in days[-760:]]
        w(f"yahoo_{sym}.json", {"chart": {"result": [{
            "meta": {"longName": name, "fullExchangeName": "NasdaqGS", "currency": "USD", "gmtoffset": -18000,
                     "regularMarketPrice": ser[-1], "regularMarketTime": ts[-1], "chartPreviousClose": ser[-2]},
            "timestamp": ts, "indicators": {"quote": [{"open": ser, "high": [round(x * 1.01, 2) for x in ser],
                                                        "low": [round(x * 0.99, 2) for x in ser], "close": ser,
                                                        "volume": [rng.randint(10**6, 10**8) for _ in ser]}]}}], "error": None}})
    w("files_company_tickers.json.json", {str(i): {"cik_str": c, "ticker": t, "title": n.upper()}
                                          for i, (t, (n, _, c)) in enumerate(us.items()) if c})
    for sym, (name, base, cik) in us.items():
        if not cik:
            continue
        rr2 = random.Random(cik)
        dur = {k: [] for k in ("RevenueFromContractWithCustomerExcludingAssessedTax", "GrossProfit", "OperatingIncomeLoss", "NetIncomeLoss")}
        eps, inst = [], {k: [] for k in ("Assets", "Liabilities", "StockholdersEquity", "AssetsCurrent", "LiabilitiesCurrent")}
        rev0 = rr2.uniform(2e10, 6e10)
        cash = {"NetCashProvidedByUsedInOperatingActivities": [], "PaymentsToAcquirePropertyPlantAndEquipment": []}
        for y in (2023, 2024, 2025, 2026):
            yearly = {k: 0.0 for k in dur}
            yeps = 0.0
            ytd = {k: 0.0 for k in cash}
            for q in (1, 2, 3, 4):
                if (y, q) > (2026, 2):
                    break
                rv = rev0 * (1 + 0.05 * ((y - 2023) * 4 + q)) * rr2.uniform(0.95, 1.05)
                vals = {"RevenueFromContractWithCustomerExcludingAssessedTax": rv, "GrossProfit": rv * 0.6,
                        "OperatingIncomeLoss": rv * 0.35, "NetIncomeLoss": rv * 0.3}
                e = round(rv * 0.3 / 2.4e10, 2)
                end = f"{y}-{['03-31', '06-30', '09-30', '12-31'][q - 1]}"
                for k, v in vals.items():
                    yearly[k] += v
                    if q < 4:                               # 第四季只有全年數字（測試推算）
                        dur[k].append({"end": end, "val": round(v), "frame": f"CY{y}Q{q}", "form": "10-Q"})
                yeps += e
                # 現金流量表：10-Q / 10-K 都是年初至今累計（沒有單季 frame），測試自行相減
                for k, v in (("NetCashProvidedByUsedInOperatingActivities", rv * 0.4), ("PaymentsToAcquirePropertyPlantAndEquipment", rv * 0.05)):
                    ytd[k] += v
                    cash[k].append({"start": f"{y}-01-01", "end": end, "val": round(ytd[k]),
                                    "form": "10-K" if q == 4 else "10-Q", **({"frame": f"CY{y}"} if q == 4 else {"frame": f"CY{y}Q1"} if q == 1 else {})})
                if q < 4:
                    eps.append({"end": end, "val": e, "frame": f"CY{y}Q{q}", "form": "10-Q"})
                ta = rv * 5
                for k, v in {"Assets": ta, "Liabilities": ta * 0.45, "StockholdersEquity": ta * 0.55,
                             "AssetsCurrent": ta * 0.4, "LiabilitiesCurrent": ta * 0.2}.items():
                    inst[k].append({"end": end, "val": round(v), "frame": f"CY{y}Q{q}I", "form": "10-Q"})
                if q == 4:
                    for k in dur:
                        dur[k].append({"end": end, "val": round(yearly[k]), "frame": f"CY{y}", "form": "10-K"})
                    eps.append({"end": end, "val": round(yeps, 2), "frame": f"CY{y}", "form": "10-K"})
        g = {k: {"units": {"USD": v}} for k, v in {**dur, **inst, **cash}.items()}
        g["EarningsPerShareDiluted"] = {"units": {"USD/shares": eps}}
        # 內部人交易：submissions（申報清單）+ Form 4 XML
        forms, accs, filed_d, docs = [], [], [], []
        for k in range(6):
            fd = days[-1 - k * 15]
            acc = f"0001{cik % 10**6:06d}-26-{k:06d}"
            forms.append("4" if k != 3 else "10-Q")
            accs.append(acc)
            filed_d.append(str(fd))
            docs.append(f"xslF345X05/form4_{k}.xml")
            if k == 3:
                continue
            code, ad, px = ("P", "A", round(base * 0.97, 2)) if k == 1 else ("S", "D", round(base * 1.02, 2))
            xml = f"""<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <aff10b5One>{1 if code == "S" else 0}</aff10b5One>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>Insider {k} &amp; Co</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>{1 if k == 1 else 0}</isDirector><isOfficer>{0 if k == 1 else 1}</isOfficer>
      <officerTitle>{'' if k == 1 else 'Chief Financial Officer'}</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>{fd}</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>{code}</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>{1000 * (k + 1)}</value></transactionShares>
        <transactionPricePerShare><value>{px}</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>{ad}</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>{50000 + k}</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>{fd}</value></transactionDate>
      <transactionCoding><transactionCode>F</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>120</value></transactionShares>
        <transactionPricePerShare><value>{px}</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>"""
            (out / f"Archives_edgar_data_{cik}_{acc.replace('-', '')}_form4_{k}.xml").write_text(xml, "utf-8")
        w(f"submissions_CIK{cik:010d}.json.json", {"cik": str(cik), "name": name, "filings": {"recent": {
            "form": forms, "accessionNumber": accs, "filingDate": filed_d, "primaryDocument": docs}}})
        w(f"api_xbrl_companyfacts_CIK{cik:010d}.json.json", {"cik": cik, "entityName": name, "facts": {
            "us-gaap": g, "dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": [{"end": "2026-07-20", "val": 24_000_000_000}]}}}}})

    # ── 美股選股：S&P 500 成分股清單 + SEC frames（全部公司同一季一個檔）+ Yahoo 近一年日線與配息 ──
    sp = {"NVDA": ("NVIDIA", "Information Technology", 1045810, 0.06, 0.30, 0.0),
          "AAPL": ("Apple Inc.", "Information Technology", 320193, 0.03, 0.26, 0.0),
          "KO": ("Coca-Cola Company (The)", "Consumer Staples", 21344, 0.008, 0.24, 0.60),
          "XOM": ("ExxonMobil", "Energy", 34088, -0.005, 0.10, 1.0),
          "JNJ": ("Johnson & Johnson", "Health Care", 200406, 0.01, 0.20, 1.3)}
    (out / "datasets_s-and-p-500-companies_main_data_constituents.csv").write_text(
        "Symbol,Security,GICS Sector,GICS Sub-Industry,Headquarters Location,Date added,CIK,Founded\n"
        + "".join(f"{t},{n},{sec},x,x,2000-01-01,{c},1900\n" for t, (n, sec, c, *_r) in sp.items()), "utf-8")
    frames: dict[str, list] = {}
    def frame(tag, unit, period, cik, val):
        frames.setdefault(f"api_xbrl_frames_us-gaap_{tag}_{unit}_{period}.json.json", []).append({"cik": cik, "val": val})
    for t, (n, sec, cik, g, margin, div) in sp.items():
        r3 = random.Random(cik)
        base = r3.uniform(1e10, 5e10)
        for y in (2024, 2025, 2026):
            tot = {"rev": 0.0, "ni": 0.0, "eps": 0.0}
            for q in (1, 2, 3, 4):
                if (y, q) > (2026, 2):
                    break
                rv = base * (1 + g) ** ((y - 2024) * 4 + q)
                ni, e = rv * margin, round(rv * margin / 4e9, 3)
                for k, v in (("rev", rv), ("ni", ni), ("eps", e)):
                    tot[k] += v
                if q < 4:                                   # 第四季只有全年（測試推算）
                    frame("RevenueFromContractWithCustomerExcludingAssessedTax", "USD", f"CY{y}Q{q}", cik, round(rv))
                    frame("NetIncomeLoss", "USD", f"CY{y}Q{q}", cik, round(ni))
                    frame("EarningsPerShareDiluted", "USD-per-shares", f"CY{y}Q{q}", cik, e)
                frame("StockholdersEquity", "USD", f"CY{y}Q{q}I", cik, round(rv * margin * 4 / 0.25))
            if y < 2026:
                frame("RevenueFromContractWithCustomerExcludingAssessedTax", "USD", f"CY{y}", cik, round(tot["rev"]))
                frame("NetIncomeLoss", "USD", f"CY{y}", cik, round(tot["ni"]))
                frame("EarningsPerShareDiluted", "USD-per-shares", f"CY{y}", cik, round(tot["eps"], 3))
        if t not in us:                                     # NVDA / AAPL 已有 3 年日線 fixture
            px0 = {"KO": 70.0, "XOM": 110.0, "JNJ": 160.0}[t]
            ser = walk(random.Random(t), px0, 252, 0.0002, 0.01)
            ts = [int(dt.datetime.combine(d, dt.time(20, 0)).timestamp()) for d in days[-252:]]
            events = {"dividends": {str(ts[i]): {"amount": div, "date": ts[i]} for i in (30, 93, 156, 219)}}
            w(f"yahoo_{t}.json", {"chart": {"result": [{
                "meta": {"longName": n, "fullExchangeName": "NYSE", "currency": "USD", "gmtoffset": -18000},
                "timestamp": ts, "events": events,
                "indicators": {"quote": [{"open": ser, "high": ser, "low": ser, "close": ser,
                                          "volume": [10**6] * len(ser)}]}}], "error": None}})
    for name, data in frames.items():
        w(name, {"taxonomy": "us-gaap", "data": data})

    (out / "README.txt").write_text("合成測試資料（非真實行情）。由 tests/fixtures/make_fixtures.py 產生。\n", "utf-8")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--today", default="2026-10-19")
    ap.add_argument("--xss", action="store_true", help="加入含 HTML 的股票名稱，測試網頁是否正確跳脫")
    a = ap.parse_args()
    make(Path(a.out), dt.date.fromisoformat(a.today), a.xss)
    print(f"fixtures written to {a.out}")
