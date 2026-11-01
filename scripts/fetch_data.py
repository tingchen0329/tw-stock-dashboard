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
import csv
import datetime as dt
import http.client
import io
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import us_data  # noqa: E402  美股（Yahoo + SEC EDGAR）

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
# 期交所行情網站（mis.taifex.com.tw）的報價 API：網站本身用的 JSON 介面，夜盤進行中也有盤中價。
# 非正式公開 API，格式可能改變 → 解析失敗時改用 FinMind 已收盤的夜盤資料
TAIFEX_QUOTES = "https://mis.taifex.com.tw/futures/api/getQuoteList"
TAIFEX_NIGHT_BODY = {"MarketType": "1", "SymbolType": "F", "KindID": "1", "CID": "TXF", "ExpireMonth": "",
                     "RowSize": "全部", "PageNo": "", "SortColumn": "", "AscDesc": "A"}   # MarketType 1 = 盤後（夜盤）

HTTP_TIMEOUT = 25           # 秒；GitHub runner 連台灣站台偶爾較慢
FINMIND_WORKERS = 4         # FinMind 同時連線數。太高會被限流，4 是保守值
TWSE_GAP_SEC = 1.2          # 證交所 www 站有防爬（短時間大量請求會封 IP），每次請求間隔
USER_AGENT = "tw-stock-dashboard/6 (+https://github.com/tingchen0329/tw-stock-dashboard)"
# SEC EDGAR 規定 User-Agent 要有聯絡方式（https://www.sec.gov/os/accessing-edgar-data）
# 可用環境變數覆寫（GitHub → Settings → Secrets and variables → Actions → Variables → SEC_USER_AGENT）
# SEC 會拒絕看起來不像真實聯絡方式的 User-Agent（HTTP 403），建議填「名稱 + 你的 email」
SEC_USER_AGENT = os.environ.get("SEC_USER_AGENT", "").strip() or "tw-stock-dashboard tingchen0329@users.noreply.github.com"


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


