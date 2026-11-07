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


class Form4(unittest.TestCase):
    XML = """<?xml version="1.0"?><ownershipDocument><aff10b5One>1</aff10b5One>
      <reportingOwner><reportingOwnerId><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId>
        <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>CEO</officerTitle></reportingOwnerRelationship></reportingOwner>
      <nonDerivativeTable><nonDerivativeTransaction>
        <transactionDate><value>2026-10-01</value></transactionDate>
        <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
        <transactionAmounts><transactionShares><value>1,500</value></transactionShares>
          <transactionPricePerShare><value>12.5</value></transactionPricePerShare>
          <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
        <postTransactionAmounts><sharesOwnedFollowingTransaction><value>9000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      </nonDerivativeTransaction>
      <nonDerivativeTransaction><transactionAmounts><transactionShares><value>0</value></transactionShares></transactionAmounts></nonDerivativeTransaction>
      </nonDerivativeTable></ownershipDocument>"""

    def test_parse(self):
        t = us_data.parse_form4(self.XML)
        self.assertEqual(len(t), 1)                      # 0 股的列略過
        self.assertEqual(t[0], {"date": "2026-10-01", "owner": "Doe Jane", "role": "CEO, Director", "code": "S",
                                "shares": 1500.0, "price": 12.5, "ad": "D", "after": 9000.0, "plan": True})
        self.assertEqual(us_data.parse_form4("<not xml"), [])

    def test_fetch_uses_cache_and_raw_xml(self):
        import datetime as dt

        class Tx:
            def __init__(self):
                self.texts = []

            def get_json(self, url, params=None, kind="public"):
                return {"filings": {"recent": {
                    "form": ["4", "4", "10-Q", "4"], "accessionNumber": ["a-1", "a-2", "a-3", "a-old"],
                    "filingDate": ["2026-10-02", "2026-09-01", "2026-08-01", "2025-01-01"],
                    "primaryDocument": ["xslF345X05/f1.xml", "f2.xml", "q.htm", "f0.xml"]}}}

            def get_text(self, url, kind="public"):
                self.texts.append(url)
                return Form4.XML

        tx = Tx()
        r = us_data.fetch_insider(tx, 123, {"filings": {"a-2": {"filed": "2026-09-01", "tx": []}}}, dt.date(2026, 10, 19))
        self.assertEqual(sorted(r["filings"]), ["a-1", "a-2"])          # 10-Q 與 6 個月前的略過
        self.assertEqual(tx.texts, ["https://www.sec.gov/Archives/edgar/data/123/a1/f1.xml"])   # 只抓新的；去掉 XSL 前綴
