"""Hostile-document tests that must run INSIDE the converter image.

They drive LibreOffice directly (macro and link canaries need the real
binary), so run them with:

    docker run --rm --tmpfs /tmp:size=512m -v "$PWD/tests:/app/tests:ro" \
        -v "$FIXTURE_DIR:/fx:ro" doc-converter:dev python -m unittest tests.test_inimage -v

Every canary has a POSITIVE CONTROL: the same document run through a LibreOffice
profile that permits the behaviour must trigger it. A test that only shows
"nothing happened" would also pass against a LibreOffice that cannot do the
thing at all.
"""
import http.server
import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest

from app import config
from app.convert import convert
from app.errors import ConvertError
from app.spec import SPECS

from . import builders

HARDENED = "/opt/profile-template"
SECRET = "SECRET-CANARY-0b1f6d"
SECRET_PATH = "/tmp/secret_canary.txt"


def _profile(root: str, name: str, xcu_items: str = "") -> str:
    """A throwaway profile template. Empty items = LibreOffice defaults."""
    d = os.path.join(root, name, "user")
    os.makedirs(d)
    with open(os.path.join(d, "registrymodifications.xcu"), "w") as f:
        f.write(
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<oor:items xmlns:oor="http://openoffice.org/2001/registry" '
            'xmlns:xs="http://www.w3.org/2001/XMLSchema" '
            'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' + xcu_items + "</oor:items>"
        )
    return os.path.join(root, name)


LOW_SECURITY = (
    '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
    '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>0</value></prop></item>'
)


def soffice_direct(profile_template: str, src: str, target: str, outdir: str, infilter: str | None = None) -> None:
    """Run soffice on `src` with a copy of `profile_template` (bypassing the wrapper)."""
    prof = tempfile.mkdtemp(prefix="p-", dir="/tmp")
    shutil.rmtree(prof)
    shutil.copytree(profile_template, prof)
    cmd = [config.SOFFICE, "--headless", "--norestore", "--nolockcheck", "--nologo",
           f"-env:UserInstallation=file://{prof}"]
    if infilter:
        cmd.append(f"--infilter={infilter}")
    cmd += ["--convert-to", target, "--outdir", outdir, src]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    shutil.rmtree(prof, ignore_errors=True)


def run_wrapper(kind: str, data: bytes, template: str) -> tuple[str, bytes]:
    """The real convert() pipeline, with a chosen profile template."""
    old = config.PROFILE_TEMPLATE
    config.PROFILE_TEMPLATE = template
    job = tempfile.mkdtemp(prefix="job-", dir="/tmp")
    try:
        os.makedirs(os.path.join(job, "in"))
        path = os.path.join(job, "in", f"in.{kind}")
        with open(path, "wb") as f:
            f.write(data)
        return convert(SPECS[kind], job, path)
    finally:
        config.PROFILE_TEMPLATE = old
        shutil.rmtree(job, ignore_errors=True)


class Canary:
    """A loopback HTTP server that records every request path it receives."""

    def __init__(self):
        self.hits: list[str] = []
        hits = self.hits

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                hits.append(self.path)
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

            do_HEAD = do_GET  # noqa: N815

            def log_message(self, *a):
                pass

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()