def positive(v: float | None) -> float | None:
    """本益比 / 股價淨值比：虧損公司官方填 0，0 倍沒有意義 → 當作缺資料（網頁顯示 N/A）"""
    return v if v is not None and v > 0 else None


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

    def _get(self, url: str, headers: dict | None = None, retries: int = 2, data: bytes | None = None) -> bytes:
        """GET（或帶 data 時 POST），在 429 / 5xx / 網路錯誤時指數退避重試。402 直接拋出 QuotaExceeded。"""
        hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json,text/csv,*/*"}
        hdrs.update(headers or {})
        last_err: Exception | None = None
        for attempt in range(retries + 1):
            try:
                req = urllib.request.Request(url, headers=hdrs, data=data)
                with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                    return resp.read()
            except urllib.error.HTTPError as e:
                if e.code == 402:
                    raise QuotaExceeded("FinMind quota exceeded (HTTP 402)") from None
                last_err = e
                if e.code not in (429, 500, 502, 503, 504):
                    break
            # http.client.HTTPException 涵蓋 IncompleteRead：伺服器回應到一半斷線
            # （實例 2026-10-20：櫃買法人資料 840 KB 只收到 589 KB）→ 一樣重試
            except (urllib.error.URLError, http.client.HTTPException, TimeoutError, ConnectionError) as e:
                last_err = e
            time.sleep(1.5 * (2 ** attempt))
        # 錯誤訊息只含 URL 路徑，不含 header（header 裡才有 token）
        raise RuntimeError(f"{'POST' if data else 'GET'} failed: {urllib.parse.urlsplit(url).path} ({last_err})")

    def get_json(self, url: str, params: dict | None = None, kind: str = "public") -> Any:
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        headers = {}
        if kind == "finmind":
            self.finmind_requests += 1
            if self._token:
                headers["Authorization"] = f"Bearer {self._token}"
        elif kind == "sec":
            headers["User-Agent"] = SEC_USER_AGENT
        elif kind == "twse_www":
            # 證交所 www 站限流：同一時間只允許一個請求，且與上次間隔 TWSE_GAP_SEC
            with self._twse_lock:
                wait = TWSE_GAP_SEC - (time.monotonic() - self._twse_last)
                if wait > 0:
                    time.sleep(wait)
                self._twse_last = time.monotonic()
        return json.loads(self._get(url, headers).decode("utf-8-sig"))

    def post_json(self, url: str, body: dict) -> Any:
        """POST JSON（期交所行情 API 用）。Origin / Referer 比照期交所網站本身送出的請求"""
        origin = "{0.scheme}://{0.netloc}".format(urllib.parse.urlsplit(url))
        headers = {"Content-Type": "application/json;charset=UTF-8", "Origin": origin, "Referer": origin + "/futures/"}
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        return json.loads(self._get(url, headers, data=data).decode("utf-8-sig"))


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

    def post_json(self, url: str, body: dict) -> Any:
        f = self.dir / f"taifex_quotes_{body.get('MarketType', '')}.json"
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
                "pe": positive(to_num(pick(r, "PEratio", "本益比"))),
                "pb": positive(to_num(pick(r, "PBratio", "股價淨值比"))),
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
                "pe": positive(to_num(pick(r, "PriceEarningRatio", "PEratio", "本益比"))),
                "pb": positive(to_num(pick(r, "PriceBookRatio", "PBratio", "股價淨值比"))),
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
# 個股 / ETF 代號：4–6 碼數字，可帶一個英文字母（00679B 債券 ETF、00981A 主動式 ETF）。
# FinMind TaiwanStockInfo 另含 "Electronic"（電子類指數）等類股指數，搜尋時不需要
STOCK_CODE = re.compile(r"\d{4,6}[A-Z]?")


def build_stock_list(info_rows: list[dict], twse_q: dict, tpex_q: dict) -> list[list[str]]:
    """
    搜尋用全市場清單：[[代號, 名稱, 市場, 產業], ...]
    主要來源 FinMind TaiwanStockInfo（含產業別）；同一檔可能有多筆產業 → 只留第一筆。
    FinMind 失敗時，用證交所 / 櫃買行情的名稱補（沒有產業別）。

    市場別以「今天出現在哪個交易所的行情」為準：FinMind 的 type 可能停留在舊分類
    （實例：7610 聯友金屬已在上市創新板交易，FinMind 仍標「興櫃」）。
    """
    seen: dict[str, list[str]] = {}
    for r in info_rows:
        code = str(r.get("stock_id", "")).strip()
        name = str(r.get("stock_name", "")).strip()
        market = MARKET_CODE.get(str(r.get("type", "")).lower())
        if not STOCK_CODE.fullmatch(code) or not name or not market or code in seen:
            continue
        if code in twse_q:
            market = "twse"
        elif code in tpex_q:
            market = "tpex"
        seen[code] = [code, name, market, str(r.get("industry_category", "")).strip()]
    for quotes, market in ((twse_q, "twse"), (tpex_q, "tpex")):
        for code, q in quotes.items():
            if code not in seen and q.get("name"):
                seen[code] = [code, str(q["name"]).strip(), market, ""]
    return sorted(seen.values(), key=lambda r: r[0])


# CSV 中「像股票代號」的儲存格：2330、00919、2330.TW、5347.TWO
CSV_CODE = re.compile(r"(\d{4,6}[A-Z]?)(?:\.TWO?)?")


def load_watchlist(path: Path) -> list[str]:
    """
    追蹤清單：CSV（Yahoo 自選股匯出或自製清單）或 JSON {"stocks": [...]}。
    CSV 取標題含「代號 / Symbol / Code」的欄位；沒有標題就取每列第一個像代號的儲存格。
    保留原本順序（= 網頁上的顯示順序），去除重複與無效代號。
    """
    text = path.read_text("utf-8-sig")                  # utf-8-sig：Excel 存的 CSV 開頭有 BOM
    if path.suffix.lower() == ".json":
        raw = json.loads(text)["stocks"]
    else:
        rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
        head = [c.strip().lower() for c in rows[0]] if rows else []
        col = next((i for i, c in enumerate(head) if any(k in c for k in ("代號", "symbol", "code", "ticker"))), None)
        raw = []
        for r in rows[1:] if col is not None else rows:
            cells = [r[col]] if col is not None and col < len(r) else r
            m = next((CSV_CODE.fullmatch(c.strip().upper()) for c in cells if CSV_CODE.fullmatch(c.strip().upper())), None)
            if m:
                raw.append(m.group(1))
    out: list[str] = []
    for c in (str(x).strip().upper() for x in raw):
        if STOCK_CODE.fullmatch(c) and c not in out:
            out.append(c)
    return out


def is_etf(code: str) -> bool:
    """台股 ETF 代號一律 00 開頭（0050、00878、00679B）"""
    return code.startswith("00")


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
        if s.get("skipEtf") and is_etf(code):             # ETF 沒有本益比、月營收、財報：不浪費請求
            continue
        start = (today - dt.timedelta(days=int(s["days"]))).isoformat()
        try:
            tables[key] = to_table(finmind(tx, s["dataset"], code, start), s)
        except QuotaExceeded:
            raise
        except Exception as e:  # noqa: BLE001
            errors[key] = str(e)[:160]
    return {"code": code, "fetchedAt": now_tpe().isoformat(timespec="seconds"),
            "tables": tables, "errors": errors}


def fetch_details(tx, codes: list[str], spec: dict, today: dt.date, out: Path) -> tuple[int, bool]:
    """
    抓 codes 的個股資料寫到 out/stock/<代號>.json。回傳 (成功檔數, 是否遇到 FinMind 額度用完)。
    新資料全部失敗、而上一份檔案還在時，保留上一份（寧可舊一點，也不要整頁空白）。
    """
    def one(code: str) -> tuple[str, dict | None, bool]:
        try:
            return code, fetch_stock_detail(tx, code, spec, today), False
        except QuotaExceeded:
            return code, None, True
    fetched, quota = 0, False
    with ThreadPoolExecutor(max_workers=FINMIND_WORKERS) as pool:
        for code, detail, hit in pool.map(one, codes):
            f = out / "stock" / f"{code}.json"
            if detail and (detail["tables"] or not f.exists()):
                write_json(f, detail)
                fetched += 1 if detail["tables"] else 0
            quota |= hit
    return fetched, quota


def stock_files(out: Path, watchlist: list[str]) -> dict[str, int]:
    """移除已不在清單上的個股檔，回傳 {相對路徑: 位元組}（寫進 meta.bytes，下次可據此取回）"""
    d = out / "stock"
    for f in d.glob("*.json") if d.exists() else []:
        if f.stem not in watchlist:
            f.unlink()
    return {f"stock/{c}.json": (d / f"{c}.json").stat().st_size for c in watchlist if (d / f"{c}.json").exists()}


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
    # 櫃買指數：Yahoo 的 ^TWOII 已回 404（2026-10），改由 FinMind TaiwanStockPrice data_id=TPEx 提供
    ("usdtwd", "美元/台幣", "TWD=X"),
    ("dxy", "美元指數", "DX-Y.NYB"),
    ("us10y", "美債10年", "^TNX"),
    ("gold", "黃金", "GC=F"),
    ("sox", "費城半導體", "^SOX"),
    ("dji", "道瓊工業", "^DJI"),
    ("ixic", "那斯達克", "^IXIC"),
]


# FinMind 的台股指數（TaiwanStockPrice 的 data_id）：只有日收盤，沒有盤中
FINMIND_INDEX = {"taiex": ("加權指數", "TAIEX"), "otc": ("櫃買指數", "TPEx")}
# 顯示順序：台股 → 美股 → 匯率 / 利率 / 商品
MACRO_ORDER = ["taiex", "otc", "txf_night", "dji", "ixic", "sox", "usdtwd", "dxy", "us10y", "gold", "fed"]


def finmind_index(tx, data_id: str, today: dt.date) -> dict | None:
    """FinMind 日線 → 與 parse_yahoo_chart 相同的格式（value/prev/change/changePct/time/spark）"""
    rows = finmind(tx, "TaiwanStockPrice", data_id, (today - dt.timedelta(days=120)).isoformat())
    pts = [(r["date"], to_num(r.get("close"))) for r in rows if to_num(r.get("close"))]
    if len(pts) < 2:
        return None
    v, p = pts[-1][1], pts[-2][1]
    return {"value": v, "prev": p, "change": round(v - p, 4), "changePct": round((v - p) / p * 100, 2),
            "time": pts[-1][0], "spark": [c for _, c in pts[-60:]]}


def parse_taifex_quotes(payload: dict, now: dt.datetime) -> dict | None:
    """
    期交所行情 → 台指期近月。
    QuoteList 會有多個到期月份與價差組合（SymbolID / 名稱含 "/"），
    取「成交量最大的單一月份」當近月（台指期的流動性幾乎都集中在近月）。
    CRefPrice = 參考價（夜盤為當天日盤的結算價），漲跌以它為基準。
    """
    try:
        quotes = payload["RtData"]["QuoteList"]
    except (KeyError, TypeError):
        return None
    best = None
    for q in quotes or []:
        sym, name = str(q.get("SymbolID") or ""), str(q.get("DispCName") or "")
        if "/" in sym or "/" in name or (sym and not sym.upper().startswith("TXF")):
            continue
        last, ref = to_num(q.get("CLastPrice")), to_num(q.get("CRefPrice"))
        if not last or not ref:
            continue
        vol = to_num(q.get("CTotalVolume")) or 0
        if best is None or vol > best[0]:
            best = (vol, q, last, ref, name or sym)
    if not best:
        return None
    vol, q, last, ref, contract = best
    # CTime 是 HHMMSS（台北時間）。日期用抓取當天；若算出來比現在還晚（跨午夜），往前一天
    when = now
    t = re.sub(r"\D", "", str(q.get("CTime") or ""))
    if len(t) >= 4:
        when = now.replace(hour=int(t[:2]) % 24, minute=int(t[2:4]), second=0, microsecond=0)
        if when > now + dt.timedelta(minutes=10):
            when -= dt.timedelta(days=1)
    return {"value": last, "prev": ref, "change": round(last - ref, 4),
            "changePct": round((last - ref) / ref * 100, 2), "time": when.isoformat(timespec="minutes"),
            "contract": contract, "volume": vol}


def finmind_txf_night(tx, today: dt.date) -> dict | None:
    """備援：FinMind TaiwanFuturesDaily 的 after_market（夜盤）收盤。每天 16:30 才更新 → 只有「已收盤」的夜盤"""
    rows = finmind(tx, "TaiwanFuturesDaily", "TX", (today - dt.timedelta(days=14)).isoformat())
    night = [r for r in rows if r.get("trading_session") == "after_market"
             and "/" not in str(r.get("contract_date", "")) and to_num(r.get("close"))]
    if not night:
        return None
    latest = max(r["date"] for r in night)
    best = max((r for r in night if r["date"] == latest), key=lambda r: to_num(r.get("volume")) or 0)
    close, spread = to_num(best["close"]), to_num(best.get("spread"))
    prev = close - spread if spread is not None else None
    return {"value": close, "prev": prev, "change": spread,
            "changePct": round(spread / prev * 100, 2) if spread is not None and prev else None,
            "time": latest, "contract": str(best.get("contract_date", ""))}


def fetch_macro(tx, report: SourceReport, today: dt.date, use_finmind: bool) -> list[dict]:
    items: list[dict] = []
    for key, label, sym in MACRO_YAHOO:
        res = report.run(f"yahoo_{key}", lambda s=sym: yahoo(tx, s), count=lambda r: 1 if r else 0)
        if res:
            items.append({"key": key, "label": label, "source": "Yahoo", **res})
    # 台指期夜盤：期交所即時行情優先（夜盤進行中有盤中價）；失敗時用 FinMind 已收盤的夜盤
    now = clock(today)
    night = report.run("taifex_night", lambda: parse_taifex_quotes(tx.post_json(TAIFEX_QUOTES, TAIFEX_NIGHT_BODY), now),
                       count=lambda r: 1 if r else 0)
    if night:
        items.append({"key": "txf_night", "label": "台指期夜盤", "source": f"期交所（{night['contract']}）", **night})
    elif use_finmind:
        fb = report.run("finmind_txf_night", lambda: finmind_txf_night(tx, today), count=lambda r: 1 if r else 0)
        if fb:
            items.append({"key": "txf_night", "label": "台指期夜盤", "source": "FinMind（夜盤收盤）", **fb})
            report.items["taifex_night"]["note"] = (report.items["taifex_night"].get("note", "") +
                                                    "；已改用 FinMind 的夜盤收盤").lstrip("；")
    if use_finmind:
        # 台股指數：櫃買一律用 FinMind；加權在 Yahoo 失敗時才用 FinMind 補
        for key, (label, data_id) in FINMIND_INDEX.items():
            if any(i["key"] == key for i in items):
                continue
            res = report.run(f"finmind_{key}", lambda d=data_id: finmind_index(tx, d, today),
                             count=lambda r: 1 if r else 0)
            if res:
                items.append({"key": key, "label": label, "source": "FinMind（日收盤）", **res})
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
    return sorted(items, key=lambda x: MACRO_ORDER.index(x["key"]) if x["key"] in MACRO_ORDER else 50)


# ──────────────────────────────────────────────────────────────────────
# 全市場選股（screen.json）：只用證交所 / 櫃買開放資料，不花 FinMind 額度
#   月營收：上市 t187ap05_L、上櫃 mopsfin_t187ap05_O（每月一次，全部公司一個檔案）
#   損益表：上市 t187ap06_L_*、上櫃 mopsfin_t187ap06_O_*（最新一季累計；一般業 / 金融 / 證券 / 金控 / 保險 / 異業）
#   本益比、股價淨值比、殖利率、成交量、法人：沿用 market.json
# 篩選條件在網頁端（assets/js/screen.js），這裡只整理資料。
# ──────────────────────────────────────────────────────────────────────
INCOME_KINDS = ["ci", "basi", "bd", "fh", "ins", "mim"]
SCREEN_COLS = ["code", "name", "market", "industry", "close", "chgPct", "volume", "pe", "pb", "yield", "roe",
               "revYm", "revYoY", "revMoM", "revCumYoY", "epsPeriod", "eps", "gm", "om", "foreign", "trust"]


def _code(r: dict) -> str:
    return str(pick(r, "公司代號", "SecuritiesCompanyCode", "CompanyCode", "Code") or "").strip()


def parse_revenue(rows: list[dict]) -> dict[str, dict]:
    """月營收彙總表 → {代號: {ym, yoy, mom, cumYoy}}。資料年月 11509 → 2026-09"""
    out = {}
    for r in rows or []:
        code, ym = _code(r), str(pick(r, "資料年月", "YearMonth") or "").strip()
        if not code or not re.fullmatch(r"\d{4,5}", ym):
            continue
        out[code] = {"ym": f"{int(ym[:-2]) + 1911}-{ym[-2:]}",
                     "yoy": to_num(pick(r, "營業收入-去年同月增減(%)")),
                     "mom": to_num(pick(r, "營業收入-上月比較增減(%)")),
                     "cumYoy": to_num(pick(r, "累計營業收入-前期比較增減(%)"))}
    return out


def parse_income(rows: list[dict]) -> dict[str, dict]:
    """綜合損益表（最新一季累計）→ {代號: {period, eps, gm, om}}。金融業沒有毛利 → None"""
    out = {}
    for r in rows or []:
        code = _code(r)
        y, q = str(pick(r, "年度", "Year") or "").strip(), str(pick(r, "季別", "Season", "Quarter") or "").strip()
        eps = to_num(pick(r, "基本每股盈餘（元）", "基本每股盈餘(元)", "基本每股盈餘"))
        if not code or eps is None or not y.isdigit() or not q.isdigit():
            continue
        rev = to_num(pick(r, "營業收入", "收益合計", "淨收益"))
        gp = to_num(pick(r, "營業毛利（毛損）淨額", "營業毛利（毛損）"))
        op = to_num(pick(r, "營業利益（損失）"))
        pct = lambda v: round(v / rev * 100, 2) if v is not None and rev else None  # noqa: E731
        out[code] = {"period": f"{int(y) + 1911}Q{q}", "eps": eps, "gm": pct(gp), "om": pct(op)}
    return out


def _fetch_parts(tx, report: SourceReport, name: str, urls: list[str], parser) -> dict[str, dict]:
    """多個端點合併成一個資料源；部分失敗只記在備註。解析出 0 筆時把欄位名稱寫進備註（方便發現改版）"""
    merged, failed, keys = {}, [], None
    def fetch_all():
        nonlocal keys
        for url in urls:
            try:
                rows = tx.get_json(url)
            except Exception as e:  # noqa: BLE001
                failed.append(f"{url.rsplit('/', 1)[-1]}: {str(e)[:60]}")
                continue
            got = parser(rows)
            if not got and rows and isinstance(rows, list) and isinstance(rows[0], dict):
                keys = list(rows[0])[:8]
            merged.update(got)
        return merged
    report.run(name, fetch_all)
    notes = [f"失敗 {len(failed)}/{len(urls)}：" + "；".join(failed[:3])] if failed else []
    if keys and not merged:
        notes.append(f"欄位不符：{keys}")
    if notes:
        report.items[name]["note"] = "；".join(notes)
    return merged


def previous_screen(path: Path) -> tuple[dict[str, dict], dict[str, dict]]:
    """
    上一份 screen.json 的月營收與財報。新一季財報公布期間（例如 11 月中前），開放資料只剩「已公布」的公司，
    沒公布的沿用上一季，避免 EPS 一夕之間變成 N/A。
    """
    try:
        sc = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}, {}
    rev, inc = {}, {}
    for r in sc.get("rows", []):
        x = dict(zip(sc.get("cols", []), r))
        if x.get("revYm"):
            rev[x["code"]] = {"ym": x["revYm"], "yoy": x.get("revYoY"), "mom": x.get("revMoM"), "cumYoy": x.get("revCumYoY")}
        if x.get("epsPeriod"):
            inc[x["code"]] = {"period": x["epsPeriod"], "eps": x.get("eps"), "gm": x.get("gm"), "om": x.get("om")}
    return rev, inc


def build_screen(tx, report: SourceReport, market_rows: dict, stock_list: list[list[str]], asof: dict,
                 prev_path: Path | None = None) -> dict:
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = {
            "twse_revenue": ([f"{TWSE_OPENAPI}/opendata/t187ap05_L"], parse_revenue),
            "tpex_revenue": ([f"{TPEX_OPENAPI}/mopsfin_t187ap05_O"], parse_revenue),
            "twse_income": ([f"{TWSE_OPENAPI}/opendata/t187ap06_L_{k}" for k in INCOME_KINDS], parse_income),
            "tpex_income": ([f"{TPEX_OPENAPI}/mopsfin_t187ap06_O_{k}" for k in INCOME_KINDS], parse_income),
        }
        futs = {k: pool.submit(_fetch_parts, tx, report, k, urls, fn) for k, (urls, fn) in jobs.items()}
        rev = futs["twse_revenue"].result() | futs["tpex_revenue"].result()
        inc = futs["twse_income"].result() | futs["tpex_income"].result()
    old_rev, old_inc = previous_screen(prev_path) if prev_path else ({}, {})
    rev = old_rev | rev                     # 新資料優先；新一期還沒公布的公司沿用上一期
    inc = old_inc | inc
    col = {c: i for i, c in enumerate(MARKET_COLS)}
    rows = []
    for code, name, market, industry in stock_list:
        m = market_rows.get(code)
        # 個股才列入：4 碼、非 ETF（00 開頭）、今天有成交資料
        if m is None or market not in ("twse", "tpex") or not re.fullmatch(r"[1-9]\d{3}", code):
            continue
        g = lambda k: m[col[k]]  # noqa: E731
        close, chg, pe, pb = g("close"), g("change"), g("pe"), g("pb")
        prev_close = close - chg if close is not None and chg is not None else None
        lots = lambda v: round(v / 1000) if v is not None else None  # noqa: E731
        r, i = rev.get(code, {}), inc.get(code, {})
        rows.append([
            code, name, market, industry, close,
            round(chg / prev_close * 100, 2) if prev_close else None,
            lots(g("volume")), pe, pb, g("yield"),
            round(pb / pe * 100, 2) if pe and pb else None,          # ROE 推估 = 股價淨值比 ÷ 本益比
            r.get("ym"), r.get("yoy"), r.get("mom"), r.get("cumYoy"),
            i.get("period"), i.get("eps"), i.get("gm"), i.get("om"),
            lots(g("foreign")), lots(g("trust")),
        ])
    periods = sorted({x[15] for x in rows if x[15]})
    months = sorted({x[11] for x in rows if x[11]})
    span = lambda v: None if not v else v[-1] if len(v) == 1 else f"{v[0]}～{v[-1]}"  # noqa: E731
    return {"asOf": {**asof, "revenue": span(months), "income": span(periods)},
            "cols": SCREEN_COLS, "rows": rows}


# ──────────────────────────────────────────────────────────────────────
# 開休市狀態：給網頁顯示「今日休市，顯示 X 日收盤；下次開盤 Y 日」
#   排定休市：證交所 OpenAPI holidaySchedule（國定假日、補假、春節結算日）
#   臨時休市：颱風等當天才宣布 → 收盤後證交所與加權指數都還停在前一天 → 判定今天沒開盤
# 實際「現在是否休市」由網頁依瀏覽當下的時間計算（見 assets/js/market.js），這裡只提供日期資料
# ──────────────────────────────────────────────────────────────────────
def parse_holidays(rows: list[dict]) -> list[dict]:
    """
    證交所休市日 → [{date, name}]。
    清單中也有「國曆新年開始交易日」「農曆春節前最後交易日」這類「有開盤」的日子，必須排除。
    """
    out = []
    for r in rows or []:
        d = roc_to_iso(pick(r, "Date", "日期"))
        name = str(pick(r, "Name", "名稱") or "").strip()
        text = name + str(pick(r, "Description", "說明") or "")
        if not d or not name or "開始交易" in text or "最後交易" in text:
            continue
        out.append({"date": d, "name": name})
    return sorted(out, key=lambda x: x["date"])


def detect_closures(today: dt.date, now: dt.datetime, last_trading_day: str | None,
                    taiex_day: str | None, holidays: list[dict]) -> list[str]:
    """
    臨時休市（颱風等）不在排定休市表裡，只能從資料推斷：
    證交所收盤資料與加權指數「都」停在 X 日 → X 日之後到今天的平日、非排定休市日就是沒開盤。
    今天要等 15:00 後才判斷（證交所 OpenAPI 收盤資料偶爾 14 點多才更新，避免誤判）。
    """
    if not last_trading_day or not taiex_day:
        return []
    off = {h["date"] for h in holidays}
    d = dt.date.fromisoformat(max(last_trading_day, taiex_day)) + dt.timedelta(days=1)
    out = []
    while d <= today and len(out) < 10:
        if d.weekday() < 5 and d.isoformat() not in off and (d < today or now.time() >= dt.time(15, 0)):
            out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


def market_block(tx, report: SourceReport, today: dt.date, now: dt.datetime,
                 last_trading_day: str | None, macro: list[dict], prev: dict | None = None) -> dict:
    """prev：上一份 meta 的 market 區塊；休市表這次抓失敗時沿用（夜間模式用）"""
    hol = report.run("twse_holidays", lambda: parse_holidays(
        tx.get_json(f"{TWSE_OPENAPI}/holidaySchedule/holidaySchedule")))
    if hol is None and prev and prev.get("holidaysOk"):
        hol = prev.get("holidays", [])
    lo, hi = (today - dt.timedelta(days=14)).isoformat(), (today + dt.timedelta(days=120)).isoformat()
    taiex = next((m for m in macro if m["key"] == "taiex"), None)
    return {"lastTradingDay": last_trading_day,
            "holidays": [h for h in hol or [] if lo <= h["date"] <= hi],
            "holidaysOk": hol is not None,               # 休市表抓失敗時，網頁不把推斷出的休市標成「臨時」
            "closures": detect_closures(today, now, last_trading_day,
                                        ((taiex or {}).get("time") or "")[:10] or None, hol or [])}


FULL_CUTOFFS = (dt.time(19, 30), dt.time(16, 15))   # 收盤後兩次完整更新：法人（16:15 後）、融資券與較晚的資料（19:30 後）


def decide_mode(now: dt.datetime, prev: dict) -> str:
    """
    smart 模式：依「現在時間」與「上次完整更新時間」決定這次做什麼，跟是哪個排程觸發的無關。
    外部排程或 GitHub 排程延遲、重複觸發都不會浪費 FinMind 額度。
      交易日 16:15 / 19:30 之後，且上次完整更新早於該時間 → full
      上次完整更新超過 3 天（漏跑）→ full
      21:00–08:30 → macro；其他 → auto
    """
    day, t = now.date(), now.time()
    mk = prev.get("market") or {}
    off = {h["date"] for h in mk.get("holidays", [])} | set(mk.get("closures", []))
    trading = day.weekday() < 5 and day.isoformat() not in off
    full_at = dt.datetime.fromisoformat(prev["fullAt"]) if prev.get("fullAt") else None
    if full_at is None or now - full_at > dt.timedelta(days=3):
        return "full"
    if trading:
        cutoff = next((c for c in FULL_CUTOFFS if t >= c), None)
        if cutoff and full_at < dt.datetime.combine(day, cutoff, tzinfo=TPE):
            return "full"
    return "macro" if t >= dt.time(21, 0) or t < dt.time(8, 30) else "auto"


def clock(today: dt.date) -> dt.datetime:
    """現在時間；測試指定 --today 時固定為該日 22:00（讓結果可重現）"""
    return now_tpe() if today == now_tpe().date() else dt.datetime.combine(today, dt.time(22, 0), tzinfo=TPE)


# ──────────────────────────────────────────────────────────────────────
# 增量更新：從已部署的網站取回上一份資料，只重抓需要的部分（見 main 的 --mode）
# ──────────────────────────────────────────────────────────────────────
def restore_previous(base_url: str, out: Path) -> dict | None:
    """下載目前線上的完整資料到 out。任何一個檔案失敗就回傳 None（呼叫端改從頭抓）"""
    stamp = int(time.time())
    def get(rel: str) -> bytes:
        # ?cb= 讓 GitHub Pages 的 CDN 快取（約 10 分鐘）失效，確保拿到同一版的檔案
        req = urllib.request.Request(f"{base_url.rstrip('/')}/data/{rel}?cb={stamp}",
                                     headers={"User-Agent": USER_AGENT, "Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
            return resp.read()
    try:
        meta = json.loads(get("meta.json"))
        if meta.get("schema") != 1 or not isinstance(meta.get("bytes"), dict):
            return None
        for rel in set(meta["bytes"]) | {"datasets.json"}:
            raw = get(rel)
            json.loads(raw)                                  # 確認是完整的 JSON，不是被截斷的檔案
            (out / rel).parent.mkdir(parents=True, exist_ok=True)
            (out / rel).write_bytes(raw)
        return meta
    except Exception as e:  # noqa: BLE001
        log(f"無法取回網站上的上一份資料（{str(e)[:120]}）→ 從頭抓取")
        return None


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
    ap.add_argument("--watchlist", default=str(REPO_ROOT / "config" / "watchlist.csv"),
                    help="追蹤清單 CSV（Yahoo 自選股匯出）或 JSON")
    ap.add_argument("--us-watchlist", default=str(REPO_ROOT / "config" / "us_watchlist.csv"), help="美股追蹤清單 CSV")
    ap.add_argument("--fixtures", help="離線模式：從此資料夾讀 fixture，不連網")
    ap.add_argument("--today", help="覆寫今天日期 YYYY-MM-DD（測試用）")
    ap.add_argument("--mode", choices=["full", "auto", "macro", "smart"], default="full", help=(
        "full：個股資料全部重抓（收盤後）｜auto：個股只抓新加入的，其餘沿用網站上的版本，行情與總經照常更新｜"
        "macro：只更新總經｜smart：依時間與上次完整更新自動選擇（排程用）。"
        "auto / macro / smart 需要 --base-url，取不到網站資料時自動改成 full"))
    ap.add_argument("--macro-only", action="store_true", help="同 --mode macro")
    ap.add_argument("--base-url", help="已部署網站的網址，例如 https://<帳號>.github.io/<repo>/。"
                                       "full 模式也建議提供：額度用完時，沒抓到的個股沿用網站上的版本")
    args = ap.parse_args(argv)
    mode = "macro" if args.macro_only else args.mode

    token = os.environ.get("FINMIND_TOKEN", "").strip() or None
    tx = FixtureTransport(Path(args.fixtures)) if args.fixtures else HttpTransport(token)
    today = dt.date.fromisoformat(args.today) if args.today else now_tpe().date()
    out = Path(args.out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    watchlist = load_watchlist(Path(args.watchlist))
    us_watchlist = us_data.load_us_watchlist(Path(args.us_watchlist))
    spec = load_spec()
    prev = restore_previous(args.base_url, out) if args.base_url else None
    if prev is None:
        shutil.rmtree(out)                                   # 清掉可能下載到一半的檔案
        out.mkdir(parents=True)
        mode = "full"
    elif mode == "smart":
        mode = decide_mode(clock(today), prev)
        log(f"smart → {mode}（上次完整更新 {prev.get('fullAt')}）")
    if mode == "macro":
        return run_macro_only(tx, out, prev, today, token, watchlist, spec, us_watchlist)

    report = SourceReport()
    log(f"start: mode={mode} today={today} watchlist={len(watchlist)} "
        f"token={'yes' if token else 'no (anonymous quota)'}")

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

    # 個股：full 全部重抓；auto 只抓網站上還沒有的（新加入清單、或上次額度用完沒抓到的）
    stock_dir = out / "stock"
    todo = watchlist if mode == "full" else [c for c in watchlist if not (stock_dir / f"{c}.json").exists()]
    fetched = 0
    if todo and not quota_hit:
        fetched, quota_hit = fetch_details(tx, todo, spec, today, out)
    files = stock_files(out, watchlist)
    sizes.update(files)
    detail_ok = len(files)
    report.items["finmind_watchlist"] = {
        "ok": detail_ok == len(watchlist), "rows": detail_ok, "ms": 0,
        "note": "；".join(x for x in (
            f"本次更新 {fetched} 檔，沿用上一份 {detail_ok - fetched} 檔" if mode != "full" or detail_ok > fetched else "",
            f"缺 {len(watchlist) - detail_ok} 檔" if detail_ok < len(watchlist) else "",
            "FinMind 額度用完 (HTTP 402)，下次執行會補抓" if quota_hit else "") if x)}

    # 全市場選股資料（證交所 / 櫃買開放資料，免 FinMind）
    screen = build_screen(tx, report, market_rows, stock_list,
                          {"twse": twse_date, "tpex": tpex_date, "inst": t86_date}, out / "screen.json")
    sizes["screen.json"] = write_json(out / "screen.json", screen)

    # 美股：股價每次更新，SEC 財報只在 full 時重抓
    sizes.update(us_data.fetch_us(tx, report, out, us_watchlist, mode == "full", write_json,
                                  now_tpe().isoformat(timespec="seconds"), SEC_USER_AGENT))

    # 3) 共用規格 + meta
    shutil.copy(REPO_ROOT / "assets" / "datasets.json", out / "datasets.json")
    meta = {
        "schema": 1,
        "generatedAt": now_tpe().isoformat(timespec="seconds"),
        "today": today.isoformat(),
        "tokenUsed": bool(token),          # 只記錄「有沒有用 token」，不記錄 token 本身
        "demo": bool(args.fixtures),       # 離線假資料 → 網頁顯示「示範資料」橫幅
        "watchlist": watchlist,
        "usWatchlist": us_watchlist,
        "mode": mode,
        "finmindRequests": tx.finmind_requests,
        "sources": report.items,
        "bytes": sizes,
    }
    meta["market"] = market_block(tx, report, today, clock(today), twse_date or tpex_date, macro)
    meta["macroAt"] = meta["generatedAt"]
    meta["usAt"] = meta["generatedAt"]           # 美股檔案的快取版本（夜間只更新美股與總經時，generatedAt 不變）
    # 上次完整更新時間（smart 模式據此判斷）；額度用完沒抓齊不算完成，下次會再做一次
    meta["fullAt"] = meta["generatedAt"] if mode == "full" and not quota_hit else (prev or {}).get("fullAt")
    write_json(out / "meta.json", meta)
    assert_no_secret(out, token)

    ok = sum(1 for s in report.items.values() if s["ok"])
    log(f"done: {ok}/{len(report.items)} sources ok, FinMind requests={tx.finmind_requests}, "
        f"output={sum(sizes.values()) / 1024:.0f} KB")
    # 只要有「全市場行情」或「追蹤清單」任一可用，就視為成功並部署；兩者全失敗才回傳錯誤碼
    return 0 if (market_rows or detail_ok) else 1


def run_macro_only(tx, out: Path, prev: dict, today: dt.date, token: str | None,
                   watchlist: list[str], spec: dict, us_watchlist: list[str] | None = None) -> int:
    """
    夜間輕量模式：沿用上一份完整資料，只更新 macro.json 與開休市狀態（約 2–4 次 FinMind 請求）。
    順便補抓清單上還沒有資料的個股（上次額度用完時沒抓到的）。
    """
    report = SourceReport()
    try:
        macro = fetch_macro(tx, report, today, use_finmind=True)
    except QuotaExceeded:
        macro = json.loads((out / "macro.json").read_text("utf-8"))["items"]    # 額度用完：保留舊總經
    missing = [c for c in watchlist if not (out / "stock" / f"{c}.json").exists()]
    fetched, quota = fetch_details(tx, missing, spec, today, out) if missing else (0, False)
    sizes = {k: v for k, v in prev["bytes"].items() if not k.startswith(("stock/", "us/stock/"))}
    files = stock_files(out, watchlist)
    sizes.update(files)
    # 美股收盤在台北凌晨（冬令 05:00、夏令 04:00）→ 夜間也更新美股股價
    us_watchlist = us_watchlist or []
    sizes.update(us_data.fetch_us(tx, report, out, us_watchlist, False, write_json,
                                  now_tpe().isoformat(timespec="seconds"), SEC_USER_AGENT))
    report.items["finmind_watchlist"] = {   # 取代上一份的狀態（否則會一直顯示上次的「缺 N 檔」）
        "ok": len(files) == len(watchlist), "rows": len(files), "ms": 0,
        "note": "；".join(x for x in (
            f"補抓 {fetched} 檔" if fetched else "",
            f"缺 {len(watchlist) - len(files)} 檔" if len(files) < len(watchlist) else "",
            "FinMind 額度用完 (HTTP 402)，下次執行會補抓" if quota else "") if x)}
    sizes["macro.json"] = write_json(out / "macro.json", {"items": macro})
    asof = json.loads((out / "market.json").read_text("utf-8")).get("asOf", {})
    market = market_block(tx, report, today, clock(today), asof.get("twse") or asof.get("tpex"), macro,
                          prev.get("market"))
    now = now_tpe().isoformat(timespec="seconds")
    meta = {**prev,
            "macroAt": now,
            # generatedAt 不變（個股資料仍是上一份）；有補抓個股時才更新，讓瀏覽器重新讀取
            "generatedAt": now if fetched else prev["generatedAt"],
            "watchlist": watchlist,
            "usWatchlist": us_watchlist,
            "usAt": now,
            "mode": "macro",
            "sources": {**prev.get("sources", {}), **report.items},
            "macroFinmindRequests": tx.finmind_requests,
            "bytes": sizes,
            "market": market}
    write_json(out / "meta.json", meta)
    assert_no_secret(out, token)
    ok = sum(1 for s in report.items.values() if s["ok"])
    log(f"macro-only done: {ok}/{len(report.items)} macro sources ok, FinMind requests={tx.finmind_requests}")
    return 0


def _safe(fn: Callable[[], Any]) -> Any:
    try:
        return fn()
    except Exception:  # noqa: BLE001
        return None


if __name__ == "__main__":
    sys.exit(main())
