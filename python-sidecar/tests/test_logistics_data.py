import unittest

from tools.logistics_data import analyze_values


class LogisticsDataTests(unittest.TestCase):
    def test_analysis_uses_field_mapping_and_flags_quality_issues(self):
        values = [
            ["单号", "客户", "状态", "金额", "日期"],
            ["HT001", "A公司", "已完成", 1000, "2026-07-01"],
            ["HT001", "A公司", "运输中", -20, "not-a-date"],
            ["HT003", "", "待处理", "abc", "2026-07-03"],
        ]
        report = analyze_values(values, {
            "tracking": "单号",
            "customer": "客户",
            "status": "状态",
            "amount": "金额",
            "date": "日期",
        }, "测试表")

        self.assertEqual(report["rows"], 3)
        self.assertEqual(report["columnCount"], 5)
        self.assertTrue(any(item["key"] == "customers" for item in report["metrics"]))
        self.assertTrue(any(item["title"] == "单号重复" for item in report["anomalies"]))
        self.assertTrue(any("非数字" in item["title"] for item in report["anomalies"]))
        self.assertTrue(any("日期格式" in item["title"] for item in report["anomalies"]))

    def test_rejects_header_only_data(self):
        with self.assertRaises(ValueError):
            analyze_values([["A", "B"]])


if __name__ == "__main__":
    unittest.main()
