"""
fetch_data.py 單元測試（只用標準函式庫 unittest，不需安裝套件）
執行：python -m unittest discover -s tests/py -v
"""
from __future__ import annotations

import datetime as dt
import functools
import http.server
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import fetch_data as fd  # noqa: E402

WATCH = str(ROOT / "tests/fixtures/watchlist.json")   # 測試用清單（正式清單 config/watchlist.csv 沒有 fixture）

T86_FIELDS = ["證券代號", "證券名稱", "外陸資買進股數(不含外資自營商)", "外陸資賣出股數(不含外資自營商)",
              "外陸資買賣超股數(不含外資自營商)", "外資自營商買進股數", "外資自營商賣出股數", "外資自營商買賣超股數",
              "投信買進股數", "投信賣出股數", "投信買賣超股數", "自營商買賣超股數", "自營商買進股數(自行買賣)",
              "自營商賣出股數(自行買賣)", "自營商買賣超股數(自行買賣)", "自營商買進股數(避險)",
              "自營商賣出股數(避險)", "自營商買賣超股數(避險)", "三大法人買賣超股數"]


def make_fixtures(tmp: Path, *extra: str) -> Path:
    fx = tmp / "fx"
    subprocess.run([sys.executable, str(ROOT / "tests/fixtures/make_fixtures.py"), str(fx), *extra],
                   check=True, capture_output=True)
    return fx


class Parsing(unittest.TestCase):
    def test_to_num_handles_exchange_formats(self):
        self.assertEqual(fd.to_num("1,234.50"), 1234.5)
        self.assertEqual(fd.to_num("+5.00"), 5.0)
        self.assertEqual(fd.to_num("-3"), -3.0)
        self.assertEqual(fd.to_num("X0.00"), 0.0)
        for blank in ("", "--", "---", None, "N/A"):
            self.assertIsNone(fd.to_num(blank))

    def test_roc_to_iso(self):
        self.assertEqual(fd.roc_to_iso("1151019"), "2026-10-19")
        self.assertEqual(fd.roc_to_iso("115/10/19"), "2026-10-19")
        self.assertEqual(fd.roc_to_iso("20261019"), "2026-10-19")
        self.assertEqual(fd.roc_to_iso("2026-10-19"), "2026-10-19")
        self.assertIsNone(fd.roc_to_iso(""))

    def test_t86_dealer_column_is_not_foreign_dealer(self):
        # 外資自營商 = 700、自營商合計 = 50：舊式「包含」比對會把 700 當成自營商
        row = ["2330", "台積電", "0", "0", "1,000", "0", "0", "700", "0", "0", "-200",
               "50", "0", "0", "0", "0", "0", "0", "1,550"]
        out = fd.parse_t86({"stat": "OK", "fields": T86_FIELDS, "data": [row]})
        self.assertEqual(out["2330"], {"foreign": 1700.0, "trust": -200.0, "dealer": 50.0, "inst": 1550.0})

    def test_t86_not_ok_returns_empty(self):
        self.assertEqual(fd.parse_t86({"stat": "很抱歉，沒有符合條件的資料!"}), {})

    def test_twse_valuation_loss_company_pe_is_none(self):
        out = fd.parse_twse_valuation([{"Code": "2409", "PEratio": "", "PBratio": "0.85", "DividendYield": "0.00"}])
        self.assertIsNone(out["2409"]["pe"])
        self.assertEqual(out["2409"]["pb"], 0.85)

    def test_tpex_inst_keyword_heuristics(self):
        rows = [{"SecuritiesCompanyCode": "5289",
                 "ForeignInvestorsIncludeMainlandAreaInvestors-Difference": "1000",
                 "ForeignDealers-Difference": "999",
                 "SecuritiesInvestmentTrustCompanies-Difference": "-20",
                 "Dealers-Difference": "5", "TotalDifference": "985"}]
        self.assertEqual(fd.parse_tpex_inst(rows)["5289"],
                         {"foreign": 1000.0, "trust": -20.0, "dealer": 5.0, "inst": 985.0})

    def test_stock_list_market_follows_official_quotes_and_skips_indexes(self):
        info = [{"stock_id": "7610", "stock_name": "聯友金屬", "type": "emerging", "industry_category": "綠能環保"},
                {"stock_id": "Electronic", "stock_name": "電子類指數", "type": "twse", "industry_category": "Index"},
                {"stock_id": "00679B", "stock_name": "元大美債20年", "type": "twse", "industry_category": "ETF"}]
        rows = fd.build_stock_list(info, {"7610": {"name": "聯友金屬-創"}}, {})
        self.assertEqual(rows, [["00679B", "元大美債20年", "twse", "ETF"], ["7610", "聯友金屬", "twse", "綠能環保"]])

    def test_stock_list_dedup_and_fallback_names(self):
        info = [{"stock_id": "2330", "stock_name": "台積電", "type": "twse", "industry_category": "半導體業"},
                {"stock_id": "2330", "stock_name": "台積電", "type": "twse", "industry_category": "電子工業"},
                {"stock_id": "0000", "stock_name": "", "type": "twse", "industry_category": ""}]
        rows = fd.build_stock_list(info, {"2317": {"name": "鴻海"}}, {"5289": {"name": "宜鼎"}})
        self.assertEqual(rows, [["2317", "鴻海", "twse", ""], ["2330", "台積電", "twse", "半導體業"],
                                ["5289", "宜鼎", "tpex", ""]])

    def test_keep_row_filters_unneeded_accounts(self):
        spec = fd.load_spec()["income"]
        self.assertTrue(fd.keep_row({"type": "EPS", "origin_name": ""}, spec))
        self.assertTrue(fd.keep_row({"type": "Whatever", "origin_name": "基本每股盈餘（元）"}, spec))
        self.assertFalse(fd.keep_row({"type": "Revenue_per", "origin_name": "營業收入"}, spec))
        self.assertFalse(fd.keep_row({"type": "CostOfGoodsSold", "origin_name": "營業成本合計"}, spec))

    @staticmethod
    def _yahoo(closes, price=110):
        day = 86400
        t0 = 1760500000                     # 任意基準時間
        ts = [t0 + i * day for i in range(len(closes))]
        return {"chart": {"result": [{"meta": {"regularMarketPrice": price, "regularMarketTime": ts[-1],
                                               "chartPreviousClose": 50},
                                      "timestamp": ts, "indicators": {"quote": [{"close": closes}]}}]}}

    def test_yahoo_prev_close_after_session(self):
        # 收盤後：今天有 close → 昨收是倒數第二點（不是 chartPreviousClose=50，那是區間起點）
        r = fd.parse_yahoo_chart(self._yahoo([90, 100, 110]))
        self.assertEqual((r["prev"], r["change"]), (100, 10))

    def test_yahoo_prev_close_intraday_null_today(self):
        # 盤中：今天 close 還是 null → 最後有效點 (100) 就是昨收
        r = fd.parse_yahoo_chart(self._yahoo([90, 100, None], price=105))
        self.assertEqual((r["prev"], r["change"]), (100, 5))