class MacroCanary(unittest.TestCase):
    """A document-bound Basic macro must never run.

    HONEST LIMIT: in this LibreOffice build (Debian trixie, 25.2) no document
    macro could be made to fire even under a deliberately permissive profile
    (see POSITIVE CONTROL below), so "the canary stayed absent" is necessary but
    not sufficient evidence. The sufficient evidence is that the image carries no
    script engine to run one: no Python/JavaScript/BeanShell provider and no Java
    (test_no_script_engines_installed), plus the profile settings in
    profile-template/. All three are kept; none is trusted alone.
    """

    EVENTS = ("dom:load", "office:load", "ooo:onload")

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="mc-", dir="/tmp")
        self.control = _profile(self.root, "control", LOW_SECURITY)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _run(self, template: str, event: str) -> bool:
        canary = os.path.join(self.root, f"ran-{os.path.basename(template)}-{event.replace(':', '_')}")
        src = os.path.join(self.root, f"m-{event.replace(':', '_')}.odt")
        with open(src, "wb") as f:
            f.write(builders.macro_odt(canary, event))
        soffice_direct(template, src, "pdf", self.root)
        return os.path.exists(canary)

    def test_hardened_profile_never_runs_a_document_macro(self):
        for event in self.EVENTS:
            with self.subTest(event=event):
                self.assertFalse(self._run(HARDENED, event), "macro executed under the hardened profile")

    def test_positive_control_status_is_reported(self):
        fired = [e for e in self.EVENTS if self._run(self.control, e)]
        print(f"MACRO POSITIVE CONTROL (permissive profile) fired for: {fired or 'nothing (see class docstring)'}")

    def test_no_script_engines_installed(self):
        out = subprocess.run(["dpkg-query", "-W", "-f=${Package}\\n"], capture_output=True, text=True).stdout.split()
        banned = [p for p in out if p.startswith("libreoffice-script-provider") or p in
                  ("libreoffice-java-common", "default-jre", "default-jre-headless", "python3-uno", "libreoffice-base")
                  or p.startswith("openjdk")]
        self.assertEqual(banned, [])
        self.assertIsNone(shutil.which("java"))


class ExternalResources(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="er-", dir="/tmp")
        self.control = _profile(self.root, "control")  # LibreOffice defaults
        with open(SECRET_PATH, "w") as f:
            f.write(SECRET)
        self.canary = Canary()

    def tearDown(self):
        self.canary.close()
        shutil.rmtree(self.root, ignore_errors=True)
        if os.path.exists(SECRET_PATH):
            os.remove(SECRET_PATH)

    def _url(self, name: str) -> str:
        return f"http://127.0.0.1:{self.canary.port}/{name}"

    def test_odt_linked_image_is_fetched_by_defaults_but_not_by_our_profile(self):
        """The positive control: LibreOffice DOES fetch a linked image under its
        defaults, and our profile stops it."""
        ns = (
            'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
            'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
            'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
            'xmlns:xlink="http://www.w3.org/1999/xlink" '
            'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"'
        )
        body = (
            f'<?xml version="1.0"?><office:document {ns} office:mimetype="application/vnd.oasis.opendocument.text">'
            '<office:body><office:text><text:p>x<draw:frame draw:name="i" text:anchor-type="as-char" '
            'svg:width="2cm" svg:height="2cm"><draw:image '
            f'xlink:href="{self._url("odt.png")}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>'
            "</draw:frame></text:p></office:text></office:body></office:document>"
        )
        src = os.path.join(self.root, "linked.fodt")
        with open(src, "w") as f:
            f.write(body)
        out = os.path.join(self.root, "o")
        os.makedirs(out)
        soffice_direct(self.control, src, "pdf", out)
        self.assertTrue(self.canary.hits, "positive control failed: defaults did not fetch the linked image")
        self.canary.hits.clear()
        soffice_direct(HARDENED, src, "pdf", out)
        self.assertEqual(self.canary.hits, [], "hardened profile fetched a remote linked image")

    def test_remote_image_link_is_not_fetched(self):
        doc = builders.docx_with_links(self._url("img.png"), SECRET_PATH)
        run_wrapper("docx", doc, self.control)
        control_hits = list(self.canary.hits)
        self.canary.hits.clear()
        run_wrapper("docx", doc, HARDENED)
        self.assertEqual(self.canary.hits, [], f"hardened profile fetched {self.canary.hits} (control fetched {control_hits})")
        if not control_hits:
            print("NOTE: LibreOffice defaults do not fetch a linked docx image either; "
                  "network isolation is the control for this vector.")

    def test_formula_functions_cannot_fetch_urls_or_read_local_files(self):
        formulas = (
            f'WEBSERVICE("{self._url("ws")}")',
            f'WEBSERVICE("file://{SECRET_PATH}")',
        )
        doc = builders.xlsx_with_formulas(*formulas)
        _, control_out = run_wrapper("xlsx", doc, self.control)
        control_fetched = list(self.canary.hits)
        control_leaked = SECRET.encode() in control_out
        self.canary.hits.clear()
        _, out = run_wrapper("xlsx", doc, HARDENED)
        print(f"CONTROL (LibreOffice defaults): fetched={control_fetched} leaked_local_file={control_leaked}")
        print(f"HARDENED: fetched={self.canary.hits} leaked_local_file={SECRET.encode() in out}")
        self.assertEqual(self.canary.hits, [], "a formula made a network request")
        self.assertNotIn(SECRET.encode(), out, "a formula embedded a local file's content")

    def test_includetext_field_does_not_embed_a_local_file(self):
        doc = builders.docx_with_links(self._url("img2.png"), SECRET_PATH)
        src = os.path.join(self.root, "in.docx")
        with open(src, "wb") as f:
            f.write(doc)
        out = os.path.join(self.root, "txt")
        os.makedirs(out)
        soffice_direct(HARDENED, src, "txt:Text", out, infilter="MS Word 2007 XML")
        text = open(os.path.join(out, "in.txt"), errors="replace").read()
        self.assertIn("DOCX-LINKS-MARKER", text)
        self.assertNotIn(SECRET, text)


