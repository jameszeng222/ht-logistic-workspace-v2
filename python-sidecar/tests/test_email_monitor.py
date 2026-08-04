import unittest
from email.message import EmailMessage

from tools.email_monitor import analyze_message, text_from_message


class EmailMonitorTests(unittest.TestCase):
    def make_message(self, subject: str, body: str) -> bytes:
        message = EmailMessage()
        message["From"] = "cn.canbl@dhl.com"
        message["To"] = "cs.logistics@hotbeautyhair.com"
        message["Subject"] = subject
        message["Date"] = "Mon, 03 Aug 2026 10:20:00 +0800"
        message.set_content(body)
        return message.as_bytes()

    def test_extracts_dhl_reference_tracking_and_action(self):
        raw = self.make_message(
            "<< Ref:392313959 >> WB 3799069315 德国清关请协助补充资料",
            "DHL 清关需要补充物品描述和收件人联系方式，请在 2026-08-06 前处理。",
        )
        result = analyze_message(raw, "cs.logistics@hotbeautyhair.com", 81432)

        self.assertEqual(result["reference"], "392313959")
        self.assertEqual(result["tracking"], "3799069315")
        self.assertEqual(result["status"], "待处理")
        self.assertTrue(result["attention"])
        self.assertEqual(result["deadline"], "2026-08-06")

    def test_completed_message_is_not_attention(self):
        raw = self.make_message("DHL customs clearance completed", "The shipment has been delivered and case closed.")
        result = analyze_message(raw, "logistics@hotbeautyhair.com", 90001)

        self.assertEqual(result["status"], "已完成")
        self.assertFalse(result["attention"])

    def test_prefers_plain_text(self):
        message = EmailMessage()
        message.set_content("plain body")
        message.add_alternative("<b>html body</b>", subtype="html")
        self.assertEqual(text_from_message(message), "plain body")


if __name__ == "__main__":
    unittest.main()
