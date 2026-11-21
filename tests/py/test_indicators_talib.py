"""
技術指標對照 TA-Lib（業界標準實作）：確認 assets/js/analytics.js 算出來的數字正確。

  均線 SMA、指數均線 EMA、RSI（Wilder）、MACD（12, 26, 9）、KD（台股 9, 3, 3）
  台股 KD：K = 2/3·K前 + 1/3·RSV，等同 EMA(α = 1/3) = TA-Lib EMA 週期 5
  → TA-Lib STOCH(fastk=9, slowk=5, slowk_matype=EMA, slowd=5, slowd_matype=EMA)

起始值的設定方式不同（TA-Lib 用前 n 筆平均、台股 KD 從 50 起算），前面幾十筆會有差異、之後會收斂，
所以只比對最後 200 筆。需要 `pip install TA-Lib numpy`（GitHub Actions 會安裝；本機沒裝就跳過）。
"""
from __future__ import annotations

import json
import random
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
try:
    import numpy as np
    import talib
except ImportError:  # pragma: no cover
    talib = None

N = 600
TAIL = 200

NODE = r"""
import { sma, ema, rsi, macd, kd } from './assets/js/analytics.js';
const p = JSON.parse(process.argv[1]);
const m = macd(p.close);
const k = kd(p.high, p.low, p.close);
console.log(JSON.stringify({ sma20: sma(p.close, 20), ema12: ema(p.close, 12), rsi14: rsi(p.close, 14),
  dif: m.dif, dea: m.dea, osc: m.osc, K: k.K, D: k.D }));
"""


def series(seed: int = 42) -> dict:
    r = random.Random(seed)
    close, high, low = [], [], []
    c = 100.0
    for _ in range(N):
        c = max(1.0, c * (1 + r.gauss(0.0003, 0.02)))
        hi, lo = c * (1 + abs(r.gauss(0, 0.01))), c * (1 - abs(r.gauss(0, 0.01)))
        close.append(round(c, 2)), high.append(round(hi, 2)), low.append(round(lo, 2))
    return {"close": close, "high": high, "low": low}


@unittest.skipUnless(talib is not None and shutil.which("node"), "需要 TA-Lib、numpy 與 node")
class IndicatorsMatchTALib(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = series()
        out = subprocess.run(["node", "--input-type=module", "-e", NODE, json.dumps(cls.p)], cwd=ROOT,
                             capture_output=True, text=True, check=True)
        cls.js = json.loads(out.stdout)
        cls.c = np.array(cls.p["close"], dtype=float)
        cls.h = np.array(cls.p["high"], dtype=float)
        cls.lo = np.array(cls.p["low"], dtype=float)

    def same(self, ours, ref, tol=1e-6, name=""):
        ours = np.array([np.nan if v is None else v for v in ours[-TAIL:]], dtype=float)
        ref = np.asarray(ref, dtype=float)[-TAIL:]
        self.assertFalse(np.isnan(ours).any(), f"{name}：最後 {TAIL} 筆不該有缺值")
        np.testing.assert_allclose(ours, ref, rtol=tol, atol=tol, err_msg=name)

    def test_sma_ema(self):
        self.same(self.js["sma20"], talib.SMA(self.c, 20), name="SMA20")
        self.same(self.js["ema12"], talib.EMA(self.c, 12), name="EMA12")

    def test_rsi_wilder(self):
        # RSI 起始值與 TA-Lib 相同（前 14 筆平均），應該整段一致
        self.same(self.js["rsi14"], talib.RSI(self.c, 14), name="RSI14")
        ours = np.array([np.nan if v is None else v for v in self.js["rsi14"]], dtype=float)
        ref = talib.RSI(self.c, 14)
        ok = ~np.isnan(ref) & ~np.isnan(ours)
        np.testing.assert_allclose(ours[ok], ref[ok], rtol=1e-9, atol=1e-9)

    def test_macd(self):
        dif, dea, hist = talib.MACD(self.c, 12, 26, 9)
        self.same(self.js["dif"], dif, name="MACD DIF")
        self.same(self.js["dea"], dea, name="MACD 訊號線")
        self.same(self.js["osc"], hist, name="MACD 柱狀")

    def test_taiwan_kd(self):
        k, d = talib.STOCH(self.h, self.lo, self.c, fastk_period=9, slowk_period=5, slowk_matype=1,
                           slowd_period=5, slowd_matype=1)
        self.same(self.js["K"], k, name="KD 的 K")
        self.same(self.js["D"], d, name="KD 的 D")


if __name__ == "__main__":
    unittest.main()
