"""
fetch_data.py 單元測試（只用標準函式庫 unittest，不需安裝套件）
執行：python -m unittest discover -s tests/py -v
"""
from __future__ import annotations

import datetime as dt
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import fetch_data as fd  # noqa: E402

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


class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.fx = make_fixtures(Path(cls.tmp.name))
        cls.out = Path(cls.tmp.name) / "site" / "data"
        with mock.patch.dict(os.environ, {"FINMIND_TOKEN": "SECRET-TOKEN-123"}):
            cls.rc = fd.main(["--fixtures", str(cls.fx), "--out", str(cls.out), "--today", "2026-10-19"])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_all_outputs_written(self):
        self.assertEqual(self.rc, 0)
        for name in ("meta.json", "stocks.json", "market.json", "macro.json", "quotes.json", "datasets.json"):
            self.assertTrue((self.out / name).exists(), name)
        watch = json.loads((ROOT / "config/watchlist.json").read_text())["stocks"]
        for code in watch:
            self.assertTrue((self.out / "stock" / f"{code}.json").exists(), code)

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
            rc = fd.main(["--fixtures", str(fx), "--out", str(out), "--today", "2026-10-19"])
            meta = json.loads((out / "meta.json").read_text())
            self.assertEqual(rc, 0)
            self.assertFalse(meta["sources"]["tpex_quotes"]["ok"])
            self.assertTrue(meta["sources"]["twse_quotes"]["ok"])

    def test_t86_falls_back_to_previous_trading_day(self):
        tx = fd.FixtureTransport(self.fx)
        # 週二沒有 T86 fixture（尚未公布）→ 應往回找到週一 2026-10-19
        data, day = fd.fetch_t86(tx, dt.date(2026, 10, 20))
        self.assertEqual(day, "2026-10-19")
        self.assertTrue(data)


if __name__ == "__main__":
    unittest.main()
