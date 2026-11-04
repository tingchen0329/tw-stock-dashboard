"""美股現金流量表：年初至今累計 → 單季；財報期末日對齊日曆季"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import us_data  # noqa: E402


class CashFlow(unittest.TestCase):
    def test_ytd_to_quarters_with_fiscal_year(self):
        # NVDA 類：會計年度 1 月底開始，期末日不在月底
        facts = [
            {"start": "2026-01-26", "end": "2026-04-26", "val": 100},
            {"start": "2026-01-26", "end": "2026-07-26", "val": 250},
            {"start": "2026-01-26", "end": "2026-10-25", "val": 420},
            {"start": "2026-01-26", "end": "2026-07-26", "val": 999},     # 重複申報：取第一筆
            {"start": "2026-04-27", "end": "2026-07-26", "val": 150},     # 單季也申報：與相減結果相同
        ]
        q = us_data.quarterly_from_ytd(facts)
        self.assertEqual(q["2026-03-31"], 100)
        self.assertEqual(q["2026-06-30"], 150)
        self.assertEqual(q["2026-09-30"], 170)

    def test_gaps_that_are_not_a_quarter_are_skipped(self):
        q = us_data.quarterly_from_ytd([
            {"start": "2025-01-01", "end": "2025-06-30", "val": 200},          # 第一筆就是半年 → 無法拆
            {"start": "2025-01-01", "end": "2025-09-30", "val": 330},
        ])
        self.assertEqual(q, {"2025-09-30": 130})

    def test_calendar_quarter_mapping(self):
        self.assertEqual(us_data._calendar_quarter("2026-07-26"), "2026-06-30")
        self.assertEqual(us_data._calendar_quarter("2026-01-25"), "2025-12-31")
        self.assertIsNone(us_data._calendar_quarter("bad"))


if __name__ == "__main__":
    unittest.main()
