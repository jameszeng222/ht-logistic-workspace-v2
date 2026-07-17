from io import BytesIO
import unittest

from openpyxl import Workbook

from tools.data_analysis import export_data, preview_excel_data


def workbook_bytes(rows):
    workbook = Workbook()
    worksheet = workbook.active
    for row in rows:
        worksheet.append(row)
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


class DataAnalysisPreviewTests(unittest.TestCase):
    def test_preview_reports_template_matches_and_missing_fields(self):
        source = workbook_bytes([
            ["Order", "Amount"],
            [1001, 120],
            [1002, None],
        ])
        template = workbook_bytes([["Order", "Amount", "Customer"]])

        preview = preview_excel_data(source, "source.xlsx", template_data=template)

        self.assertEqual(preview["shape"], [2, 2])
        self.assertEqual(preview["template_match"]["matched"], ["Order", "Amount"])
        self.assertEqual(preview["template_match"]["missing"], ["Customer"])
        self.assertEqual(preview["template_match"]["match_rate"], 66.67)

    def test_export_keeps_template_and_writes_matching_columns(self):
        source = workbook_bytes([
            ["Order", "Amount"],
            [1001, 120],
        ])
        template = workbook_bytes([["Order", "Amount", "Customer"]])

        result = export_data(source, "source.xlsx", template_data=template)

        self.assertGreater(len(result), 1000)


if __name__ == "__main__":
    unittest.main()
