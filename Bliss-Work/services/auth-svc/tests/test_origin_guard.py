"""CSRF Origin/Referer guard (``app.security.origin.request_is_same_origin``).

Contract:
  * no Origin and no Referer            -> allowed (native/desktop/CLI/server)
  * Origin == web_origin                -> allowed
  * localhost / 127.0.0.1 / app:// / file:// / "null" -> allowed (dev + Electron)
  * a present foreign Origin            -> rejected
  * Referer used only when Origin absent

Pure-logic; the web_origin is whatever app.config resolves (defaults to
http://localhost:5173), so the test derives expectations from settings instead
of hard-coding the host. Skips cleanly if deps aren't installed locally.
"""
from __future__ import annotations

import pytest

origin = pytest.importorskip(
    "app.security.origin",
    reason="auth-svc deps (fastapi/pydantic) not installed locally; CI installs requirements.txt.",
)
settings = pytest.importorskip("app.config").settings
same = origin.request_is_same_origin


def test_no_origin_no_referer_allowed():
    assert same(None, None) is True
    assert same("", "") is True


def test_matching_origin_allowed():
    assert same(settings.web_origin, None) is True


@pytest.mark.parametrize(
    "o",
    [
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "https://localhost",
        "app://taskboard",
        "file:///Applications/BlissWork.app",
        "null",
    ],
)
def test_local_and_electron_origins_allowed(o):
    assert same(o, None) is True


@pytest.mark.parametrize(
    "o",
    [
        "https://evil.example.com",
        "http://attacker.test",
        "https://communication.rnrtechs.com.evil.com",  # suffix-confusion attempt
    ],
)
def test_foreign_origin_rejected(o):
    assert same(o, None) is False


def test_referer_used_only_when_origin_absent():
    # Foreign Referer (no Origin) is rejected...
    assert same(None, "https://evil.example.com/login") is False
    # ...but a present good Origin wins regardless of Referer.
    assert same(settings.web_origin, "https://evil.example.com/x") is True
