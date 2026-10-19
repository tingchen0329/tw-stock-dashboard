#!/usr/bin/env python3
"""
台股儀表板 — 伺服器端資料抓取腳本 (GitHub Actions 執行)
=========================================================

為什麼需要這支腳本？
--------------------
GitHub Pages 是「純靜態」網站：放在網頁裡的任何東西（包含 API token）
都能被任何人用「檢視原始碼」看到。所以 FinMind token **絕對不能**
出現在網頁程式碼裡。

正確做法是：
  1. token 存在 GitHub → Settings → Secrets → `FINMIND_TOKEN`
  2. GitHub Actions 執行本腳本時，以「環境變數」取得 token（只存在於執行中的 runner）
  3. 本腳本在伺服器端抓資料，輸出成「不含 token 的」JSON 檔
  4. 網頁只讀這些 JSON → 瀏覽器永遠看不到 token

順帶好處：伺服器端沒有 CORS 限制，可以直接抓證交所 / 櫃買 / Yahoo，
不再依賴不穩定的公共 CORS proxy（舊版「所有來源失敗」的主因）。

輸出檔案（--out 目錄下）
------------------------
  meta.json         產生時間、各資料源狀態、追蹤清單
  stocks.json       全市場股票清單（代號 / 名稱 / 市場 / 產業）→ 搜尋用
  market.json       全市場當日行情 + 本益比 + 三大法人（上市 + 上櫃）
  quotes.json       追蹤清單盤中報價（Yahoo，約延遲 20 分鐘）
  macro.json        總經：加權、櫃買、匯率、美元指數、美債、黃金、Fed 利率
  stock/<代號>.json 追蹤清單個股完整資料（FinMind）
  datasets.json     資料集規格（從 assets/ 複製，網頁即時查詢時共用）

只用 Python 標準函式庫，不需 pip install。

使用方式
--------
  # 正式抓取（token 從環境變數讀取，沒有 token 也能跑，只是額度較低）
  FINMIND_TOKEN=xxx python scripts/fetch_data.py --out _site/data

  # 離線模式：用 tests/fixtures 的假資料產生網站資料（本機預覽 / 測試用）
  python scripts/fetch_data.py --out _site/data --fixtures tests/fixtures
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

# ──────────────────────────────────────────────────────────────────────
# 常數設定
# ──────────────────────────────────────────────────────────────────────
TPE = ZoneInfo("Asia/Taipei")            # 所有日期以台北時間為準（舊版用 UTC，08:00 前日期會錯）
REPO_ROOT = Path(__file__).resolve().parent.parent

FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
TWSE_OPENAPI = "https://openapi.twse.com.tw/v1"
TWSE_T86 = "https://www.twse.com.tw/rwd/zh/fund/T86"     # 三大法人（OpenAPI 沒有個股版本）
TPEX_OPENAPI = "https://www.tpex.org.tw/openapi/v1"
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/"

HTTP_TIMEOUT = 25           # 秒；GitHub runner 連台灣站台偶爾較慢
FINMIND_WORKERS = 4         # FinMind 同時連線數。太高會被限流，4 是保守值
TWSE_GAP_SEC = 1.2          # 證交所 www 站有防爬（短時間大量請求會封 IP），每次請求間隔
USER_AGENT = "tw-stock-dashboard/6 (+https://github.com/tingchen0329/tw-stock-dashboard)"


# ──────────────────────────────────────────────────────────────────────
# 小工具
# ──────────────────────────────────────────────────────────────────────
def now_tpe() -> dt.datetime:
    return dt.datetime.now(TPE)


def log(msg: str) -> None:
    """輸出到 GitHub Actions log。注意：任何地方都不可印出 token。"""
    print(f"[{now_tpe():%H:%M:%S}] {msg}", flush=True)


def to_num(v: Any) -> float | None:
    """
    把官方 API 的各種數字字串轉成 float。
    證交所 / 櫃買常見格式："1,234.50"、"+5.00"、"-3"、"--"、""、"X0.00"（X 表示除權息）。
    無法解析時回傳 None（前端顯示 N/A），絕不猜數字。
    """
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "").replace("X", "").replace("+", "")
    if s in ("", "-", "--", "---", "N/A", "NaN", "null"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def roc_to_iso(s: Any) -> str | None:
    """民國日期轉西元：'1151019' 或 '115/10/19' → '2026-10-19'。已是西元格式就直接回傳。"""
    if not s:
        return None
    t = str(s).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", t):
        return t
    if re.fullmatch(r"\d{8}", t):                       # 20261019
        return f"{t[:4]}-{t[4:6]}-{t[6:]}"
    m = re.fullmatch(r"(\d{2,3})/?(\d{2})/?(\d{2})", t)  # 1151019 或 115/10/19
    if m:
        return f"{int(m.group(1)) + 1911:04d}-{m.group(2)}-{m.group(3)}"
    return None


def pick(row: dict, *keys: str) -> Any:
    """
    依序嘗試多個欄位名稱，回傳第一個存在的值。
    官方 OpenAPI 偶爾改欄位名稱（尤其櫃買），用候選清單提高韌性。
    """
    for k in keys:
        if k in row and row[k] not in (None, ""):
            return row[k]
    return None


def round_or_none(v: float | None, nd: int = 2) -> float | None:
    return None if v is None else round(v, nd)


# ──────────────────────────────────────────────────────────────────────
# 傳輸層：正式環境用 HTTP，測試 / 本機預覽用 fixtures
# 同一套解析程式碼跑在兩種傳輸上 → 測試驗證的就是正式邏輯
# ──────────────────────────────────────────────────────────────────────
class QuotaExceeded(Exception):
    """FinMind 回傳 HTTP 402：本小時額度用完。遇到就停止後續 FinMind 請求。"""


class HttpTransport:
    def __init__(self, finmind_token: str | None):
        # token 只存在記憶體；只放進 HTTP header，不放進 URL（URL 會出現在各種 log 裡）
        self._token = finmind_token or None
        self._twse_lock = threading.Lock()
        self._twse_last = 0.0
        self.finmind_requests = 0

    def _get(self, url: str, headers: dict | None = None, retries: int = 2) -> bytes:
        """GET 並在 429 / 5xx / 網路錯誤時指數退避重試。402 直接拋出 QuotaExceeded。"""
        hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json,text/csv,*/*"}
        hdrs.update(headers or {})
        last_err: Exception | None = None
        for attempt in range(retries + 1):
            try:
                req = urllib.request.Request(url, headers=hdrs)
                with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                    return resp.read()
            except urllib.error.HTTPError as e:
                if e.code == 402:
                    raise QuotaExceeded("FinMind quota exceeded (HTTP 402)") from None
                last_err = e
                if e.code not in (429, 500, 502, 503, 504):
                    break
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                last_err = e
            time.sleep(1.5 * (2 ** attempt))
        # 錯誤訊息只含 URL 路徑，不含 header（header 裡才有 token）
        raise RuntimeError(f"GET failed: {urllib.parse.urlsplit(url).path} ({last_err})")

    def get_json(self, url: str, params: dict | None = None, kind: str = "public") -> Any:
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        headers = {}
        if kind == "finmind":
            self.finmind_requests += 1
            if self._token:
                headers["Authorization"] = f"Bearer {self._token}"
        elif kind == "twse_www":
            # 證交所 www 站限流：同一時間只允許一個請求，且與上次間隔 TWSE_GAP_SEC
            with self._twse_lock:
                wait = TWSE_GAP_SEC - (time.monotonic() - self._twse_last)
                if wait > 0:
                    time.sleep(wait)
                self._twse_last = time.monotonic()
        return json.loads(self._get(url, headers).decode("utf-8-sig"))


class FixtureTransport:
    """
    離線傳輸：把 (網址, 參數) 對應到 tests/fixtures/ 底下的檔案。
    檔名規則見 fixture_name()。找不到 fixture 就當作該來源失敗（測試失敗路徑用）。
    """

    def __init__(self, fixture_dir: Path):
        self.dir = fixture_dir
        self.finmind_requests = 0

    @staticmethod
    def fixture_name(url: str, params: dict | None) -> str:
        p = params or {}
        if url.startswith(FINMIND_URL):
            parts = [p.get("dataset", ""), p.get("data_id", "")]
            return "finmind_" + "_".join(x for x in parts if x).replace(" ", "-") + ".json"
        if url.startswith(YAHOO_CHART):
            sym = urllib.parse.unquote(url[len(YAHOO_CHART):]).replace("^", "IDX_").replace("=", "_")
            return f"yahoo_{sym}.json"
        if url.startswith(TWSE_T86):
            return f"twse_T86_{p.get('date', '')}.json"
        path = urllib.parse.urlsplit(url).path.strip("/").replace("/", "_")
        return f"{path}.json"

    def get_json(self, url: str, params: dict | None = None, kind: str = "public") -> Any:
        if kind == "finmind":
            self.finmind_requests += 1
        f = self.dir / self.fixture_name(url, params)
        if not f.exists():
            raise RuntimeError(f"no fixture: {f.name}")
        return json.loads(f.read_text("utf-8"))


# ──────────────────────────────────────────────────────────────────────
# 資料源狀態紀錄：每個來源成功與否、筆數、耗時 → 寫進 meta.json
# 網頁會顯示這份報告，讓你一眼看出哪個來源掛了（取代舊版的「所有來源失敗」）
# ──────────────────────────────────────────────────────────────────────
class SourceReport:
    def __init__(self) -> None:
        self.items: dict[str, dict] = {}
        self._lock = threading.Lock()

    def run(self, name: str, fn: Callable[[], Any], count: Callable[[Any], int] = len) -> Any:
        t0 = time.monotonic()
        try:
            result = fn()
            rows = count(result) if result is not None else 0
            entry = {"ok": rows > 0, "rows": rows}
            if rows == 0:
                entry["note"] = "回應成功但解析出 0 筆（可能是非交易日或欄位名稱變更）"
        except QuotaExceeded:
            raise
        except Exception as e:  # noqa: BLE001 — 單一來源失敗不能拖垮整次執行
            result, entry = None, {"ok": False, "rows": 0, "note": str(e)[:200]}
        entry["ms"] = int((time.monotonic() - t0) * 1000)
        with self._lock:
            self.items[name] = entry
        log(f"{'OK ' if entry['ok'] else 'ERR'} {name:<16} rows={entry['rows']:<5} {entry['ms']}ms {entry.get('note', '')}")
        return result


# ──────────────────────────────────────────────────────────────────────
# 全市場資料：證交所 / 櫃買（免 token，伺服器端無 CORS 問題）
# ──────────────────────────────────────────────────────────────────────
MARKET_COLS = ["close", "change", "open", "high", "low", "volume",
               "pe", "pb", "yield", "foreign", "trust", "dealer", "inst"]


def parse_twse_quotes(rows: list[dict]) -> tuple[dict[str, dict], str | None]:
    """證交所 STOCK_DAY_ALL → {代號: {close, change, ...}}。volume 單位：股。"""
    out, as_of = {}, None
    for r in rows or []:
        code = str(pick(r, "Code", "證券代號") or "").strip()
        if not code:
            continue
        as_of = as_of or roc_to_iso(pick(r, "Date", "日期"))
        out[code] = {
            "name": pick(r, "Name", "證券名稱"),
            "close": to_num(pick(r, "ClosingPrice", "收盤價")),
            "change": to_num(pick(r, "Change", "漲跌價差")),
            "open": to_num(pick(r, "OpeningPrice", "開盤價")),
            "high": to_num(pick(r, "HighestPrice", "最高價")),
            "low": to_num(pick(r, "LowestPrice", "最低價")),
            "volume": to_num(pick(r, "TradeVolume", "成交股數")),
        }
    return out, as_of


def parse_twse_valuation(rows: list[dict]) -> dict[str, dict]:
    """證交所 BWIBBU_ALL → 本益比 / 股價淨值比 / 殖利率。虧損公司 PE 為空字串 → None。"""
    out = {}
    for r in rows or []:
        code = str(pick(r, "Code", "證券代號") or "").strip()
        if code:
            out[code] = {
                "pe": to_num(pick(r, "PEratio", "本益比")),
                "pb": to_num(pick(r, "PBratio", "股價淨值比")),
                "yield": to_num(pick(r, "DividendYield", "殖利率(%)")),
            }
    return out


def parse_t86(payload: dict) -> dict[str, dict]:
    """
    證交所 T86 三大法人（rwd JSON：fields + data 二維陣列）。
    依「欄位名稱」找位置而不是寫死 index，證交所調整欄位順序時不會整個錯位。
    單位：股。外資 = 外陸資(不含外資自營商) + 外資自營商。
    """
    if not payload or payload.get("stat") != "OK":
        return {}
    fields = [str(f).strip() for f in payload.get("fields") or []]

    def idx(name: str, exclude: tuple[str, ...] = ()) -> int | None:
        """先找「完全相同」的欄名；找不到才用「包含」比對，並排除易混淆欄位。"""
        if name in fields:
            return fields.index(name)
        for i, f in enumerate(fields):
            if name in f and not any(x in f for x in exclude):
                return i
        return None

    i_code = idx("證券代號")
    i_fx = idx("外陸資買賣超股數")
    i_fxd = idx("外資自營商買賣超股數")
    i_trust = idx("投信買賣超股數")
    # 注意：「外資自營商買賣超股數」也包含「自營商買賣超股數」字樣，必須排除，
    # 另外「(自行買賣)」「(避險)」是自營商的子項目，要的是合計欄
    i_dealer = idx("自營商買賣超股數", exclude=("外資", "自行", "避險"))
    i_total = idx("三大法人買賣超股數")
    if i_code is None or i_total is None:
        return {}
    out = {}
    for row in payload.get("data") or []:
        code = str(row[i_code]).strip()
        g = lambda i: to_num(row[i]) if i is not None and i < len(row) else None  # noqa: E731
        foreign = (g(i_fx) or 0) + (g(i_fxd) or 0) if i_fx is not None else None
        out[code] = {"foreign": foreign, "trust": g(i_trust), "dealer": g(i_dealer), "inst": g(i_total)}
    return out


def fetch_t86(tx, today: dt.date) -> tuple[dict, str | None]:
    """T86 只能查單日：從今天往回找最近一個有資料的交易日（最多 7 天）。"""
    for back in range(0, 8):
        d = today - dt.timedelta(days=back)
        if d.weekday() >= 5:      # 週末跳過，少打幾次證交所
            continue
        try:
            payload = tx.get_json(TWSE_T86, {"date": d.strftime("%Y%m%d"),
                                             "selectType": "ALLBUT0999", "response": "json"},
                                  kind="twse_www")
        except RuntimeError:
            continue
        parsed = parse_t86(payload)
        if parsed:
            return parsed, d.isoformat()
    return {}, None


def parse_tpex_quotes(rows: list[dict]) -> tuple[dict[str, dict], str | None]:
    """櫃買上櫃行情。欄位名稱以候選清單比對（櫃買 OpenAPI 文件與實際回應曾不一致）。"""
    out, as_of = {}, None
    for r in rows or []:
        code = str(pick(r, "SecuritiesCompanyCode", "Code", "代號") or "").strip()
        if not code:
            continue
        as_of = as_of or roc_to_iso(pick(r, "Date", "資料日期"))
        out[code] = {
            "name": pick(r, "CompanyName", "Name", "名稱"),
            "close": to_num(pick(r, "Close", "ClosingPrice", "收盤")),
            "change": to_num(pick(r, "Change", "漲跌")),
            "open": to_num(pick(r, "Open", "OpeningPrice", "開盤")),
            "high": to_num(pick(r, "High", "HighestPrice", "最高")),
            "low": to_num(pick(r, "Low", "LowestPrice", "最低")),
            "volume": to_num(pick(r, "TradingShares", "TradeVolume", "TradingVolume", "成交股數")),
        }
    return out, as_of


def parse_tpex_valuation(rows: list[dict]) -> dict[str, dict]:
    out = {}
    for r in rows or []:
        code = str(pick(r, "SecuritiesCompanyCode", "Code", "股票代號") or "").strip()
        if code:
            out[code] = {
                "pe": to_num(pick(r, "PriceEarningRatio", "PEratio", "本益比")),
                "pb": to_num(pick(r, "PriceBookRatio", "PBratio", "股價淨值比")),
                "yield": to_num(pick(r, "YieldRatio", "DividendYield", "殖利率")),
            }
    return out


def parse_tpex_inst(rows: list[dict]) -> dict[str, dict]:
    """
    櫃買三大法人（best-effort）。櫃買沒有穩定公開的欄位文件，
    這裡用「欄位名稱關鍵字」判斷：含 Foreign/外資 且含 Net/Diff/買賣超 → 外資淨額，依此類推。
    解析不到時回傳空 dict，追蹤清單內的上櫃股仍有 FinMind 法人資料可用。
    """
    out = {}
    for r in rows or []:
        code = str(pick(r, "SecuritiesCompanyCode", "Code", "代號") or "").strip()
        if not code:
            continue
        rec: dict[str, float | None] = {"foreign": None, "trust": None, "dealer": None, "inst": None}
        for k, v in r.items():
            kl = k.lower()
            if not any(t in kl for t in ("net", "diff", "difference", "買賣超")):
                continue
            n = to_num(v)
            if ("foreign" in kl or "外資" in k) and "dealer" not in kl and rec["foreign"] is None:
                rec["foreign"] = n
            elif ("investmenttrust" in kl or "投信" in k) and rec["trust"] is None:
                rec["trust"] = n
            elif ("dealer" in kl or "自營" in k) and "foreign" not in kl and rec["dealer"] is None:
                rec["dealer"] = n
            elif ("total" in kl or "三大法人" in k) and rec["inst"] is None:
                rec["inst"] = n
        if any(v is not None for v in rec.values()):
            out[code] = rec
    return out


def build_market(quotes: dict, valuation: dict, inst: dict) -> dict[str, list]:
    """合併成「欄位陣列」格式：{代號: [close, change, ...]}，比物件格式小約 60%。"""
    out = {}
    for code, q in quotes.items():
        v, i = valuation.get(code, {}), inst.get(code, {})
        merged = {**q, **v, **i}
        out[code] = [round_or_none(merged.get(c), 4) for c in MARKET_COLS]
    return out


# ──────────────────────────────────────────────────────────────────────
# FinMind：股票清單、總經、追蹤清單個股
# ──────────────────────────────────────────────────────────────────────
def finmind(tx, dataset: str, data_id: str | None = None, start: str | None = None) -> list[dict]:
    params = {"dataset": dataset}
    if data_id:
        params["data_id"] = data_id
    if start:
        params["start_date"] = start
    payload = tx.get_json(FINMIND_URL, params, kind="finmind")
    if payload.get("status") not in (200, None):
        raise RuntimeError(f"FinMind {dataset}: {payload.get('msg', 'status ' + str(payload.get('status')))}")
    return payload.get("data") or []


MARKET_CODE = {"twse": "twse", "tpex": "tpex", "emerging": "emerging"}


def build_stock_list(info_rows: list[dict], twse_q: dict, tpex_q: dict) -> list[list[str]]:
    """
    搜尋用全市場清單：[[代號, 名稱, 市場, 產業], ...]
    主要來源 FinMind TaiwanStockInfo（含產業別）；同一檔可能有多筆產業 → 只留第一筆。
    FinMind 失敗時，用證交所 / 櫃買行情的名稱補（沒有產業別）。
    """
    seen: dict[str, list[str]] = {}
    for r in info_rows:
        code = str(r.get("stock_id", "")).strip()
        name = str(r.get("stock_name", "")).strip()
        market = MARKET_CODE.get(str(r.get("type", "")).lower())
        if not code or not name or not market or code in seen:
            continue
        seen[code] = [code, name, market, str(r.get("industry_category", "")).strip()]
    for quotes, market in ((twse_q, "twse"), (tpex_q, "tpex")):
        for code, q in quotes.items():
            if code not in seen and q.get("name"):
                seen[code] = [code, str(q["name"]).strip(), market, ""]
    return sorted(seen.values(), key=lambda r: r[0])


def load_spec() -> dict[str, dict]:
    spec = json.loads((REPO_ROOT / "assets" / "datasets.json").read_text("utf-8"))
    return {k: v for k, v in spec.items() if not k.startswith("_")}


def keep_row(row: dict, spec: dict) -> bool:
    """財報資料集一季有上百個科目，只留分析需要的（規格寫在 datasets.json）。"""
    types, origins = spec.get("keep_types"), spec.get("keep_origin")
    if not types and not origins:
        return True
    t = str(row.get("type", ""))
    if t.endswith("_per"):            # FinMind 另外附的「佔比 %」列，用不到
        return False
    o = str(row.get("origin_name", ""))
    return t in (types or []) or any(s in o for s in (origins or []))


def to_table(rows: list[dict], spec: dict) -> dict:
    """FinMind 物件陣列 → {cols, rows} 欄位陣列格式（網頁端用同一套規格還原）。"""
    cols = spec["fields"]
    kept = [r for r in rows if keep_row(r, spec)]
    return {"cols": cols, "rows": [[r.get(c) for c in cols] for r in kept]}


def fetch_stock_detail(tx, code: str, spec: dict, today: dt.date) -> dict:
    """一檔股票的所有 FinMind 資料集。單一資料集失敗只記錄錯誤，不影響其他。"""
    tables, errors = {}, {}
    for key, s in spec.items():
        start = (today - dt.timedelta(days=int(s["days"]))).isoformat()
        try:
            tables[key] = to_table(finmind(tx, s["dataset"], code, start), s)
        except QuotaExceeded:
            raise
        except Exception as e:  # noqa: BLE001
            errors[key] = str(e)[:160]
    return {"code": code, "fetchedAt": now_tpe().isoformat(timespec="seconds"),
            "tables": tables, "errors": errors}


# ──────────────────────────────────────────────────────────────────────
# Yahoo（伺服器端，無 CORS 問題）：指數、匯率、追蹤清單盤中價
# ──────────────────────────────────────────────────────────────────────
def parse_yahoo_chart(payload: dict) -> dict | None:
    """
    取最新價、前一交易日收盤、近 60 日收盤（迷你走勢圖）。
    注意：range>1d 時 meta.chartPreviousClose 是「整段區間前」的收盤，
    不是昨收（舊版常見錯誤）。這裡用收盤序列的倒數第二筆當昨收。
    """
    try:
        r = payload["chart"]["result"][0]
        meta = r["meta"]
        ts = r.get("timestamp") or []
        closes = (r.get("indicators", {}).get("quote") or [{}])[0].get("close") or []
    except (KeyError, IndexError, TypeError):
        return None
    pts = [(t, c) for t, c in zip(ts, closes) if c is not None]
    price = meta.get("regularMarketPrice") or (pts[-1][1] if pts else None)
    if price is None or len(pts) < 2:
        return None
    t_last = meta.get("regularMarketTime") or pts[-1][0]
    # 盤中 Yahoo 常把「今天」的 close 留空 (null)：
    #   最後一個有效點是今天 → 昨收 = 倒數第二點
    #   最後一個有效點不是今天（今天尚未寫入）→ 昨收 = 最後一點
    day = lambda t: dt.datetime.fromtimestamp(t, TPE).date()  # noqa: E731
    prev = pts[-2][1] if day(pts[-1][0]) == day(t_last) else pts[-1][1]
    return {
        "value": round(price, 4),
        "prev": round(prev, 4),
        "change": round(price - prev, 4),
        "changePct": round((price - prev) / prev * 100, 2) if prev else None,
        "time": dt.datetime.fromtimestamp(t_last, TPE).isoformat(timespec="minutes"),
        "spark": [round(c, 4) for _, c in pts[-60:]],
    }


def yahoo(tx, symbol: str, rng: str = "3mo") -> dict | None:
    sym = urllib.parse.quote(symbol, safe="")
    return parse_yahoo_chart(tx.get_json(f"{YAHOO_CHART}{sym}", {"range": rng, "interval": "1d"}))


MACRO_YAHOO = [
    ("taiex", "加權指數", "^TWII"),
    ("otc", "櫃買指數", "^TWOII"),
    ("usdtwd", "美元/台幣", "TWD=X"),
    ("dxy", "美元指數", "DX-Y.NYB"),
    ("us10y", "美債10年", "^TNX"),
    ("gold", "黃金", "GC=F"),
    ("sox", "費城半導體", "^SOX"),
]


def fetch_macro(tx, report: SourceReport, today: dt.date, use_finmind: bool) -> list[dict]:
    items: list[dict] = []
    for key, label, sym in MACRO_YAHOO:
        res = report.run(f"yahoo_{key}", lambda s=sym: yahoo(tx, s), count=lambda r: 1 if r else 0)
        if res:
            items.append({"key": key, "label": label, "source": "Yahoo", **res})
    if use_finmind:
        # Fed 利率：FinMind InterestRate（Yahoo 沒有）
        rows = report.run("finmind_fed", lambda: finmind(
            tx, "InterestRate", "FED", (today - dt.timedelta(days=900)).isoformat()))
        if rows:
            last = rows[-1]
            prev = next((r for r in reversed(rows) if r.get("interest_rate") != last.get("interest_rate")), None)
            items.append({"key": "fed", "label": "Fed 利率", "source": "FinMind",
                          "value": to_num(last.get("interest_rate")), "time": last.get("date"),
                          "lastChange": prev and {"from": to_num(prev.get("interest_rate")),
                                                  "date": last.get("date")}})
        # Yahoo 匯率失敗時，用台銀即期匯率（FinMind）補
        if not any(i["key"] == "usdtwd" for i in items):
            fx = report.run("finmind_usdtwd", lambda: finmind(
                tx, "TaiwanExchangeRate", "USD", (today - dt.timedelta(days=30)).isoformat()))
            pts = [r for r in fx or [] if to_num(r.get("spot_sell"))]
            if len(pts) >= 2:
                v, p = to_num(pts[-1]["spot_sell"]), to_num(pts[-2]["spot_sell"])
                items.append({"key": "usdtwd", "label": "美元/台幣", "source": "FinMind(台銀)",
                              "value": v, "prev": p, "change": round(v - p, 4),
                              "changePct": round((v - p) / p * 100, 2), "time": pts[-1]["date"]})
    order = {k: i for i, (k, _, _) in enumerate(MACRO_YAHOO)} | {"fed": 99}
    return sorted(items, key=lambda x: order.get(x["key"], 50))


# ──────────────────────────────────────────────────────────────────────
# 輸出
# ──────────────────────────────────────────────────────────────────────
def write_json(path: Path, obj: Any) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    path.write_text(data, "utf-8")
    return len(data.encode("utf-8"))


def assert_no_secret(out_dir: Path, secret: str | None) -> None:
    """
    安全網：輸出完成後掃描所有檔案，確認 token 沒有被意外寫進任何 JSON。
    若發現，刪除整個輸出並以錯誤結束 → 部署步驟不會執行，token 不會上線。
    """
    if not secret:
        return
    for f in out_dir.rglob("*"):
        if f.is_file() and secret in f.read_text("utf-8", errors="ignore"):
            shutil.rmtree(out_dir)
            raise SystemExit("FATAL: FinMind token found in output — aborted, nothing published.")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="_site/data", help="輸出目錄")
    ap.add_argument("--watchlist", default=str(REPO_ROOT / "config" / "watchlist.json"))
    ap.add_argument("--fixtures", help="離線模式：從此資料夾讀 fixture，不連網")
    ap.add_argument("--today", help="覆寫今天日期 YYYY-MM-DD（測試用）")
    args = ap.parse_args(argv)

    token = os.environ.get("FINMIND_TOKEN", "").strip() or None
    tx = FixtureTransport(Path(args.fixtures)) if args.fixtures else HttpTransport(token)
    today = dt.date.fromisoformat(args.today) if args.today else now_tpe().date()
    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    watchlist = json.loads(Path(args.watchlist).read_text("utf-8"))["stocks"]
    spec = load_spec()
    report = SourceReport()
    log(f"start: today={today} watchlist={len(watchlist)} token={'yes' if token else 'no (anonymous quota)'}")

    # 1) 全市場（免 token）— 證交所 OpenAPI 與櫃買 OpenAPI 可平行；T86 走 www 站需節流
    with ThreadPoolExecutor(max_workers=5) as pool:
        f_twq = pool.submit(report.run, "twse_quotes",
                            lambda: parse_twse_quotes(tx.get_json(f"{TWSE_OPENAPI}/exchangeReport/STOCK_DAY_ALL")),
                            lambda r: len(r[0]))
        f_twv = pool.submit(report.run, "twse_valuation",
                            lambda: parse_twse_valuation(tx.get_json(f"{TWSE_OPENAPI}/exchangeReport/BWIBBU_ALL")))
        f_t86 = pool.submit(report.run, "twse_inst", lambda: fetch_t86(tx, today), lambda r: len(r[0]))
        f_tpq = pool.submit(report.run, "tpex_quotes",
                            lambda: parse_tpex_quotes(tx.get_json(f"{TPEX_OPENAPI}/tpex_mainboard_quotes")),
                            lambda r: len(r[0]))
        f_tpv = pool.submit(report.run, "tpex_valuation",
                            lambda: parse_tpex_valuation(tx.get_json(f"{TPEX_OPENAPI}/tpex_mainboard_peratio_analysis")))
        f_tpi = pool.submit(report.run, "tpex_inst",
                            lambda: parse_tpex_inst(tx.get_json(f"{TPEX_OPENAPI}/tpex_3insti_daily_trading")))
        twse_q, twse_date = f_twq.result() or ({}, None)
        twse_v = f_twv.result() or {}
        t86, t86_date = f_t86.result() or ({}, None)
        tpex_q, tpex_date = f_tpq.result() or ({}, None)
        tpex_v = f_tpv.result() or {}
        tpex_i = f_tpi.result() or {}

    market_rows = build_market(twse_q, twse_v, t86) | build_market(tpex_q, tpex_v, tpex_i)
    sizes = {"market.json": write_json(out / "market.json", {
        "asOf": {"twse": twse_date, "tpex": tpex_date, "inst": t86_date},
        "cols": MARKET_COLS, "rows": market_rows})}

    # 2) FinMind：股票清單 → 總經 → 追蹤清單（402 額度用完時停止 FinMind，但照樣輸出其他資料）
    info_rows: list[dict] = []
    quota_hit = False
    try:
        info_rows = report.run("finmind_info", lambda: finmind(tx, "TaiwanStockInfo")) or []
    except QuotaExceeded:
        quota_hit = True
    stock_list = build_stock_list(info_rows, twse_q, tpex_q)
    sizes["stocks.json"] = write_json(out / "stocks.json", {
        "asOf": today.isoformat(), "cols": ["code", "name", "market", "industry"], "rows": stock_list})

    try:
        macro = fetch_macro(tx, report, today, use_finmind=not quota_hit)
    except QuotaExceeded:
        quota_hit, macro = True, []
    sizes["macro.json"] = write_json(out / "macro.json", {"items": macro})

    # 追蹤清單盤中報價（Yahoo）：上市用 .TW、上櫃用 .TWO
    market_of = {r[0]: r[2] for r in stock_list}
    def quote(code: str) -> dict | None:
        suffix = ".TWO" if market_of.get(code) == "tpex" else ".TW"
        return yahoo(tx, code + suffix, "5d")
    with ThreadPoolExecutor(max_workers=4) as pool:
        qres = dict(zip(watchlist, pool.map(lambda c: _safe(lambda: quote(c)), watchlist)))
    quotes = {c: {k: q[k] for k in ("value", "prev", "change", "changePct", "time")} for c, q in qres.items() if q}
    report.items["yahoo_quotes"] = {"ok": bool(quotes), "rows": len(quotes), "ms": 0}
    sizes["quotes.json"] = write_json(out / "quotes.json", {"rows": quotes})

    detail_ok = 0
    if not quota_hit:
        def one(code: str) -> tuple[str, dict | None, str | None]:
            try:
                return code, fetch_stock_detail(tx, code, spec, today), None
            except QuotaExceeded as e:
                return code, None, str(e)
        with ThreadPoolExecutor(max_workers=FINMIND_WORKERS) as pool:
            for code, detail, err in pool.map(one, watchlist):
                if detail:
                    sizes[f"stock/{code}.json"] = write_json(out / "stock" / f"{code}.json", detail)
                    detail_ok += 1 if detail["tables"] else 0
                if err:
                    quota_hit = True
    report.items["finmind_watchlist"] = {"ok": detail_ok == len(watchlist), "rows": detail_ok,
                                         "ms": 0, "note": "FinMind 額度用完 (HTTP 402)" if quota_hit else ""}

    # 3) 共用規格 + meta
    shutil.copy(REPO_ROOT / "assets" / "datasets.json", out / "datasets.json")
    meta = {
        "schema": 1,
        "generatedAt": now_tpe().isoformat(timespec="seconds"),
        "today": today.isoformat(),
        "tokenUsed": bool(token),          # 只記錄「有沒有用 token」，不記錄 token 本身
        "demo": bool(args.fixtures),       # 離線假資料 → 網頁顯示「示範資料」橫幅
        "watchlist": watchlist,
        "finmindRequests": tx.finmind_requests,
        "sources": report.items,
        "bytes": sizes,
    }
    write_json(out / "meta.json", meta)
    assert_no_secret(out, token)

    ok = sum(1 for s in report.items.values() if s["ok"])
    log(f"done: {ok}/{len(report.items)} sources ok, FinMind requests={tx.finmind_requests}, "
        f"output={sum(sizes.values()) / 1024:.0f} KB")
    # 只要有「全市場行情」或「追蹤清單」任一可用，就視為成功並部署；兩者全失敗才回傳錯誤碼
    return 0 if (market_rows or detail_ok) else 1


def _safe(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return None


if __name__ == "__main__":
    sys.exit(main())
