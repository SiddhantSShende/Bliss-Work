"""The sandbox's supported kinds must equal the shared extension fixture.

Host-run (stdlib only): the same list is asserted by the app
(lib/attachmentCapability.test.ts) and the server (internal/media/preview_test.go).
"""
import json
import os
import unittest

from app.spec import PDF, SHEETS, SPECS

FIXTURE = os.path.join(os.path.dirname(__file__), "../../../packages/shared/fixtures/office-preview-extensions.json")


class SharedFixture(unittest.TestCase):
    def setUp(self):
        with open(FIXTURE) as f:
            self.fx = json.load(f)

    def test_the_sandbox_supports_exactly_the_listed_kinds(self):
        self.assertEqual(set(SPECS), set(self.fx["preview"]))

    def test_each_kind_produces_the_listed_artifact(self):
        for ext, artifact in self.fx["preview"].items():
            self.assertEqual(SPECS[ext].artifact, PDF if artifact == "pdf" else SHEETS, ext)

    def test_nothing_not_previewable_is_supported(self):
        self.assertFalse(set(self.fx["notPreviewable"]) & set(SPECS))

    def test_every_kind_pins_an_import_filter(self):
        for kind, spec in SPECS.items():
            self.assertTrue(spec.infilter, kind)
            self.assertEqual(spec.kind, kind)


if __name__ == "__main__":
    unittest.main()
