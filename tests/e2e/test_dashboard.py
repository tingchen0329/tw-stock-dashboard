"""
端對端測試：用 headless Chromium 操作真正的網頁（合成資料，不連外網）

涵蓋：
  * 代號 / 名稱 / 全形 / 部分名稱搜尋、鍵盤操作
  * 追蹤清單外的股票走「FinMind 即時查詢」路徑（以攔截請求模擬 FinMind）
  * XSS：股票名稱含 <img onerror> 也不會執行
  * 競態：快速切換兩檔股票，畫面最後一定是後點的那檔
  * 匯出 Excel 可被 openpyxl 開啟
  * 網頁除了本站與 FinMind 之外不連任何第三方
  * token 不會出現在網站檔案中

執行：python tests/e2e/test_dashboard.py   （需要 pip install playwright && playwright install chromium）
"""
from __future__ import annotations

import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SECRET = "E2E-SECRET-TOKEN-xyz"


def build_site(tmp: Path) -> tuple[Path, Path]:
    fx = tmp / "fx"
    subprocess.run([sys.executable, ROOT / "tests/fixtures/make_fixtures.py", fx, "--xss"], check=True, capture_output=True)
    site = tmp / "site"
    site.mkdir()
    shutil.copy(ROOT / "index.html", site)
    shutil.copytree(ROOT / "assets", site / "assets")
    env = {**os.environ, "FINMIND_TOKEN": SECRET}
    subprocess.run([sys.executable, ROOT / "scripts/fetch_data.py", "--fixtures", fx, "--out", site / "data",
                    "--today", "2026-10-19"], check=True, capture_output=True, env=env)
    return site, fx


class Dashboard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.site, cls.fx = build_site(Path(cls.tmp.name))
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a):  # 不要把每個請求印到測試輸出
                pass
        handler = functools.partial(Quiet, directory=str(cls.site))
        cls.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}/"
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.httpd.shutdown()
        cls.tmp.cleanup()

    def setUp(self):
        self.ctx = self.browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        self.page = self.ctx.new_page()
        self.errors: list[str] = []
        self.hosts: set[str] = set()
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.on("console", lambda m: self.errors.append(m.text) if m.type == "error" else None)
        self.page.on("request", lambda r: self.hosts.add(urlparse(r.url).hostname or ""))
        self.page.route("https://api.finmindtrade.com/**", self._fake_finmind)

    def tearDown(self):
        self.ctx.close()

    def _fake_finmind(self, route):
        """清單外股票：回傳 2330 的 fixture 當作該股資料（只是要驗證流程）。也確認網頁沒有帶 token。"""
        q = parse_qs(urlparse(route.request.url).query)
        assert "token" not in q and "authorization" not in {k.lower() for k in route.request.headers}
        f = self.fx / f"finmind_{q['dataset'][0]}_2330.json"
        route.fulfill(status=200, content_type="application/json",
                      body=f.read_text("utf-8") if f.exists() else '{"status":200,"data":[]}')

    def open(self, hash_=""):
        self.page.goto(self.base + hash_)
        self.page.wait_for_selector(".stock-head h2")

    def search(self, text):
        box = self.page.locator("#search")
        box.fill(text)
        self.page.wait_for_selector("#results li")
        box.press("Enter")

    def title(self):
        return self.page.locator(".stock-head h2").inner_text()

    def wait_stock(self, code):
        """等畫面真的換成這檔（hash 改變後，hashchange 處理是非同步的）"""
        # 用 locator 等待而非 wait_for_function：後者輪詢時需要 eval，會被網頁的 CSP 擋下（CSP 生效的證明）
        self.page.locator(".stock-head h2").filter(has_text=code).wait_for()

    # ── 測試 ──
    def test_initial_load_watchlist_stock(self):
        self.open("#2330")
        self.page.wait_for_selector(".panel .chart svg")
        self.assertIn("2330", self.title())
        self.assertIn("100%", self.page.locator(".completeness summary").inner_text())
        self.assertEqual(self.page.locator(".chart svg").count(), 3)
        self.assertEqual(self.errors, [])

    def test_search_by_name_full_width_and_partial(self):
        self.open("#2330")
        self.search("宜鼎")
        self.wait_stock("5289")
        self.assertIn("宜鼎", self.title())
        self.search("２４５４")
        self.wait_stock("2454")
        self.page.locator("#search").fill("台積")
        self.page.wait_for_selector("#results li")
        self.assertIn("2330", self.page.locator("#results li").first.inner_text())

    def test_keyboard_slash_focus_and_arrow_select(self):
        self.open("#2330")
        self.page.locator("body").press("/")
        self.assertEqual(self.page.evaluate("document.activeElement.id"), "search")
        self.page.keyboard.type("23")
        self.page.wait_for_selector("#results li")
        self.page.keyboard.press("ArrowDown")
        second = self.page.locator('#results li[aria-selected="true"] .code').inner_text()
        self.page.keyboard.press("Enter")
        self.wait_stock(second)

    def test_non_watchlist_stock_uses_live_finmind_without_token(self):
        self.open("#2330")
        self.search("上市測試005")
        self.page.wait_for_selector("text=FinMind 即時查詢")
        self.page.wait_for_selector(".panel .chart svg")
        self.assertIn("上市測試005", self.title())

    def test_xss_in_stock_name_is_not_executed(self):
        self.open("#9999")
        self.page.locator("#search").fill("9999")
        self.page.wait_for_selector("#results li")
        self.page.wait_for_timeout(200)
        self.assertIsNone(self.page.evaluate("window.__xss"))
        self.assertEqual(self.page.locator("#results img, .stock-head img").count(), 0)
        self.assertIn("<img", self.title())            # 名稱以純文字顯示

    def test_rapid_switch_shows_last_selected(self):
        self.open("#2330")
        self.page.evaluate("location.hash = '#6669'; location.hash = '#5289'")
        self.page.wait_for_timeout(800)
        self.assertIn("5289", self.title())

    def test_excel_download_opens(self):
        self.open("#2330")
        self.page.wait_for_selector(".panel .chart svg")
        with self.page.expect_download() as dl:
            self.page.get_by_role("button", name="下載 Excel").click()
        path = Path(self.tmp.name) / "out.xlsx"
        dl.value.save_as(path)
        try:
            import openpyxl
        except ImportError:
            self.assertGreater(path.stat().st_size, 1000)
            return
        wb = openpyxl.load_workbook(path)
        self.assertEqual(wb.sheetnames, ["摘要", "股價", "月營收", "三大法人", "財報"])

    def test_prompt_dialog_contains_real_numbers(self):
        self.open("#2330")
        self.page.wait_for_selector(".panel .chart svg")
        self.page.get_by_role("button", name="產生分析指令").click()
        text = self.page.locator("#prompt-text").input_value()
        self.assertIn("2330 台積電", text)
        self.assertIn("本益比河流圖", text)
        self.assertIn("分析師自我檢查", text)

    def test_no_unexpected_third_party_requests(self):
        self.open("#2330")
        self.page.wait_for_selector(".panel .chart svg")
        self.assertTrue(self.hosts <= {"127.0.0.1", "api.finmindtrade.com"}, self.hosts)

    def test_token_not_in_published_site(self):
        for f in self.site.rglob("*"):
            if f.is_file():
                self.assertNotIn(SECRET, f.read_text("utf-8", errors="ignore"), f)


if __name__ == "__main__":
    unittest.main(verbosity=2)