class NightFutures(unittest.TestCase):
    NOW = dt.datetime(2026, 10, 23, 22, 5, tzinfo=fd.TPE)

    def q(self, *rows):
        return {"RtData": {"QuoteList": list(rows)}}

    def test_picks_most_traded_single_month_and_skips_spreads_and_spot(self):
        r = fd.parse_taifex_quotes(self.q(
            {"SymbolID": "TXF-S", "CLastPrice": "27000", "CRefPrice": "26900", "CTotalVolume": "0"},
            {"SymbolID": "TXFK6-M", "DispCName": "臺指期116", "CLastPrice": "27050", "CRefPrice": "27120",
             "CTotalVolume": "41235", "CTime": "215803"},
            {"SymbolID": "TXFL6-M", "DispCName": "臺指期126", "CLastPrice": "27010", "CRefPrice": "27080",
             "CTotalVolume": "512", "CTime": "215801"},
            {"SymbolID": "TXFK6/L6-M", "DispCName": "臺指期116/126", "CLastPrice": "40", "CRefPrice": "40",
             "CTotalVolume": "99999"}), self.NOW)
        self.assertEqual((r["contract"], r["value"], r["change"]), ("臺指期116", 27050.0, -70.0))
        self.assertEqual(r["changePct"], round(-70 / 27120 * 100, 2))
        self.assertEqual(r["time"], "2026-10-23T21:58+08:00")

    def test_time_after_midnight_belongs_to_previous_day_when_needed(self):
        just_after = dt.datetime(2026, 10, 24, 0, 3, tzinfo=fd.TPE)
        r = fd.parse_taifex_quotes(self.q({"SymbolID": "TXFK6-M", "CLastPrice": "1", "CRefPrice": "1",
                                           "CTime": "235958"}), just_after)
        self.assertEqual(r["time"], "2026-10-23T23:59+08:00")

    def test_empty_or_changed_format_returns_none(self):
        self.assertIsNone(fd.parse_taifex_quotes({"RtData": {"QuoteList": []}}, self.NOW))
        self.assertIsNone(fd.parse_taifex_quotes({"unexpected": True}, self.NOW))
        self.assertIsNone(fd.parse_taifex_quotes(self.q({"SymbolID": "TXFK6-M", "CLastPrice": "", "CRefPrice": "27120"}), self.NOW))


