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
AI_URL = "https://tw-stock-ai-proxy.vercel.app/api/ai"


def build_site(tmp: Path) -> tuple[Path, Path]:
    fx = tmp / "fx"
    subprocess.run([sys.executable, ROOT / "tests/fixtures/make_fixtures.py", fx, "--xss"], check=True, capture_output=True)
    site = tmp / "site"
    site.mkdir()
    shutil.copy(ROOT / "index.html", site)
    shutil.copytree(ROOT / "assets", site / "assets")
    (site / "assets" / "ai.json").write_text(json.dumps({"url": AI_URL}))     # 測試用 Worker（以攔截模擬）
    env = {**os.environ, "FINMIND_TOKEN": SECRET}
    subprocess.run([sys.executable, ROOT / "scripts/fetch_data.py", "--fixtures", fx, "--out", site / "data",
                    "--today", "2026-10-19", "--watchlist", ROOT / "tests/fixtures/watchlist.json",
                    "--us-watchlist", ROOT / "tests/fixtures/us_watchlist.csv"],
                   check=True, capture_output=True, env=env)
    subprocess.run(["node", ROOT / "scripts/build_overview.mjs", site / "data"], check=True, capture_output=True)
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
        macro = self.page.locator("#macro").inner_text()
        for label in ("台指期夜盤", "道瓊工業", "那斯達克", "櫃買指數"):
            self.assertIn(label, macro)
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
        self.assertIn("【本益比河流圖】", text)
        self.assertIn("破線停損價", text)
        self.assertNotIn("undefined", text)
        self.assertLess(len(text), 3200)                # 精簡版：v2 約 4,800 字

    def test_overview_is_home_page_with_filters_sort_and_click(self):
        self.page.goto(self.base)
        rows = self.page.locator(".ov tbody tr")
        rows.nth(19).wait_for()
        self.assertEqual(rows.count(), 20)
        self.assertEqual(self.page.locator('#watchlist .ov-chip[data-code="overview"]').get_attribute("aria-current"), "true")
        # 篩選 ETF → 只剩 0050，本益比等欄位顯示 N/A
        self.page.get_by_role("button", name="ETF 1").click()
        self.assertEqual(rows.count(), 1)
        self.assertIn("0050", rows.first.inner_text())
        self.assertIn("N/A", rows.first.inner_text())
        self.page.get_by_role("button", name="個股 19").click()
        self.assertEqual(rows.count(), 19)
        # 排序：第一次點由大到小
        th = self.page.locator(".ov th", has_text="營收年增")
        th.click()
        self.assertEqual(th.get_attribute("aria-sort"), "descending")
        vals = [float(t.replace("%", "").replace("+", "")) for t in
                self.page.locator(".ov tbody tr td:nth-child(7)").all_inner_texts()]
        self.assertEqual(vals, sorted(vals, reverse=True))
        # 點一列 → 開啟個股
        code = rows.first.get_attribute("data-code")
        rows.first.click()
        self.wait_stock(code)
        self.assertEqual(self.errors, [])

    def test_screener_presets_thresholds_and_click(self):
        self.page.goto(self.base + "#screen")
        count = self.page.locator(".screen-count")
        count.filter(has_text="符合").wait_for()
        growth = count.inner_text()
        self.assertEqual(self.page.get_by_role("button", name="成長型").get_attribute("aria-pressed"), "true")
        # 切到殖利率型：條件與結果不同
        self.page.get_by_role("button", name="殖利率型").click()
        self.assertNotEqual(count.inner_text(), growth)
        self.assertIn("殖利率", self.page.locator(".screen-form").inner_text())
        # 每一列都符合殖利率 ≥ 5%（第 7 欄）
        ys = [float(t.rstrip("%")) for t in self.page.locator(".ov tbody tr td:nth-child(7)").all_inner_texts()]
        self.assertTrue(ys and all(y >= 5 for y in ys), ys)
        # 放寬門檻 → 結果變多
        before = int(count.inner_text().split("符合 ")[1].split(" 檔")[0].replace(",", ""))
        self.page.get_by_label("殖利率 ≥").fill("3")
        after = int(count.inner_text().split("符合 ")[1].split(" 檔")[0].replace(",", ""))
        self.assertGreater(after, before)
        # 點一列 → 開啟個股（清單外的股票走即時查詢）
        row = self.page.locator(".ov tbody tr").first
        code = row.get_attribute("data-code")
        row.click()
        self.wait_stock(code)
        self.assertEqual(self.errors, [])

    def test_us_overview_and_stock_page(self):
        self.page.goto(self.base)
        self.page.get_by_role("link", name="美股").click()
        rows = self.page.locator(".ov tbody tr")
        # 等美股表格出現（點下去的瞬間畫面上還是台股總覽，nth(2) 會被台股的列滿足 → 競態）
        self.page.locator('.ov tbody tr[data-code="NVDA"]').wait_for()
        self.assertEqual(rows.count(), 3)
        self.assertEqual(self.page.locator("#sw-us").get_attribute("aria-current"), "true")
        self.assertFalse(self.page.locator("#watchlist").is_visible())          # 美股頁隱藏台股追蹤列
        heads = self.page.locator(".ov thead").inner_text()
        self.assertNotIn("外資", heads)
        self.assertNotIn("河流圖", heads)
        rows.first.click()
        self.page.locator(".stock-head h2").filter(has_text="NVDA").wait_for()
        self.assertIn("#us/NVDA", self.page.url)
        self.assertEqual(self.page.locator(".chart svg").count(), 1)           # 只有股價圖（沒有河流圖、月營收）
        self.assertIn("100%", self.page.locator(".completeness summary").inner_text())
        tv = self.page.get_by_role("link", name="TradingView ↗")
        self.assertIn("symbol=NVDA", tv.get_attribute("href"))
        self.page.get_by_role("button", name="產生分析指令").click()
        self.assertIn("你是美股分析師", self.page.locator("#prompt-text").input_value())
        self.page.locator("#prompt-close").click()
        # 回台股
        self.page.get_by_role("link", name="台股").click()
        self.page.locator(".ov tbody tr").nth(19).wait_for()
        self.assertEqual(self.errors, [])

    def test_gemini_panel_sends_prompt_with_access_code_and_renders_safely(self):
        sent = []
        def fake(route):
            sent.append((route.request.headers.get("x-access-code"), json.loads(route.request.post_data)))
            if route.request.headers.get("x-access-code") != "pw-ok":
                route.fulfill(status=401, content_type="application/json", body=json.dumps({"error": "通關密碼錯誤，請重新輸入"}))
                return
            route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "text": "## 結論\n**中性偏多**\n\n| 項目 | 價位 | 依據 |\n|---|---|---|\n| 破線停損價 | 900 | MA60 |\n\n<img src=x onerror=\"window.__xss=1\">",
                "model": "gemini-test", "createdAt": "2026-11-02T01:00:00Z", "cached": False}))
        self.page.route(AI_URL + "/**", fake)
        self.page.route(AI_URL, fake)
        self.open("#2330")
        panel = self.page.locator(".ai-panel")
        panel.wait_for()
        panel.locator("input").fill("wrong")
        panel.get_by_role("button", name="儲存並產生報告").click()
        panel.locator(".banner").filter(has_text="通關密碼錯誤").wait_for()
        panel.locator("input").fill("pw-ok")                                    # 錯誤後會重新要求輸入
        panel.get_by_role("button", name="儲存並產生報告").click()
        panel.locator(".ai-result table").wait_for()
        self.assertIn("破線停損價", panel.inner_text())
        self.assertEqual(panel.locator(".ai-result img").count(), 0)          # 回覆裡的 HTML 只當文字
        self.assertIsNone(self.page.evaluate("window.__xss"))
        code, body = sent[-1]
        self.assertEqual(body["code"], "2330")
        self.assertIn("2330 台積電", body["prompt"])
        self.assertNotIn(SECRET, json.dumps(body))

    def test_header_ai_button_generates_report_at_bottom(self):
        calls = []
        def fake(route):
            calls.append(json.loads(route.request.post_data))
            route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "text": "## 結論\n中性", "model": "gemini-test", "createdAt": "2026-11-02T01:00:00Z", "cached": False}))
        self.page.route(AI_URL, fake)
        self.page.add_init_script("localStorage.setItem('ai:access-code', 'pw-ok')")
        self.open("#2330")
        self.page.locator(".ai-panel").wait_for()
        # 按鈕在「產生分析指令」左邊
        labels = self.page.locator(".stock-head .actions > *").all_inner_texts()
        self.assertEqual(labels.index("產生 AI 報告") + 1, labels.index("產生分析指令"))
        self.page.locator(".stock-head").get_by_role("button", name="產生 AI 報告").click()
        self.page.locator(".ai-result").filter(has_text="中性").wait_for()
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["code"], "2330")
        # 已有報告：再按只捲到報告，不重複呼叫
        self.page.locator(".stock-head").get_by_role("button", name="產生 AI 報告").click()
        self.page.wait_for_timeout(300)
        self.assertEqual(len(calls), 1)

    def test_market_closed_banner_uses_holiday_schedule(self):
        # 週六上午：下次開盤要跳過 10/26（fixture 的證交所休市表）→ 10/27
        self.page.clock.set_fixed_time("2026-10-24T10:00:00+08:00")
        self.open("#2330")
        self.assertIn("今天 10/24（六）台股休市（週末）。下列為 10/19（一）收盤資料，下次開盤 10/27（二）。",
                      self.page.locator("#banners").inner_text())

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
