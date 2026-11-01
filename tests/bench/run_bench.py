#!/usr/bin/env python3
"""
效能比較：舊版 v5.1 (tests/bench/legacy/index.html) vs 新版 v6

方法：兩個版本都在同一個 headless Chromium 裡執行；所有對外請求都被攔截，
用「同一份合成資料」+「同一組延遲假設」回應，所以差異只來自程式架構。

網路延遲假設（可用參數調整，結果寫在 docs/PERFORMANCE.md）：
  公共 CORS proxy（corsproxy.io 等）  1,200 ms   ← 舊版主要瓶頸
  FinMind API 直連                     400 ms
  Stooq 直連                           瀏覽器端無 CORS → 200 ms 後失敗
  cdnjs (SheetJS 0.18.5，約 880 KB)     150 ms
  GitHub Pages 靜態檔                   60 ms

傳輸量：以 gzip 壓縮後大小估算（GitHub Pages 與多數 proxy 都會 gzip）。

用法：python tests/bench/run_bench.py [--runs 5] [--proxy-down]
"""
from __future__ import annotations

import argparse
import asyncio
import functools
import gzip
import http.server
import json
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
LAT = {"proxy": 1.2, "finmind": 0.4, "stooq": 0.2, "cdn": 0.15, "static": 0.06}
SHEETJS_BYTES = 880_000


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def build(tmp: Path) -> tuple[Path, Path]:
    fx = tmp / "fx"
    subprocess.run([sys.executable, ROOT / "tests/fixtures/make_fixtures.py", fx], check=True, capture_output=True)
    site = tmp / "site"
    (site / "legacy").mkdir(parents=True)
    shutil.copy(ROOT / "index.html", site)
    shutil.copytree(ROOT / "assets", site / "assets")
    shutil.copy(ROOT / "tests/bench/legacy/index.html", site / "legacy/index.html")
    subprocess.run([sys.executable, ROOT / "scripts/fetch_data.py", "--fixtures", fx, "--out", site / "data",
                    "--today", "2026-10-19", "--watchlist", ROOT / "tests/fixtures/watchlist.json",
                    "--us-watchlist", ROOT / "tests/fixtures/us_watchlist.csv"],
                   check=True, capture_output=True)
    subprocess.run(["node", ROOT / "scripts/build_overview.mjs", site / "data"], check=True, capture_output=True)
    return site, fx


class Net:
    """攔截所有請求：依目的地套用延遲並回傳 fixture，同時記錄請求數與 gzip 後位元組。"""

    def __init__(self, fx: Path, proxy_down: bool = False):
        self.fx, self.proxy_down = fx, proxy_down
        self.reset()

    def reset(self):
        self.requests, self.bytes = 0, 0

    def _fixture(self, target: str) -> tuple[int, bytes]:
        u = urlparse(target)
        q = parse_qs(u.query)
        if u.hostname == "openapi.twse.com.tw":
            name = u.path.strip("/").replace("/", "_") + ".json"
        elif u.hostname == "query1.finance.yahoo.com":
            sym = unquote(u.path.split("/chart/")[1]).replace("^", "IDX_").replace("=", "_")
            name = f"yahoo_{sym}.json"
        elif u.hostname == "api.finmindtrade.com":
            ds, did = q.get("dataset", [""])[0], q.get("data_id", [""])[0]
            f = self.fx / f"finmind_{ds}_{did}.json"
            if not f.exists():
                f = self.fx / f"finmind_{ds}_2330.json"     # 清單外股票：借用 2330 的資料驗證流程
            if not f.exists():
                return 200, b'{"status":200,"data":[]}'
            data = json.loads(f.read_text("utf-8"))
            start = q.get("start_date", [""])[0]
            if start and data.get("data") and "date" in data["data"][0]:
                data["data"] = [r for r in data["data"] if r["date"] >= start]   # 模擬 API 依日期過濾
            return 200, json.dumps(data, ensure_ascii=False).encode()
        else:
            return 404, b"{}"
        f = self.fx / name
        return (200, f.read_bytes()) if f.exists() else (404, b"{}")

    async def handle(self, route):
        url = route.request.url
        u = urlparse(url)
        host = u.hostname or ""
        if host == "127.0.0.1":
            # 本站靜態檔：模擬 CDN 延遲，內容照實回傳
            await asyncio.sleep(LAT["static"])
            resp = await route.fetch()
            body = await resp.body()
            self._count(body, url)
            return await route.fulfill(response=resp, body=body)
        if host == "cdnjs.cloudflare.com":
            await asyncio.sleep(LAT["cdn"])
            body = b"/*" + b" " * (SHEETJS_BYTES - 4) + b"*/"
            self._count(body, url, compressible=False)
            return await route.fulfill(status=200, content_type="application/javascript", body=body)
        if host == "stooq.com":
            await asyncio.sleep(LAT["stooq"])
            self.requests += 1
            return await route.abort("failed")             # 瀏覽器實際情況：CORS 擋下
        if host in ("corsproxy.io", "api.allorigins.win", "api.codetabs.com"):
            self.requests += 1
            if self.proxy_down:
                await asyncio.sleep(30)                    # proxy 掛掉：沒有回應，直到前端逾時
                try:
                    return await route.abort("timedout")
                except Exception:                          # 前端已先逾時取消，忽略
                    return None
            q = parse_qs(u.query)
            target = unquote(u.query) if host == "corsproxy.io" else q.get("url", q.get("quest", [""]))[0]
            await asyncio.sleep(LAT["proxy"])
            status, body = self._fixture(target)
            self.bytes += len(gzip.compress(body))
            return await route.fulfill(status=status, content_type="application/json", body=body,
                                       headers={"Access-Control-Allow-Origin": "*"})
        if host == "api.finmindtrade.com":
            await asyncio.sleep(LAT["finmind"])
            status, body = self._fixture(url)
            self._count(body, url)
            return await route.fulfill(status=status, content_type="application/json", body=body,
                                       headers={"Access-Control-Allow-Origin": "*"})
        self.requests += 1
        return await route.abort("failed")

    def _count(self, body: bytes, url: str, compressible: bool = True):
        self.requests += 1
        self.bytes += len(gzip.compress(body)) if compressible else len(body) // 3   # minified JS 約壓到 1/3