class Security(unittest.TestCase):
    def test_token_goes_in_header_never_in_url(self):
        seen = {}

        class Resp(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def fake_urlopen(req, timeout):
            seen["url"], seen["auth"] = req.full_url, req.get_header("Authorization")
            return Resp(b'{"status":200,"data":[]}')

        tx = fd.HttpTransport("SECRET-TOKEN-123")
        with mock.patch("urllib.request.urlopen", fake_urlopen):
            fd.finmind(tx, "TaiwanStockPrice", "2330", "2026-01-01")
        self.assertNotIn("SECRET-TOKEN-123", seen["url"])
        self.assertEqual(seen["auth"], "Bearer SECRET-TOKEN-123")

    def test_http_402_stops_with_quota_exceeded(self):
        def boom(req, timeout):
            raise urllib.error.HTTPError(req.full_url, 402, "Payment Required", {}, None)
        tx = fd.HttpTransport(None)
        with mock.patch("urllib.request.urlopen", boom), self.assertRaises(fd.QuotaExceeded):
            fd.finmind(tx, "TaiwanStockPrice", "2330")

    def test_truncated_response_is_retried(self):
        import http.client
        calls = {"n": 0}

        class Resp(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def flaky(req, timeout):
            calls["n"] += 1
            if calls["n"] == 1:
                raise http.client.IncompleteRead(b"partial", 100)
            return Resp(b'[{"Code":"2330"}]')
        tx = fd.HttpTransport(None)
        with mock.patch("urllib.request.urlopen", flaky), mock.patch("time.sleep"):
            self.assertEqual(tx.get_json("https://example.test/x"), [{"Code": "2330"}])
        self.assertEqual(calls["n"], 2)

    def test_error_message_does_not_leak_token(self):
        def fail(req, timeout):
            raise urllib.error.URLError("down")
        tx = fd.HttpTransport("SECRET-TOKEN-123")
        with mock.patch("urllib.request.urlopen", fail), mock.patch("time.sleep"):
            with self.assertRaises(RuntimeError) as cm:
                fd.finmind(tx, "TaiwanStockPrice", "2330")
        self.assertNotIn("SECRET-TOKEN-123", str(cm.exception))

    def test_output_containing_token_aborts_publish(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "data"
            out.mkdir()
            (out / "x.json").write_text('{"leak":"SECRET-TOKEN-123"}')
            with self.assertRaises(SystemExit):
                fd.assert_no_secret(out, "SECRET-TOKEN-123")
            self.assertFalse(out.exists(), "整個輸出應被刪除，部署不會發生")


class Valuation(unittest.TestCase):
    def test_zero_pe_from_loss_making_company_is_missing(self):
        rows = [{"Date": "1151022", "Code": "1101", "Name": "台泥", "PEratio": "0.00", "DividendYield": "3.58", "PBratio": "0.85"},
                {"Date": "1151022", "Code": "2330", "Name": "台積電", "PEratio": "27.65", "DividendYield": "1.2", "PBratio": "0"}]
        v = fd.parse_twse_valuation(rows)
        self.assertIsNone(v["1101"]["pe"])
        self.assertEqual(v["1101"]["yield"], 3.58)          # 殖利率 0 有意義（沒配息），只處理 PE / PB
        self.assertEqual(v["2330"]["pe"], 27.65)
        self.assertIsNone(v["2330"]["pb"])


class Watchlist(unittest.TestCase):
    def load(self, text: str, suffix: str = ".csv") -> list[str]:
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / f"w{suffix}"
            f.write_text(text, "utf-8-sig" if suffix == ".csv" else "utf-8")
            return fd.load_watchlist(f)

    def test_csv_from_user_keeps_order_and_reads_code_column(self):
        csv_text = ("項次,股票代號,股票名稱,完整代號 (Yahoo),市場/類別\n"
                    "1,2327,國巨*,2327.TW,上市\n2,5347,世界,5347.TWO,上櫃\n3,00919,群益台灣精選高息,00919.TW,ETF\n"
                    "4,2327,國巨*,2327.TW,上市\n1500,abc,不是代號,,\n")
        self.assertEqual(self.load(csv_text), ["2327", "5347", "00919"])     # 去重、略過無效列、項次不會被當成代號

    def test_yahoo_finance_export_symbols(self):
        csv_text = "Symbol,Current Price,Date\n2330.TW,1000,2026/10/22\n6488.two,500,2026/10/22\n00679b.TW,30,\n"
        self.assertEqual(self.load(csv_text), ["2330", "6488", "00679B"])

    def test_csv_without_header_and_json(self):
        self.assertEqual(self.load("2330\n2454.TW\n"), ["2330", "2454"])
        self.assertEqual(self.load('{"stocks": ["2330", "0050"]}', ".json"), ["2330", "0050"])

    def test_repo_watchlist_is_valid(self):
        codes = fd.load_watchlist(ROOT / "config/watchlist.csv")
        self.assertGreater(len(codes), 0)
        etf = [c for c in codes if fd.is_etf(c)]
        # 每次完整更新的 FinMind 請求數（個股 8、ETF 4，另加清單與總經約 5）要留在免費額度 600 次/小時以內
        self.assertLess((len(codes) - len(etf)) * 8 + len(etf) * 4 + 5, 600)

    def test_etf_skips_per_revenue_and_financials(self):
        tx = fd.FixtureTransport(make_fixtures(Path(tempfile.mkdtemp())))
        d = fd.fetch_stock_detail(tx, "0050", fd.load_spec(), dt.date(2026, 10, 19))
        self.assertEqual(sorted(d["tables"]), ["holding", "inst", "margin", "price"])
        self.assertEqual(d["errors"], {})
        self.assertEqual(tx.finmind_requests, 4)


class MarketCalendar(unittest.TestCase):
    """休市日與臨時休市判斷（以 2026-10 薔琵颱風為例：10/23 五 停市、10/26 一 補假、10/27 二 開盤）"""
    HOL = [{"date": "2026-10-26", "name": "臺灣光復暨金門古寧頭大捷紀念日"}]

    @staticmethod
    def at(day: str, hm: str) -> tuple[dt.date, dt.datetime]:
        d = dt.date.fromisoformat(day)
        return d, dt.datetime.combine(d, dt.time.fromisoformat(hm), tzinfo=fd.TPE)

    def test_parse_holidays_excludes_first_and_last_trading_day_rows(self):
        rows = [{"Name": "國慶日", "Date": "1151009", "Weekday": "五", "Description": "放假"},
                {"Name": "國曆新年開始交易日", "Date": "1160104", "Weekday": "一", "Description": ""},
                {"Name": "農曆春節前最後交易日", "Date": "1160203", "Weekday": "三", "Description": ""},
                {"Name": "", "Date": "1160205", "Weekday": "五", "Description": ""}]
        self.assertEqual(fd.parse_holidays(rows), [{"date": "2026-10-09", "name": "國慶日"}])

    def test_typhoon_day_detected_only_after_1500(self):
        self.assertEqual(fd.detect_closures(*self.at("2026-10-23", "14:00"), "2026-10-22", "2026-10-22", self.HOL), [])
        self.assertEqual(fd.detect_closures(*self.at("2026-10-23", "21:47"), "2026-10-22", "2026-10-22", self.HOL),
                         ["2026-10-23"])

    def test_closure_kept_over_weekend_and_scheduled_holiday_excluded(self):
        self.assertEqual(fd.detect_closures(*self.at("2026-10-24", "02:17"), "2026-10-22", "2026-10-22", self.HOL),
                         ["2026-10-23"])
        self.assertEqual(fd.detect_closures(*self.at("2026-10-27", "10:12"), "2026-10-22", "2026-10-22", self.HOL),
                         ["2026-10-23"])                     # 10/26 是排定休市，10/27 還沒收盤

    def test_no_closure_when_only_one_source_is_stale_or_missing(self):
        self.assertEqual(fd.detect_closures(*self.at("2026-10-23", "21:47"), "2026-10-22", "2026-10-23", []), [])
        self.assertEqual(fd.detect_closures(*self.at("2026-10-23", "21:47"), None, "2026-10-22", []), [])


class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.fx = make_fixtures(Path(cls.tmp.name))
        cls.out = Path(cls.tmp.name) / "site" / "data"
        with mock.patch.dict(os.environ, {"FINMIND_TOKEN": "SECRET-TOKEN-123"}):
            cls.rc = fd.main(["--watchlist", WATCH, "--fixtures", str(cls.fx), "--out", str(cls.out), "--today", "2026-10-19"])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_all_outputs_written(self):
        self.assertEqual(self.rc, 0)
        for name in ("meta.json", "stocks.json", "market.json", "macro.json", "quotes.json", "datasets.json"):
            self.assertTrue((self.out / name).exists(), name)
        watch = json.loads(Path(WATCH).read_text())["stocks"]
        for code in watch:
            self.assertTrue((self.out / "stock" / f"{code}.json").exists(), code)

    def test_macro_has_night_futures_dow_nasdaq_in_order(self):
        items = json.loads((self.out / "macro.json").read_text())["items"]
        keys = [m["key"] for m in items]
        self.assertEqual(keys, ["taiex", "otc", "txf_night", "dji", "ixic", "sox", "usdtwd", "dxy", "us10y", "gold", "fed"])
        night = items[2]
        self.assertEqual((night["label"], night["value"], night["source"]), ("台指期夜盤", 27050.0, "期交所（臺指期116）"))

    def test_night_futures_falls_back_to_finmind_close(self):
        with tempfile.TemporaryDirectory() as d:
            fx = make_fixtures(Path(d))
            (fx / "taifex_quotes_1.json").unlink()           # 期交所 API 失敗
            out = Path(d) / "out"
            fd.main(["--watchlist", WATCH, "--fixtures", str(fx), "--out", str(out), "--today", "2026-10-19"])
            night = {m["key"]: m for m in json.loads((out / "macro.json").read_text())["items"]}["txf_night"]
            meta = json.loads((out / "meta.json").read_text())
        # 近月（成交量最大的單一月份 202611），排除價差 202611/202612
        self.assertEqual((night["value"], night["change"], night["source"]), (26990.0, -40.0, "FinMind（夜盤收盤）"))
        self.assertFalse(meta["sources"]["taifex_night"]["ok"])
        self.assertIn("FinMind", meta["sources"]["taifex_night"]["note"])

    def test_macro_otc_index_from_finmind(self):
        items = {m["key"]: m for m in json.loads((self.out / "macro.json").read_text())["items"]}
        self.assertEqual(items["otc"]["source"], "FinMind（日收盤）")
        self.assertEqual(items["taiex"]["source"], "Yahoo")          # Yahoo 正常時仍用 Yahoo（有盤中價）
        self.assertEqual([m["key"] for m in json.loads((self.out / "macro.json").read_text())["items"]][:2],
                         ["taiex", "otc"])

    def test_meta_reports_sources_and_demo_flag(self):
        meta = json.loads((self.out / "meta.json").read_text())
        self.assertTrue(meta["demo"])
        self.assertTrue(meta["tokenUsed"])
        self.assertTrue(all(s["ok"] for s in meta["sources"].values()), meta["sources"])

    def test_market_covers_twse_and_tpex_with_institutional(self):
        m = json.loads((self.out / "market.json").read_text())
        cols = m["cols"]
        self.assertIn("2330", m["rows"])
        self.assertIn("5289", m["rows"])                        # 上櫃
        self.assertIsNotNone(m["rows"]["2330"][cols.index("foreign")])
        self.assertEqual(m["asOf"]["twse"], "2026-10-19")

    def test_token_never_in_any_output(self):
        for f in self.out.rglob("*.json"):
            self.assertNotIn("SECRET-TOKEN-123", f.read_text("utf-8"), f.name)

    def test_missing_source_is_reported_not_fatal(self):
        with tempfile.TemporaryDirectory() as d:
            fx = make_fixtures(Path(d))
            (fx / "openapi_v1_tpex_mainboard_quotes.json").unlink()
            out = Path(d) / "out"
            rc = fd.main(["--watchlist", WATCH, "--fixtures", str(fx), "--out", str(out), "--today", "2026-10-19"])
            meta = json.loads((out / "meta.json").read_text())
            self.assertEqual(rc, 0)
            self.assertFalse(meta["sources"]["tpex_quotes"]["ok"])
            self.assertTrue(meta["sources"]["twse_quotes"]["ok"])

    def test_meta_market_calendar(self):
        meta = json.loads((self.out / "meta.json").read_text())
        mk = meta["market"]
        self.assertEqual(mk["lastTradingDay"], "2026-10-19")
        self.assertEqual([h["date"] for h in mk["holidays"]], ["2026-10-09", "2026-10-26", "2027-01-01", "2027-02-05"])
        self.assertEqual(mk["closures"], [])
        self.assertTrue(mk["holidaysOk"])
        self.assertEqual(meta["macroAt"], meta["generatedAt"])

    def test_t86_falls_back_to_previous_trading_day(self):
        tx = fd.FixtureTransport(self.fx)
        # 週二沒有 T86 fixture（尚未公布）→ 應往回找到週一 2026-10-19
        data, day = fd.fetch_t86(tx, dt.date(2026, 10, 20))
        self.assertEqual(day, "2026-10-19")
        self.assertTrue(data)


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D401 — 測試時不印存取紀錄
        pass


def serve(directory: Path) -> http.server.ThreadingHTTPServer:
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(directory)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def stop(srv: http.server.ThreadingHTTPServer) -> None:
    srv.shutdown()
    srv.server_close()


class MacroOnly(unittest.TestCase):
    """夜間輕量模式：從已部署的網站取回上一份資料，只重抓總經"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.fx = make_fixtures(root)
        cls.site = root / "site"
        fd.main(["--watchlist", WATCH, "--fixtures", str(cls.fx), "--out", str(cls.site / "data"), "--today", "2026-10-19"])
        cls.srv = serve(cls.site)
        cls.url = f"http://127.0.0.1:{cls.srv.server_address[1]}/"

    @classmethod
    def tearDownClass(cls):
        stop(cls.srv)
        cls.tmp.cleanup()

    def run_macro(self, url: str, out: Path) -> int:
        return fd.main(["--watchlist", WATCH, "--fixtures", str(self.fx), "--out", str(out), "--today", "2026-10-19",
                        "--macro-only", "--base-url", url])

    def test_keeps_previous_data_and_refreshes_macro(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "data"
            self.assertEqual(self.run_macro(self.url, out), 0)
            prev = json.loads((self.site / "data/meta.json").read_text())
            meta = json.loads((out / "meta.json").read_text())
            # 個股、全市場資料與上一份完全相同
            for rel in ("market.json", "stocks.json", "quotes.json", "datasets.json", "stock/2330.json"):
                self.assertEqual((out / rel).read_bytes(), (self.site / "data" / rel).read_bytes(), rel)
            self.assertEqual(meta["generatedAt"], prev["generatedAt"])
            self.assertEqual(meta["mode"], "macro")
            self.assertGreaterEqual(meta["macroAt"], prev["macroAt"])
            self.assertLessEqual(meta["macroFinmindRequests"], 4)
            self.assertEqual(meta["market"]["lastTradingDay"], "2026-10-19")
            self.assertTrue(meta["sources"]["twse_quotes"]["ok"])           # 上一份的來源狀態仍保留
            self.assertEqual(set(meta["bytes"]), set(prev["bytes"]))

    def run_mode(self, mode: str, out: Path, watch: list[str] | None = None, url: str | None = None) -> dict:
        args = ["--fixtures", str(self.fx), "--out", str(out), "--today", "2026-10-19", "--mode", mode,
                "--base-url", url or self.url]
        if watch is not None:
            out.parent.mkdir(parents=True, exist_ok=True)
            wl = out.parent / "wl.json"
            wl.write_text(json.dumps({"stocks": watch}))
            args += ["--watchlist", str(wl)]
        else:
            args += ["--watchlist", WATCH]
        self.assertEqual(fd.main(args), 0)
        return json.loads((out / "meta.json").read_text())

    def serve_without(self, tmp: Path, code: str) -> http.server.ThreadingHTTPServer:
        """複製網站並拿掉一檔個股（meta.bytes 也拿掉，等同這檔從沒抓過）"""
        site = tmp / "site"
        shutil.copytree(self.site, site)
        (site / f"data/stock/{code}.json").unlink()
        meta_f = site / "data/meta.json"
        m = json.loads(meta_f.read_text())
        m["bytes"].pop(f"stock/{code}.json")
        meta_f.write_text(json.dumps(m))
        return serve(site)

    def test_auto_fetches_only_new_stocks_and_drops_removed(self):
        prev = json.loads((self.site / "data/meta.json").read_text())["watchlist"]
        watch = [c for c in prev if c != "2330"] + ["3189"]          # 移除 2330；3189 本來就有
        with tempfile.TemporaryDirectory() as d:
            srv = self.serve_without(Path(d), "2454")          # 網站上缺 2454（模擬「新加入清單」）
            try:
                out = Path(d) / "out" / "data"
                meta = self.run_mode("auto", out, watch, f"http://127.0.0.1:{srv.server_address[1]}/")
            finally:
                stop(srv)
            self.assertEqual(meta["mode"], "auto")
            self.assertTrue((out / "stock/2454.json").exists())                 # 新的：抓了
            self.assertFalse((out / "stock/2330.json").exists())                # 移除的：刪掉
            self.assertNotIn("stock/2330.json", meta["bytes"])
            self.assertEqual((out / "stock/3189.json").read_bytes(), (self.site / "data/stock/3189.json").read_bytes())
            # 只抓 2454 一檔（8 個資料集）+ 股票清單 1 + 總經 2
            self.assertEqual(meta["finmindRequests"], 8 + 1 + 2)
            self.assertIn("本次更新 1 檔", meta["sources"]["finmind_watchlist"]["note"])
            self.assertTrue(meta["sources"]["finmind_watchlist"]["ok"])

    def test_full_keeps_previous_files_when_quota_runs_out(self):
        real = fd.FixtureTransport.get_json
        def limited(tx, url, params=None, kind="public"):
            if kind == "finmind" and tx.finmind_requests >= 40:            # 第 40 次之後 402
                raise fd.QuotaExceeded("FinMind quota exceeded (HTTP 402)")
            return real(tx, url, params, kind)
        with tempfile.TemporaryDirectory() as d, mock.patch.object(fd.FixtureTransport, "get_json", limited):
            out = Path(d) / "data"
            meta = self.run_mode("full", out)
            watch = json.loads(Path(WATCH).read_text())["stocks"]
            for c in watch:                                                  # 每一檔都還有資料（新的或上一份）
                self.assertTrue((out / f"stock/{c}.json").exists(), c)
            self.assertIn("額度用完", meta["sources"]["finmind_watchlist"]["note"])

    def test_macro_mode_fills_missing_stock(self):
        with tempfile.TemporaryDirectory() as d:
            srv = self.serve_without(Path(d), "6669")          # 上次額度用完、沒抓到 6669
            try:
                out = Path(d) / "out" / "data"
                meta = self.run_mode("macro", out, url=f"http://127.0.0.1:{srv.server_address[1]}/")
            finally:
                stop(srv)
            self.assertEqual(meta["mode"], "macro")
            self.assertTrue((out / "stock/6669.json").exists())
            self.assertIn("stock/6669.json", meta["bytes"])
            self.assertEqual(meta["macroFinmindRequests"], 2 + 8)
            wl = meta["sources"]["finmind_watchlist"]
            self.assertTrue(wl["ok"])
            self.assertEqual(wl["note"], "補抓 1 檔")

    def test_falls_back_to_full_run_when_site_unreachable(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "data"
            self.assertEqual(self.run_macro("http://127.0.0.1:9/", out), 0)
            meta = json.loads((out / "meta.json").read_text())
            self.assertEqual(meta["mode"], "full")
            self.assertTrue((out / "stock" / "2330.json").exists())

    def test_falls_back_when_a_file_is_missing(self):
        with tempfile.TemporaryDirectory() as d:
            broken = Path(d) / "site"
            shutil.copytree(self.site, broken)
            (broken / "data" / "stock" / "2330.json").unlink()
            srv = serve(broken)
            try:
                out = Path(d) / "data"
                self.run_macro(f"http://127.0.0.1:{srv.server_address[1]}/", out)
            finally:
                stop(srv)
            meta = json.loads((out / "meta.json").read_text())
            self.assertEqual(meta["mode"], "full")                                # 完整模式重抓
            self.assertTrue((out / "stock" / "2330.json").exists())


if __name__ == "__main__":
    unittest.main()
