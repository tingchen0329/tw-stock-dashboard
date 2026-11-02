"""美股選股（scripts/us_screen.py）：季別、第四季推算、指標計算"""
from __future__ import annotations

import datetime as dt
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import us_screen as us  # noqa: E402


class UsScreen(unittest.TestCase):
    def test_quarters_back_starts_at_last_completed_quarter(self):
        self.assertEqual(us.quarters_back(dt.date(2026, 11, 3), 3), [(2026, 3), (2026, 2), (2026, 1)])
        self.assertEqual(us.quarters_back(dt.date(2026, 2, 1), 2), [(2025, 4), (2025, 3)])

    def test_universe_symbols_use_dash(self):
        u = us.load_universe("Symbol,Security,GICS Sector,CIK\nBRK.B,Berkshire,Financials,1067983\n")
        self.assertEqual(u, {"BRK-B": {"name": "Berkshire", "sector": "Financials", "cik": 1067983}})

    def test_q4_derived_from_annual(self):
        qs = us.quarters_back(dt.date(2026, 2, 1), 5)        # 2025Q4..2024Q4
        q = us.build_quarterly({"CY2025Q1": {1: 10}, "CY2025Q2": {1: 20}, "CY2025Q3": {1: 30}, "CY2025": {1: 100}}, qs)
        self.assertEqual(q[1][(2025, 4)], 40)

    def test_metrics_yoy_ttm_and_roe(self):
        qs = us.quarters_back(dt.date(2026, 10, 1), 9)       # 2026Q3..2024Q3
        rev = {k: 100.0 for k in qs}
        rev[qs[0]] = 120.0                                    # 最新一季 +20%
        eps = {k: 1.0 for k in qs}
        ni = {k: 10.0 for k in qs}
        m = us.metrics({"rev": rev, "ni": ni, "eps": eps}, qs, equity=200.0)
        self.assertEqual(m["period"], "2026Q3")
        self.assertEqual(m["revYoY"], 20.0)
        self.assertEqual(m["epsTTM"], 4.0)
        self.assertEqual(m["roe"], 20.0)                      # 近四季淨利 40 ÷ 權益 200
        self.assertAlmostEqual(m["netMargin"], 8.33, places=2)

    def test_missing_quarter_gives_none_not_zero(self):
        qs = us.quarters_back(dt.date(2026, 10, 1), 9)
        m = us.metrics({"rev": {qs[0]: 100.0}, "eps": {qs[0]: 1.0}, "ni": {}}, qs, None)
        self.assertIsNone(m["revYoY"])
        self.assertIsNone(m["epsTTM"])
        self.assertIsNone(m["roe"])


if __name__ == "__main__":
    unittest.main()
