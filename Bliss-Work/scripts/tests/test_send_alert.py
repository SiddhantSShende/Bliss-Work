import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


SCRIPT = Path(__file__).resolve().parents[1] / "send-alert.py"
SPEC = importlib.util.spec_from_file_location("send_alert", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
send_alert = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(send_alert)


class SendAlertSmtpTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(
            os.environ,
            {
                "SMTP_HOST": "smtp.example.test",
                "SMTP_USERNAME": "alerts",
                "SMTP_PASSWORD": "secret",
                "SMTP_FROM": "alerts@example.test",
                "SUBJECT": "test",
                "BODY": "test body",
            },
            clear=True,
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        self.smtp = MagicMock()
        self.smtp.__enter__.return_value = self.smtp

    @patch("smtplib.SMTP")
    @patch("smtplib.SMTP_SSL")
    def test_port_465_uses_tls_from_connect_and_never_starttls(self, smtp_ssl, smtp):
        smtp_ssl.return_value = self.smtp
        with patch.dict(os.environ, {"SMTP_PORT": "465"}):
            self.assertEqual(send_alert.main(), 0)

        smtp_ssl.assert_called_once_with("smtp.example.test", 465, timeout=30)
        smtp.assert_not_called()
        self.smtp.starttls.assert_not_called()
        self.smtp.login.assert_called_once_with("alerts", "secret")

    @patch("smtplib.SMTP")
    @patch("smtplib.SMTP_SSL")
    def test_submission_port_uses_starttls_by_default(self, smtp_ssl, smtp):
        smtp.return_value = self.smtp
        with patch.dict(os.environ, {"SMTP_PORT": "587"}):
            self.assertEqual(send_alert.main(), 0)

        smtp.assert_called_once_with("smtp.example.test", 587, timeout=30)
        smtp_ssl.assert_not_called()
        self.smtp.starttls.assert_called_once()


if __name__ == "__main__":
    unittest.main()
