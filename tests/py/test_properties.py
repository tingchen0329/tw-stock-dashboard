"""
性質測試（Hypothesis）：自動產生大量隨機輸入，檢查「一定要成立」的規則，找出手寫測試沒想到的邊界情況。
需要 `pip install hypothesis`（GitHub Actions 會安裝；本機沒裝就跳過）。
"""
from __future__ import annotations

import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import fetch_data as fd  # noqa: E402
import us_data  # noqa: E402

try:
    from hypothesis import given, settings, strategies as st
except ImportError:  # pragma: no cover
    given = None

QUARTER_ENDS = ((3, 31), (6, 30), (9, 30), (12, 31))

if given:
    money = st.integers(min_value=-10**9, max_value=10**9)

    many = settings(max_examples=300, deadline=None)

    class Props(unittest.TestCase):
        @given(st.integers(2015, 2030), st.integers(0, 3), st.integers(-20, 20),
               st.lists(money, min_size=1, max_size=4))
        @many
        def test_ytd_to_quarters_roundtrip(self, year, q0, shift, quarters):
            """美股現金流量表：單季值 → 年初累計 → 拆回單季，要等於原本的數字（會計年度可偏離日曆季 ±20 天）"""
            m, d = QUARTER_ENDS[q0]
            start = dt.date(year, m, d) + dt.timedelta(days=1 + shift)      # 會計年度起點
            facts, cum, ends = [], 0, []
            for k, v in enumerate(quarters):
                end = start + dt.timedelta(days=91 * (k + 1) - 1)
                cum += v
                facts.append({"start": start.isoformat(), "end": end.isoformat(), "val": cum})
                ends.append(end)
            out = us_data.quarterly_from_ytd(facts)
            expected = {us_data._calendar_quarter(e.isoformat()): v for e, v in zip(ends, quarters)}
            self.assertEqual(out, expected)

        @given(st.dates(dt.date(1990, 1, 1), dt.date(2100, 12, 31)))
        @many
        def test_calendar_quarter_is_nearest_quarter_end(self, d):
            q = us_data._calendar_quarter(d.isoformat())
            self.assertIsNotNone(q)                         # 任何日期離最近的季末都不超過 46 天
            qd = dt.date.fromisoformat(q)
            self.assertIn((qd.month, qd.day), QUARTER_ENDS)
            self.assertLessEqual(abs((qd - d).days), 46)

        @given(st.lists(st.tuples(st.dates(dt.date(1995, 1, 1), dt.date(2099, 12, 28)),
                                  st.decimals(min_value=1, max_value=999999, places=2)), max_size=30))
        @many
        def test_mfi94u_roundtrip(self, rows):
            """證交所民國日期、千分位數字 → 西元日期、數值"""
            payload = {"data": [[f"{d.year - 1911}/{d.month:02d}/{d.day:02d}", f"{v:,.2f}"] for d, v in rows]}
            got = fd.parse_mfi94u(payload)
            want = {}
            for d, v in rows:
                want[d.isoformat()] = float(v)
            self.assertEqual(got, want)

        @given(st.text(max_size=400))
        @many
        def test_form4_parser_never_crashes(self, text):
            """SEC Form 4 若回傳錯誤頁或格式改版，只會得到空清單，不會讓整個更新失敗"""
            self.assertIsInstance(us_data.parse_form4(text), list)

        @given(st.floats(min_value=-1e12, max_value=1e12, allow_nan=False).map(lambda x: round(x, 2)))
        @many
        def test_to_num_thousands_separator(self, v):
            self.assertAlmostEqual(fd.to_num(f"{v:,.2f}"), v, places=2)
else:  # pragma: no cover
    class Props(unittest.TestCase):
        @unittest.skip("需要 hypothesis")
        def test_skipped(self):
            pass


if __name__ == "__main__":
    unittest.main()