class Hygiene(unittest.TestCase):
    """The real HTTP server, in-process: temp files and processes after every outcome."""

    @classmethod
    def setUpClass(cls):
        from http.server import ThreadingHTTPServer

        from app import server

        cls.jobs = tempfile.mkdtemp(prefix="jobs-", dir="/tmp")
        cls._old = (config.JOBS_ROOT, config.TIMEOUT_SECONDS)
        config.JOBS_ROOT = cls.jobs
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.srv.daemon_threads = True
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        config.JOBS_ROOT, config.TIMEOUT_SECONDS = cls._old
        shutil.rmtree(cls.jobs, ignore_errors=True)

    def _post(self, kind, data):
        from .support import post

        return post(kind, data, base=self.base)

    @staticmethod
    def _soffice_procs() -> list[str]:
        out = []
        for pid in filter(str.isdigit, os.listdir("/proc")):
            try:
                cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace")
            except OSError:
                continue
            if "soffice" in cmd or "oosplash" in cmd:
                out.append(cmd[:80])
        return out

    def _assert_clean(self, label):
        self.assertEqual(os.listdir(self.jobs), [], f"{label}: job files left behind")
        self.assertEqual(self._soffice_procs(), [], f"{label}: LibreOffice process left behind")

    def test_nothing_is_left_after_success_failure_and_timeout(self):
        from .support import code_of

        fx = lambda n: open(f"/fx/{n}", "rb").read()  # noqa: E731
        s, _, _ = self._post("docx", fx("fixture.docx"))
        self.assertEqual(s, 200)
        self._assert_clean("success")

        s, _, b = self._post("doc", bytes.fromhex("D0CF11E0A1B11AE1") + os.urandom(2048))
        self.assertEqual(s, 422)
        self._assert_clean("corrupt input")

        s, _, b = self._post("docx", fx("fixture.doc"))
        self.assertEqual(code_of(b), "unsupported")
        self._assert_clean("rejected before libreoffice")

        config.TIMEOUT_SECONDS = 1
        s, _, b = self._post("pptx", fx("fixture.pptx"))
        config.TIMEOUT_SECONDS = self._old[1]
        self.assertEqual(code_of(b), "timeout")
        self._assert_clean("timeout")

    def test_errors_and_logs_carry_no_document_text(self):
        marker = b"UNIQUE-DOC-TEXT-91c2"
        s, _, body = self._post("docx", builders.docx_with_links("http://127.0.0.1:9/x", "/nonexistent") + marker)
        self.assertNotIn(marker, body)
        self.assertEqual(set(json.loads(body)), {"code"}) if s != 200 else None


if __name__ == "__main__":
    unittest.main()
