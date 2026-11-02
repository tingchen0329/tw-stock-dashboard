"""
美股選股資料（us/screen.json）：S&P 500 成分股 + 美股追蹤清單（只用標準函式庫；由 fetch_data.py 呼叫）

來源（皆免費、免金鑰）：
  * 成分股清單：GitHub datasets/s-and-p-500-companies（代號、名稱、產業、CIK）
  * 財報：美國證管會 SEC EDGAR「frames」API —— 一個請求就拿到「所有公司」同一科目、同一季的數字，
    不必逐檔下載 companyfacts（每檔 1–5 MB）。第四季多半只申報全年 → 全年 − 前三季
  * 股價與股利：Yahoo chart API（近一年日線 + 配息事件）

財報與股價每天更新一次（full 模式或檔案不存在時），其餘時間沿用上一份。
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

SP500_CSV = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv"
SEC_FRAME = "https://data.sec.gov/api/xbrl/frames/us-gaap/{tag}/{unit}/{period}.json"
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/"

# 科目 → 候選 us-gaap 名稱（依序取第一個有值的）
CONCEPTS = {
    "rev": (["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"], "USD"),
    "ni": (["NetIncomeLoss"], "USD"),
    "eps": (["EarningsPerShareDiluted"], "USD-per-shares"),
}
EQUITY = ("StockholdersEquity", "USD")
COLS = ["code", "name", "sector", "close", "chgPct", "r20", "pe", "yield", "roe", "revYoY", "epsYoY",
        "netMargin", "epsTTM", "period"]


def quarters_back(today: dt.date, n: int) -> list[tuple[int, int]]:
    """今天之前已結束的 n 個日曆季（新→舊）：[(2026, 3), (2026, 2), ...]"""
    y, q = today.year, (today.month - 1) // 3          # 本季尚未結束 → 從上一季開始
    if q == 0:
        y, q = y - 1, 4
    out = []
    for _ in range(n):
        out.append((y, q))
        y, q = (y - 1, 4) if q == 1 else (y, q - 1)
    return out


def load_universe(text: str) -> dict[str, dict]:
    """成分股 CSV → {代號: {name, sector, cik}}；BRK.B → BRK-B（Yahoo / SEC 的寫法）"""
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        sym = (r.get("Symbol") or "").strip().upper().replace(".", "-")
        if re.fullmatch(r"[A-Z][A-Z0-9\-]{0,9}", sym):
            cik = (r.get("CIK") or "").strip()
            out[sym] = {"name": (r.get("Security") or "").strip(), "sector": (r.get("GICS Sector") or "").strip(),
                        "cik": int(cik) if cik.isdigit() else None}
    return out


def frame_values(payload: dict) -> dict[int, float]:
    return {int(d["cik"]): d["val"] for d in (payload or {}).get("data", []) if d.get("cik") is not None and d.get("val") is not None}


def build_quarterly(frames: dict[str, dict[int, float]], qs: list[tuple[int, int]]) -> dict[int, dict[tuple[int, int], float]]:
    """
    frames：{"CY2026Q3": {cik: val}, "CY2025": {...}} → {cik: {(年, 季): 值}}
    第四季缺時用全年 − Q1 − Q2 − Q3 推算。
    """
    out: dict[int, dict[tuple[int, int], float]] = {}
    for (y, q) in qs:
        for cik, v in frames.get(f"CY{y}Q{q}", {}).items():
            out.setdefault(cik, {})[(y, q)] = v
    for (y, q) in qs:
        if q != 4:
            continue
        for cik, total in frames.get(f"CY{y}", {}).items():
            d = out.setdefault(cik, {})
            parts = [d.get((y, k)) for k in (1, 2, 3)]
            if (y, 4) not in d and all(p is not None for p in parts):
                d[(y, 4)] = round(total - sum(parts), 4)
    return out


def metrics(q: dict[str, dict[tuple[int, int], float]], qs: list[tuple[int, int]], equity: float | None) -> dict:
    """單一公司：最新一季營收 / EPS 年增、淨利率、近四季 EPS、ROE（近四季淨利 ÷ 最新權益）"""
    rev, ni, eps = q.get("rev", {}), q.get("ni", {}), q.get("eps", {})
    latest = next((k for k in qs if k in rev or k in eps), None)
    if latest is None:
        return {}
    i = qs.index(latest)
    ago = qs[i + 4] if i + 4 < len(qs) else None
    last4 = qs[i:i + 4]
    pct = lambda a, b: round((a / b - 1) * 100, 2) if a is not None and b not in (None, 0) and b > 0 else None  # noqa: E731
    eps_ttm = round(sum(eps[k] for k in last4), 4) if all(k in eps for k in last4) else None
    ni_ttm = sum(ni[k] for k in last4) if all(k in ni for k in last4) else None
    return {
        "period": f"{latest[0]}Q{latest[1]}",
        "revYoY": pct(rev.get(latest), rev.get(ago)) if ago else None,
        "epsYoY": pct(eps.get(latest), eps.get(ago)) if ago else None,
        "netMargin": round(ni[latest] / rev[latest] * 100, 2) if latest in ni and rev.get(latest) else None,
        "epsTTM": eps_ttm,
        "roe": round(ni_ttm / equity * 100, 2) if ni_ttm is not None and equity and equity > 0 else None,
    }


def price_info(payload: dict) -> dict | None:
    """Yahoo 近一年日線 → 收盤、漲跌幅、20 日報酬、近一年現金股利合計"""
    try:
        r = payload["chart"]["result"][0]
        closes = [c for c in (r["indicators"]["quote"][0].get("close") or []) if c is not None]
    except (KeyError, IndexError, TypeError):
        return None
    if len(closes) < 2:
        return None
    divs = (r.get("events") or {}).get("dividends") or {}
    div_ttm = sum(float(d.get("amount") or 0) for d in divs.values())
    c = closes[-1]
    return {"close": round(c, 2), "chgPct": round((c / closes[-2] - 1) * 100, 2),
            "r20": round((c / closes[-21] - 1) * 100, 2) if len(closes) > 21 else None,
            "div": div_ttm}


def build_us_screen(tx, report, today: dt.date, extra: list[str]) -> dict | None:
    text = report.run("us_universe", lambda: tx.get_text(SP500_CSV), count=lambda t: t.count("\n") if t else 0)
    universe = load_universe(text or "")
    if not universe:
        return None
    qs = quarters_back(today, 9)                      # 最新一季往回 9 季：近四季 + 去年同季
    periods = [f"CY{y}Q{q}" for y, q in qs] + sorted({f"CY{y}" for y, q in qs if q == 4})
    jobs = [(key, tag, unit, p) for key, (tags, unit) in CONCEPTS.items() for tag in tags for p in periods]

    def frame(job):
        key, tag, unit, p = job
        try:
            return job, frame_values(tx.get_json(SEC_FRAME.format(tag=tag, unit=unit, period=p), kind="sec"))
        except Exception:  # noqa: BLE001 — 尚未有資料的季（例如剛結束的一季）會 404
            return job, {}

    def all_frames():
        got: dict[str, dict[str, dict[int, float]]] = {}
        with ThreadPoolExecutor(max_workers=4) as pool:      # SEC 上限每秒 10 個請求
            for (key, tag, unit, p), vals in pool.map(frame, jobs):
                tgt = got.setdefault(key, {}).setdefault(p, {})
                for cik, v in vals.items():
                    tgt.setdefault(cik, v)             # 候選科目依序：先出現的優先
        return got
    frames = report.run("us_sec_frames", all_frames, count=lambda g: sum(len(v) for p in g.values() for v in p.values()))
    quarterly = {key: build_quarterly(f, qs) for key, f in (frames or {}).items()}
    equity: dict[int, float] = {}
    for y, q in qs[:3]:                                 # 最新的資產負債表（最近三季中有的那一季）
        for cik, v in (frame((None, EQUITY[0], EQUITY[1], f"CY{y}Q{q}I"))[1]).items():
            equity.setdefault(cik, v)

    symbols = list(dict.fromkeys(list(universe) + [s for s in extra if s not in universe]))

    def px(sym):
        try:
            return sym, price_info(tx.get_json(f"{YAHOO_CHART}{sym}", {"range": "1y", "interval": "1d", "events": "div"}))
        except Exception:  # noqa: BLE001
            return sym, None
    def all_prices():
        with ThreadPoolExecutor(max_workers=8) as pool:
            return dict(pool.map(px, symbols))
    prices = report.run("us_screen_prices", all_prices, count=lambda d: sum(1 for v in d.values() if v))

    rows = []
    for sym in symbols:
        u = universe.get(sym, {"name": "", "sector": "", "cik": None})
        p = (prices or {}).get(sym)
        cik = u["cik"]
        m = metrics({k: quarterly.get(k, {}).get(cik, {}) for k in CONCEPTS}, qs, equity.get(cik)) if cik else {}
        if not p and not m:
            continue
        close = (p or {}).get("close")
        eps = m.get("epsTTM")
        rows.append([sym, u["name"], u["sector"], close, (p or {}).get("chgPct"), (p or {}).get("r20"),
                     round(close / eps, 2) if close and eps and eps > 0 else None,
                     round(p["div"] / close * 100, 2) if p and close and p.get("div") else (0.0 if p else None),
                     m.get("roe"), m.get("revYoY"), m.get("epsYoY"), m.get("netMargin"), eps, m.get("period")])
    periods_seen = sorted({r[-1] for r in rows if r[-1]})
    span = None if not periods_seen else periods_seen[-1] if len(periods_seen) == 1 else f"{periods_seen[0]}～{periods_seen[-1]}"
    return {"asOf": {"date": today.isoformat(), "income": span, "universe": "S&P 500"}, "cols": COLS, "rows": rows}
