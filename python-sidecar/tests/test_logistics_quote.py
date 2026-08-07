from datetime import datetime
import unittest

from tools.logistics_quote import parse_values


class LogisticsQuoteTests(unittest.TestCase):
    def test_normalizes_quote_records(self):
        values = [
            ["提货日期", "调拨单号", "发货地", "目的地", "运输类型", "物流渠道", "物流商", "单价", "渠道计费重（确认计费重）", "总金额", "箱数（以此为准）"],
            [1782864000000, "DB001", "79", "HIA1", "空运", "美通", "美通", "55", "120.5", "6627.5", 4],
        ]
        result = parse_values(values, "大货运费表", now=datetime(2026, 8, 7))
        record = result["records"][0]
        self.assertEqual(result["rows"], 1)
        self.assertEqual(record["pickupDate"], "2026-07-01")
        self.assertEqual(record["unitPrice"], 55)
        self.assertEqual(record["billingWeight"], 120.5)
        self.assertFalse(record["hasComplexRate"])

    def test_preserves_complex_rate_for_review(self):
        values = [
            ["调拨单号", "物流商", "单价", "运费（不含国内税点）", "报关费", "总金额"],
            ["DB002", "九方", "47.5+2.8旺季+燃油", 1000, 300, None],
        ]
        record = parse_values(values, "大货运费表")["records"][0]
        self.assertIsNone(record["unitPrice"])
        self.assertEqual(record["unitPriceText"], "47.5+2.8旺季+燃油")
        self.assertTrue(record["hasComplexRate"])
        self.assertEqual(record["total"], 1300)

    def test_requires_quote_identity_fields(self):
        with self.assertRaisesRegex(ValueError, "缺少必要字段"):
            parse_values([["调拨单号"], ["DB003"]], "错误数据表")


if __name__ == "__main__":
    unittest.main()
