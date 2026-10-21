"""Unit tests (no DB): FX provider failure behaviour and Cashfree webhook
signature verification — both pure/async-mockable without touching Postgres."""
from __future__ import annotations

import base64
import hashlib
import hmac

import httpx
import pytest


class _FakeResult:
    def __init__(self, row=None):
        self._row = row

    def first(self):
        return self._row


class _FakeDB:
    """Just enough of AsyncSession.execute for app.fx to run against."""

    async def execute(self, *_args, **_kwargs):
        return _FakeResult(None)  # no ttl config row, no cache row


@pytest.mark.asyncio
async def test_fx_raises_on_network_error_no_fallback(monkeypatch):
    from app import fx

    fx._memory_cache.clear()

    class _BoomClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *_a, **_kw):
            raise httpx.ConnectError("boom")

    monkeypatch.setattr(fx.httpx, "AsyncClient", lambda *a, **kw: _BoomClient())

    with pytest.raises(fx.FxUnavailableError):
        await fx.get_usd_rate(_FakeDB(), "INR")


@pytest.mark.asyncio
async def test_fx_raises_on_non_success_result(monkeypatch):
    from app import fx

    fx._memory_cache.clear()

    class _Resp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"result": "error"}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *_a, **_kw):
            return _Resp()

    monkeypatch.setattr(fx.httpx, "AsyncClient", lambda *a, **kw: _Client())

    with pytest.raises(fx.FxUnavailableError):
        await fx.get_usd_rate(_FakeDB(), "INR")


def test_webhook_signature_valid_and_invalid(monkeypatch):
    from app import cashfree
    from app.config import settings

    monkeypatch.setattr(settings, "cashfree_webhook_secret", "my-secret")
    body = b'{"type":"PAYMENT_SUCCESS_WEBHOOK"}'
    ts = "1700000000"
    digest = hmac.new(b"my-secret", ts.encode() + body, hashlib.sha256).digest()
    good_sig = base64.b64encode(digest).decode()

    assert cashfree.verify_webhook_signature(body, ts, good_sig) is True
    assert cashfree.verify_webhook_signature(body, ts, "wrong") is False
    assert cashfree.verify_webhook_signature(body, "", good_sig) is False


def test_webhook_signature_rejected_when_secret_unconfigured(monkeypatch):
    from app import cashfree
    from app.config import settings

    monkeypatch.setattr(settings, "cashfree_webhook_secret", "")
    assert cashfree.verify_webhook_signature(b"{}", "1700000000", "anything") is False
