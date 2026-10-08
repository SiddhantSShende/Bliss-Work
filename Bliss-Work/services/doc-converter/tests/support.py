"""Shared helpers for the converter's HTTP-level tests (stdlib only)."""
import http.client
import io
import json
import os
import zipfile
from urllib.parse import urlparse

URL = os.environ.get("CONVERTER_URL", "http://127.0.0.1:19000")
FIXTURES = os.environ.get("FIXTURE_DIR", "/home/ubuntu/scratch/fx")


def post(kind: str, body: bytes, base: str = URL, content_length: int | None = None, timeout: int = 180):
    """POST /convert; returns (status, headers dict, body bytes)."""
    u = urlparse(base)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=timeout)
    try:
        conn.putrequest("POST", f"/convert?kind={kind}")
        conn.putheader("Content-Length", str(len(body) if content_length is None else content_length))
        conn.endheaders()
        if body:
            try:
                conn.send(body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # the server answered (e.g. 413) and closed before reading it all
        r = conn.getresponse()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
    finally:
        conn.close()


def fixture(name: str) -> bytes:
    with open(os.path.join(FIXTURES, name), "rb") as f:
        return f.read()


def code_of(body: bytes) -> str:
    return json.loads(body)["code"]


def zip_bytes(entries: dict[str, bytes], deflate: bool = True) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED if deflate else zipfile.ZIP_STORED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return buf.getvalue()
