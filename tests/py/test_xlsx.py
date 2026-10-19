"""
用 Python openpyxl 開啟網頁產生的 .xlsx，確認自製的 xlsx 寫入器輸出是 Excel 能讀的真檔案。
需要 node 與 openpyxl；缺任一個就略過（CI 會安裝 openpyxl）。
"""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

try:
    import openpyxl
except ImportError:  # pragma: no cover
    openpyxl = None

SCRIPT = """
import { toXLSX } from '%s';
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], toXLSX([
  { name: '摘要', rows: [['項目', '數值', '備註'], ['股價', 1450.5, '證交所'], ['名稱', '<台積電> & "測試"', null]] },
  { name: '月營收', rows: [['月份', '營收'], ['2026-09', 168420000000]] },
]));
"""


@unittest.skipUnless(openpyxl and shutil.which("node"), "需要 openpyxl 與 node")
class XlsxRoundTrip(unittest.TestCase):
    def test_openpyxl_reads_generated_file(self):
        with tempfile.TemporaryDirectory() as d:
            js = Path(d) / "gen.mjs"
            js.write_text(SCRIPT % (ROOT / "assets/js/export.js").as_uri())
            out = Path(d) / "t.xlsx"
            subprocess.run(["node", str(js), str(out)], check=True)
            wb = openpyxl.load_workbook(out)
            self.assertEqual(wb.sheetnames, ["摘要", "月營收"])
            ws = wb["摘要"]
            self.assertEqual(ws["A1"].value, "項目")
            self.assertTrue(ws["A1"].font.bold)
            self.assertEqual(ws["B2"].value, 1450.5)                    # 數字仍是數字，可以計算
            self.assertEqual(ws["B3"].value, '<台積電> & "測試"')      # 特殊字元正確跳脫
            self.assertEqual(wb["月營收"]["B2"].value, 168420000000)


if __name__ == "__main__":
    unittest.main()
