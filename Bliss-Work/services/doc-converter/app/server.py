"""The sandbox's whole HTTP surface: POST /convert and GET /healthz.

Only the artifact (plus kind and duration headers) or a closed-enum error code
ever leaves this process. It listens on an internal-only network and is not
published anywhere.
"""
import json
import os
import shutil
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import config
from .convert import convert
from .errors import ConvertError
from .spec import SPECS

_slots = threading.BoundedSemaphore(config.CONCURRENCY)
_CHUNK = 1024 * 1024


def _log(**fields) -> None:
    # Counts, codes and timings only: never a filename or any document text.
    print(json.dumps(fields, separators=(",", ":")), file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 60  # socket read timeout, so a stalled upload cannot pin a slot

    def log_message(self, *args) -> None:  # noqa: D401 - silence default access log
        pass

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, code: str) -> None:
        err = ConvertError(code)
        self.close_connection = True  # the request body may be unread
        self._send(err.status, json.dumps({"code": code}).encode(), "application/json")

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/healthz":
            self._send(200, b"ok", "text/plain")
        else:
            self._fail(ConvertError.UNSUPPORTED)

    def do_POST(self) -> None:
        url = urlparse(self.path)
        if url.path != "/convert":
            return self._fail(ConvertError.UNSUPPORTED)
        kind = (parse_qs(url.query).get("kind") or [""])[0]
        spec = SPECS.get(kind)
        if spec is None:
            return self._fail(ConvertError.UNSUPPORTED)
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self._fail(ConvertError.UNSUPPORTED)
        if length <= 0:
            return self._fail(ConvertError.UNSUPPORTED)
        if length > config.MAX_INPUT_BYTES:
            return self._fail(ConvertError.TOO_LARGE)
        if not _slots.acquire(blocking=False):
            return self._fail(ConvertError.BUSY)

        started = time.monotonic()
        job_dir = os.path.join(config.JOBS_ROOT, uuid.uuid4().hex)
        code, artifact_kind, data = "ok", "", b""
        try:
            os.makedirs(os.path.join(job_dir, "in"), mode=0o700)
            in_path = os.path.join(job_dir, "in", f"in.{spec.kind}")
            self._read_body(in_path, length)
            artifact_kind, data = convert(spec, job_dir, in_path)
        except ConvertError as e:
            code = e.code
        except Exception:  # noqa: BLE001 - never leak details; a closed code only
            code = ConvertError.INTERNAL
        finally:
            # The input and every intermediate file are destroyed BEFORE anything
            # is sent back, and the slot is freed only once the disk is clean.
            shutil.rmtree(job_dir, ignore_errors=True)
            _slots.release()
        ms = int((time.monotonic() - started) * 1000)
        _log(event="convert", kind=spec.kind, result=code, in_bytes=length, out_bytes=len(data), ms=ms)
        if code != "ok":
            return self._fail(code)
        ctype = "application/pdf" if artifact_kind == "pdf" else "application/json"
        self._send(200, data, ctype, {"X-Preview-Kind": artifact_kind, "X-Preview-Duration-Ms": str(ms)})

    def _read_body(self, path: str, length: int) -> None:
        remaining = length
        with open(path, "wb") as f:
            while remaining:
                chunk = self.rfile.read(min(_CHUNK, remaining))
                if not chunk:
                    raise ConvertError(ConvertError.UNCONVERTIBLE)
                f.write(chunk)
                remaining -= len(chunk)


def sweep_jobs() -> None:
    """Remove anything a previous run (crash, kill, OOM) left behind."""
    os.makedirs(config.JOBS_ROOT, mode=0o700, exist_ok=True)
    for name in os.listdir(config.JOBS_ROOT):
        shutil.rmtree(os.path.join(config.JOBS_ROOT, name), ignore_errors=True)


def serve() -> None:
    sweep_jobs()
    srv = ThreadingHTTPServer(("0.0.0.0", config.PORT), Handler)
    srv.daemon_threads = True
    _log(event="listening", port=config.PORT, concurrency=config.CONCURRENCY)
    srv.serve_forever()
