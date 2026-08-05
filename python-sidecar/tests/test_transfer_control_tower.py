from datetime import datetime
from io import BytesIO
import unittest

from openpyxl import Workbook

from tools.transfer_control_tower import parse_values, parse_workbook


def workbook_bytes(rows):
    workbook = Workbook()
    worksheet = workbook.active
    for row in rows:
        worksheet.append(row)
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


class TransferControlTowerTests(unittest.TestCase):
    def test_normalizes_records_and_calculates_overdue_state(self):
        data = workbook_bytes([
            ["调拨单号", "箱号（赫特）", "物流商", "提货时间", "预计签收时间", "物流签收时间", "时效要求", "签出-签收时效", "是否异常", "物流跟踪号"],
            ["DB001", "B1", "九方", datetime(2026, 7, 1), datetime(2026, 7, 10), None, 7, None, "否", ""],
            ["DB002", "B2", "德速", datetime(2026, 7, 2), datetime(2026, 7, 12), datetime(2026, 7, 11), 10, 9, "是", "TRACK"],
        ])

        result = parse_workbook(data, "transfer.xlsx", now=datetime(2026, 7, 15))

        self.assertEqual(result["rows"], 2)
        self.assertTrue(result["records"][0]["overdueUnreceived"])
        self.assertEqual(result["records"][0]["overdueDays"], 5)
        self.assertTrue(result["records"][0]["trackingMissing"])
        self.assertTrue(result["records"][1]["ontime"])
        self.assertTrue(result["records"][1]["anomaly"])

    def test_rejects_workbooks_without_required_fields(self):
        data = workbook_bytes([["调拨单号"], ["DB001"]])
        with self.assertRaisesRegex(ValueError, "缺少必要字段"):
            parse_workbook(data, "transfer.xlsx")

    def test_normalizes_feishu_base_matrix_values(self):
        values = [
            ["调拨单号", "箱号（赫特）", "物流商", "提货时间", "一级分类", "时效要求", "签出-签收时效"],
            [
                [{"text": "DB003", "type": "text"}],
                "B3",
                "九方",
                1783296000000,
                [{"text": "假发", "type": "text"}],
                10,
                8,
            ],
        ]

        result = parse_values(values, "调拨时效表", now=datetime(2026, 7, 15))

        self.assertEqual(result["sourceName"], "调拨时效表")
        self.assertEqual(result["records"][0]["order"], "DB003")
        self.assertEqual(result["records"][0]["category"], "假发")
        self.assertTrue(result["records"][0]["ontime"])


if __name__ == "__main__":
    unittest.main()