async def measure_legacy(browser, base, net, code="2330", name="台積電"):
    ctx = await browser.new_context(bypass_csp=True)   # 只讓測試工具能 eval；頁面行為不變
    pg = await ctx.new_page()
    await pg.route("**/*", net.handle)
    net.reset()
    t0 = asyncio.get_event_loop().time()
    await pg.goto(base + "legacy/index.html", wait_until="domcontentloaded")
    dcl = asyncio.get_event_loop().time() - t0
    await pg.wait_for_function("document.getElementById('mv-tw').textContent !== '查詢中'", timeout=120_000)
    ready = asyncio.get_event_loop().time() - t0
    load_req, load_bytes = net.requests, net.bytes

    async def lookup():
        net.reset()
        await pg.fill("#search", f"{code} {name}")
        t = asyncio.get_event_loop().time()
        await pg.click("#fetch")
        await pg.wait_for_function("""(() => { const s = document.getElementById('status');
            return s && s.style.display === 'block' && /完成|失敗|錯誤/.test(s.textContent); })()""", timeout=180_000)
        ok = "完成" in await pg.inner_text("#status")
        return asyncio.get_event_loop().time() - t, net.requests, net.bytes, ok

    first = await lookup()
    again = await lookup()
    await ctx.close()
    return {"dcl": dcl, "ready": ready, "load_req": load_req, "load_bytes": load_bytes,
            "lookup": first[0], "lookup_req": first[1], "lookup_bytes": first[2], "ok": first[3],
            "again": again[0], "again_req": again[1]}


async def measure_v6(browser, base, net, code="2330", other="1107"):
    ctx = await browser.new_context(bypass_csp=True)   # 只讓測試工具能 eval；頁面行為不變
    pg = await ctx.new_page()
    await pg.route("**/*", net.handle)
    net.reset()
    t0 = asyncio.get_event_loop().time()
    await pg.goto(base + "index.html", wait_until="domcontentloaded")
    dcl = asyncio.get_event_loop().time() - t0
    await pg.wait_for_function("document.getElementById('watchlist').children.length > 1", timeout=60_000)
    ready = asyncio.get_event_loop().time() - t0
    load_req, load_bytes = net.requests, net.bytes

    async def lookup(c):
        # 先回首頁空白狀態，再量「點選 → 價格出現」與「點選 → 全部完成」
        net.reset()
        t = asyncio.get_event_loop().time()
        await pg.evaluate(f"location.hash = '{c}'")
        await pg.wait_for_function(f"document.querySelector('.stock-head h2')?.textContent.startsWith('{c}')", timeout=60_000)
        first_paint = asyncio.get_event_loop().time() - t
        await pg.wait_for_function("!/載入中/.test(document.querySelector('.completeness summary')?.textContent || '載入中')", timeout=60_000)
        return first_paint, asyncio.get_event_loop().time() - t, net.requests, net.bytes

    w = await lookup(code)
    await lookup(other)                                # 先切走
    again = await lookup(code)                         # 再切回來 → 應該完全走快取
    await pg.evaluate("location.hash = ''")
    live = await lookup("1114")                        # 清單外股票（FinMind 即時查詢，未快取）
    await ctx.close()
    return {"dcl": dcl, "ready": ready, "load_req": load_req, "load_bytes": load_bytes,
            "first_paint": w[0], "lookup": w[1], "lookup_req": w[2], "lookup_bytes": w[3],
            "again": again[1], "again_req": again[2],
            "live_first_paint": live[0], "live": live[1], "live_req": live[2], "live_bytes": live[3]}


def med(rows, key):
    return statistics.median(r[key] for r in rows)


async def main(runs: int, proxy_down: bool):
    tmp = tempfile.TemporaryDirectory()
    site, fx = build(Path(tmp.name))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(site)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}/"
    net = Net(fx, proxy_down)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        legacy = [await measure_legacy(browser, base, net) for _ in range(runs)]
        v6 = [await measure_v6(browser, base, net) for _ in range(runs)]
        await browser.close()
    httpd.shutdown()
    tmp.cleanup()
    out = {"runs": runs, "proxy_down": proxy_down, "latency_s": LAT,
           "legacy": {k: med(legacy, k) for k in legacy[0] if k != "ok"},
           "legacy_success_rate": sum(r["ok"] for r in legacy) / runs,
           "v6": {k: med(v6, k) for k in v6[0]}}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--proxy-down", action="store_true", help="模擬公共 proxy 全部無回應（舊版常見的「所有來源失敗」情境）")
    ap.add_argument("--json", help="結果另存成 JSON 檔")
    a = ap.parse_args()
    res = asyncio.run(main(a.runs, a.proxy_down))
    if a.json:
        Path(a.json).write_text(json.dumps(res, ensure_ascii=False, indent=2))
