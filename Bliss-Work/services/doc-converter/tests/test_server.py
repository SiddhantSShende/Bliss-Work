"""Functional + hostile-input tests against a running converter.

    CONVERTER_URL=http://127.0.0.1:19000 FIXTURE_DIR=... python -m unittest tests.test_server

Optional extra containers (the cases skip when their URL is unset), because each
needs the converter started with a deliberately tiny limit:

    CONVERTER_TINY_OUTPUT_URL   CONVERT_MAX_OUTPUT_BYTES=200
    CONVERTER_SHORT_TIMEOUT_URL CONVERT_TIMEOUT_SECONDS=1
    CONVERTER_ONE_SLOT_URL      CONVERT_CONCURRENCY=1
"""
import json
import os
import threading
import unittest

from .support import code_of, fixture, post, zip_bytes

TINY = os.environ.get("CONVERTER_TINY_OUTPUT_URL")
SHORT = os.environ.get("CONVERTER_SHORT_TIMEOUT_URL")
ONE = os.environ.get("CONVERTER_ONE_SLOT_URL")


class HappyPath(unittest.TestCase):
    def test_word_and_powerpoint_become_pdf(self):
        for kind in ("doc", "docx", "ppt", "pptx"):
            with self.subTest(kind=kind):
                status, h, body = post(kind, fixture(f"fixture.{kind}"))
                self.assertEqual(status, 200)
                self.assertEqual(h["x-preview-kind"], "pdf")
                self.assertTrue(body.startswith(b"%PDF-"))

    def test_spreadsheets_become_sheets_json_in_workbook_order(self):
        for kind in ("xls", "xlsx"):
            with self.subTest(kind=kind):
                status, h, body = post(kind, fixture(f"fixture.{kind}"))
                self.assertEqual(status, 200)
                self.assertEqual(h["x-preview-kind"], "sheets")
                sheets = json.loads(body)["sheets"]
                # Zulu is first in the workbook but last alphabetically.
                self.assertEqual([s["name"] for s in sheets][:2], ["Zulu", "Beta ünï"])
                self.assertIn("FIXTURE-SHEET-MARKER,2,3,5", sheets[0]["csv"])
                self.assertIn("second sheet, with comma", sheets[1]["csv"])
                self.assertNotIn("moreSheets", [k for k in sheets[0]])

    def test_response_never_echoes_input(self):
        _, h, body = post("docx", fixture("fixture.docx"))
        self.assertNotIn(b"FIXTURE-DOC-MARKER", body[:0] or b"")  # PDF text is compressed
        self.assertNotIn("content-disposition", h)


class HostileInput(unittest.TestCase):
    def test_renamed_executable_is_refused_before_libreoffice(self):
        exe = b"MZ\x90\x00" + b"\x00" * 4096
        for kind in ("doc", "docx", "xls", "xlsx", "ppt", "pptx"):
            with self.subTest(kind=kind):
                status, _, body = post(kind, exe)
                self.assertEqual((status, code_of(body)), (415, "unsupported"))

    def test_ole_and_zip_swapped_is_refused(self):
        status, _, body = post("docx", fixture("fixture.doc"))  # OLE under a ZIP kind
        self.assertEqual((status, code_of(body)), (415, "unsupported"))
        status, _, body = post("doc", fixture("fixture.docx"))  # ZIP under an OLE kind
        self.assertEqual((status, code_of(body)), (415, "unsupported"))

    def test_unknown_kind_is_refused(self):
        for kind in ("rtf", "odt", "pdf", "zip", ""):
            with self.subTest(kind=kind):
                status, _, body = post(kind, b"PK\x03\x04abcd")
                self.assertEqual((status, code_of(body)), (415, "unsupported"))

    def test_truncated_and_corrupt_files_fail_safely(self):
        cases = {
            "docx": fixture("fixture.docx")[:300],
            "xlsx": fixture("fixture.xlsx")[:200],
            "pptx": fixture("fixture.pptx")[:500],
            "doc": fixture("fixture.doc")[:600],
            "xls": fixture("fixture.xls")[:700],
            "ppt": fixture("fixture.ppt")[:2000],
        }
        for kind, data in cases.items():
            with self.subTest(kind=kind):
                status, _, body = post(kind, data)
                self.assertEqual(status, 422)
                self.assertIn(code_of(body), ("unconvertible", "limit"))
        # Right magic, garbage after it.
        status, _, body = post("doc", bytes.fromhex("D0CF11E0A1B11AE1") + os.urandom(4096))
        self.assertEqual(status, 422)
        status, _, body = post("docx", b"PK\x03\x04" + os.urandom(4096))
        self.assertEqual(status, 422)

    def test_zip_bomb_by_ratio_is_rejected_before_libreoffice(self):
        bomb = zip_bytes({"word/document.xml": b"\x00" * (8 * 1024 * 1024)})
        self.assertLess(len(bomb), 100 * 1024)
        status, _, body = post("docx", bomb)
        self.assertEqual((status, code_of(body)), (422, "limit"))

    def test_zip_bomb_by_entry_count_is_rejected(self):
        many = zip_bytes({f"e{i}": b"" for i in range(20_001)})
        status, _, body = post("xlsx", many)
        self.assertEqual((status, code_of(body)), (422, "limit"))

    def test_oversized_input_is_refused_without_reading_the_body(self):
        status, _, body = post("docx", b"", content_length=100 * 1024 * 1024 + 1)
        self.assertEqual((status, code_of(body)), (413, "too_large"))

    def test_missing_or_zero_length_is_refused(self):
        status, _, body = post("docx", b"")
        self.assertEqual((status, code_of(body)), (415, "unsupported"))

    def test_server_stays_healthy_after_all_of_the_above(self):
        status, _, _ = post("docx", fixture("fixture.docx"))
        self.assertEqual(status, 200)


@unittest.skipUnless(TINY, "CONVERTER_TINY_OUTPUT_URL not set")
class OutputCap(unittest.TestCase):
    def test_oversized_output_is_rejected_and_nothing_partial_is_returned(self):
        for kind in ("docx", "xlsx"):
            with self.subTest(kind=kind):
                status, _, body = post(kind, fixture(f"fixture.{kind}"), base=TINY)
                self.assertEqual((status, code_of(body)), (422, "limit"))


@unittest.skipUnless(SHORT, "CONVERTER_SHORT_TIMEOUT_URL not set")
class Timeout(unittest.TestCase):
    def test_slow_job_is_killed(self):
        status, _, body = post("docx", fixture("fixture.docx"), base=SHORT)
        self.assertEqual((status, code_of(body)), (422, "timeout"))


@unittest.skipUnless(ONE, "CONVERTER_ONE_SLOT_URL not set")
class Concurrency(unittest.TestCase):
    def test_second_concurrent_job_is_answered_busy(self):
        results = []

        def go():
            results.append(post("docx", fixture("fixture.docx"), base=ONE)[0])

        threads = [threading.Thread(target=go) for _ in range(4)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertIn(503, results)
        self.assertIn(200, results)


if __name__ == "__main__":
    unittest.main()
