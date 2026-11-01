"""
美股資料（只用標準函式庫；由 fetch_data.py 呼叫）

來源（皆免費、免金鑰）：
  * Yahoo Finance chart API：3 年日線（技術指標）與最新報價
  * 美國證管會 SEC EDGAR companyfacts：官方財報（營收、毛利、營業利益、淨利、EPS、資產負債）

輸出格式刻意與台股 FinMind 個股檔相同（{cols, rows} 資料表、type 用 Revenue / EPS 等名稱），
網頁與 analytics.js 不需要分辨台股或美股就能算出技術指標、近四季 EPS、ROE 等。

SEC 規範：每秒最多 10 個請求，User-Agent 必須包含聯絡方式。
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import json
import re
from pathlib import Path
from typing import Any, Callable

YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/"
SEC_TICKERS = "https://www.sec.gov/files/company_tickers.json"
SEC_FACTS = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"

US_SYMBOL = re.compile(r"[A-Z][A-Z0-9.\-]{0,9}")
PRICE_COLS = ["date", "open", "max", "min", "close", "Trading_Volume"]     # 與 FinMind TaiwanStockPrice 相同
FACT_COLS = ["date", "type", "value", "origin_name"]

# SEC us-gaap 科目 → analytics.js 認得的 type。同一個 type 有多個候選科目時，依序取第一個有值的
# （公司會換科目名稱，例如 2018 年後營收多改用 RevenueFromContractWithCustomer...）
DURATION_CONCEPTS = {
    "Revenue": ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet",
                "RevenueFromContractWithCustomerIncludingAssessedTax"],
    "GrossProfit": ["GrossProfit"],
    "OperatingIncome": ["OperatingIncomeLoss"],
    "IncomeAfterTaxes": ["NetIncomeLoss", "ProfitLoss"],
    "EPS": ["EarningsPerShareDiluted", "EarningsPerShareBasic"],
}
INSTANT_CONCEPTS = {
    "TotalAssets": ["Assets"],
    "Liabilities": ["Liabilities"],
    "Equity": ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
    "CurrentAssets": ["AssetsCurrent"],
    "CurrentLiabilities": ["LiabilitiesCurrent"],
}
QUARTERS = 12          # 保留 3 年（12 季）
QEND = {1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31"}


def load_us_watchlist(path: Path) -> list[str]:
    """美股清單 CSV：取標題含 Symbol / 代號 的欄位（沒有標題就取第一欄），保留順序、去重複"""
    if not path.exists():
        return []
    rows = [r for r in csv.reader(io.StringIO(path.read_text("utf-8-sig"))) if any(c.strip() for c in r)]
    if not rows:
        return []
    head = [c.strip().lower() for c in rows[0]]
    col = next((i for i, c in enumerate(head) if any(k in c for k in ("symbol", "代號", "ticker"))), None)
    out: list[str] = []
    for r in rows[1:] if col is not None else rows:
        cell = (r[col] if col is not None and col < len(r) else r[0]).strip().upper()
        if US_SYMBOL.fullmatch(cell) and cell not in out:
            out.append(cell)
    return out


def parse_chart(payload: dict) -> dict | None:
    """Yahoo 日線 → {table, name, exchange, currency}。缺值的日子（停牌、資料空洞）略過"""
    try:
        r = payload["chart"]["result"][0]
        meta, ts = r["meta"], r.get("timestamp") or []
        q = (r.get("indicators", {}).get("quote") or [{}])[0]
    except (KeyError, IndexError, TypeError):
        return None
    tz = dt.timezone(dt.timedelta(seconds=meta.get("gmtoffset") or 0))
    rows = []
    for i, t in enumerate(ts):
        vals = [(q.get(k) or [None] * len(ts))[i] for k in ("open", "high", "low", "close", "volume")]
        if vals[3] is None:
            continue
        d = dt.datetime.fromtimestamp(t, tz).date().isoformat()
        rows.append([d, *[round(v, 4) if isinstance(v, float) else v for v in vals]])
    if not rows:
        return None
    return {"table": {"cols": PRICE_COLS, "rows": rows},
            "name": meta.get("longName") or meta.get("shortName") or "",
            "exchange": meta.get("fullExchangeName") or meta.get("exchangeName") or "",
            "currency": meta.get("currency") or "USD"}


def _frame_date(frame: str) -> str | None:
    """SEC frame → 日曆季末日期：CY2025Q2 / CY2025Q2I → 2025-06-30；CY2025 → 2025-12-31（年度）"""
    m = re.fullmatch(r"CY(\d{4})(?:Q([1-4]))?I?", frame or "")
    if not m:
        return None
    return f"{m.group(1)}-{QEND[int(m.group(2) or 4)]}"


def _units(concept: dict, kind: str) -> list[dict]:
    u = concept.get("units", {})
    return u.get("USD/shares" if kind == "EPS" else "USD", [])


def parse_companyfacts(facts: dict) -> dict:
    """
    companyfacts → {income: 表, balance: 表, shares}
    季度數字用 SEC 的 frame（已去除重複申報、對齊日曆季）；第四季常只有全年數字 → 全年減前三季。
    """
    g = (facts or {}).get("facts", {}).get("us-gaap", {})
    income: dict[tuple[str, str], float] = {}
    for typ, names in DURATION_CONCEPTS.items():
        quarters: dict[str, float] = {}
        annual: dict[str, float] = {}
        for name in names:
            for f in _units(g.get(name, {}), typ):
                frame, val = f.get("frame", ""), f.get("val")
                if val is None or not frame or frame.endswith("I"):
                    continue
                d = _frame_date(frame)
                if "Q" in frame:
                    quarters.setdefault(d, val)
                else:
                    annual.setdefault(d, val)
        for d, total in annual.items():                      # 第四季 = 全年 − Q1 − Q2 − Q3
            if d in quarters:
                continue
            y = d[:4]
            parts = [quarters.get(f"{y}-{QEND[q]}") for q in (1, 2, 3)]
            if all(p is not None for p in parts):
                quarters[d] = round(total - sum(parts), 4)
        for d, v in quarters.items():
            income[(d, typ)] = v
    balance: dict[tuple[str, str], float] = {}
    for typ, names in INSTANT_CONCEPTS.items():
        for name in names:
            for f in _units(g.get(name, {}), typ):
                d = _frame_date(f.get("frame", ""))
                if d and f.get("val") is not None and f.get("frame", "").endswith("I"):
                    balance.setdefault((d, typ), f["val"])
    # 部分公司沒有申報 Liabilities：用 總資產 − 權益 推算
    for (d, typ), v in list(balance.items()):
        if typ == "TotalAssets" and (d, "Liabilities") not in balance and (d, "Equity") in balance:
            balance[(d, "Liabilities")] = v - balance[(d, "Equity")]

    def table(src: dict) -> dict:
        dates = sorted({d for d, _ in src})[-QUARTERS:]
        rows = [[d, t, v, t] for (d, t), v in sorted(src.items()) if d in dates]
        return {"cols": FACT_COLS, "rows": rows}

    shares = None
    for f in (facts or {}).get("facts", {}).get("dei", {}).get("EntityCommonStockSharesOutstanding", {}).get("units", {}).get("shares", []):
        if f.get("val") and (shares is None or f.get("end", "") >= shares[0]):
            shares = (f.get("end", ""), f["val"])
    return {"income": table(income), "balance": table(balance), "shares": shares[1] if shares else None}


def fetch_us(tx, report, out: Path, symbols: list[str], full: bool, write_json: Callable[[Path, Any], int],
             now_iso: str, sec_ua: str) -> dict[str, int]:
    """
    抓追蹤清單的美股，寫 out/us/stock/<代號>.json，回傳 {相對路徑: 位元組}。
    股價每次都更新；SEC 財報只在 full（或該檔還沒有財報）時重抓，其餘沿用上一份（網站上取回的檔案）。
    """
    d = out / "us" / "stock"
    d.mkdir(parents=True, exist_ok=True)
    for f in d.glob("*.json"):                     # 移除已不在清單上的
        if f.stem not in symbols:
            f.unlink()
    prev = {}
    for s in symbols:
        try:
            prev[s] = json.loads((d / f"{s}.json").read_text("utf-8"))
        except (OSError, ValueError):
            prev[s] = None

    need_sec = [s for s in symbols if full or not (prev[s] or {}).get("secAt")]
    cik: dict[str, int] = {}
    if need_sec:
        tick = report.run("sec_tickers", lambda: tx.get_json(SEC_TICKERS, kind="sec"),
                          count=lambda r: len(r) if isinstance(r, dict) else 0) or {}
        cik = {str(v.get("ticker", "")).upper(): int(v["cik_str"]) for v in tick.values() if v.get("cik_str")}

    ok_px = ok_sec = 0
    sizes = {}
    for s in symbols:
        old = prev[s] or {}
        errors = {}
        try:
            chart = parse_chart(tx.get_json(f"{YAHOO_CHART}{s}", {"range": "3y", "interval": "1d"}))
        except Exception as e:  # noqa: BLE001
            chart, errors["price"] = None, str(e)[:120]
        tables = dict(old.get("tables") or {})
        if chart:
            tables["price"] = chart["table"]
            ok_px += 1
        sec_at, shares = old.get("secAt"), old.get("shares")
        if s in need_sec:
            if s in cik:
                try:
                    fin = parse_companyfacts(tx.get_json(SEC_FACTS.format(cik=cik[s]), kind="sec"))
                    if fin["income"]["rows"] or fin["balance"]["rows"]:
                        tables["income"], tables["balance"] = fin["income"], fin["balance"]
                        shares, sec_at = fin["shares"], now_iso
                        ok_sec += 1
                    else:
                        errors["income"] = "SEC 沒有 us-gaap 財報（外國公司或 ETF）"
                except Exception as e:  # noqa: BLE001
                    errors["income"] = str(e)[:120]
            else:
                errors["income"] = "SEC 查無此代號（ETF 或非美國公司）"
        elif tables.get("income"):
            ok_sec += 1
        detail = {"code": s, "name": (chart or {}).get("name") or old.get("name", ""),
                  "exchange": (chart or {}).get("exchange") or old.get("exchange", ""),
                  "currency": (chart or {}).get("currency") or old.get("currency", "USD"),
                  "fetchedAt": now_iso if chart else old.get("fetchedAt"), "secAt": sec_at, "shares": shares,
                  "tables": tables, "errors": errors}
        if tables:
            sizes[f"us/stock/{s}.json"] = write_json(d / f"{s}.json", detail)
    report.items["us_prices"] = {"ok": ok_px == len(symbols), "rows": ok_px, "ms": 0,
                                 "note": "" if ok_px == len(symbols) else f"{len(symbols) - ok_px} 檔股價失敗"}
    report.items["us_financials"] = {"ok": ok_sec > 0 or not symbols, "rows": ok_sec, "ms": 0,
                                     "note": f"{len(symbols) - ok_sec} 檔沒有 SEC 財報（ETF / 外國公司為正常）"
                                     if ok_sec < len(symbols) else ""}
    return sizes
