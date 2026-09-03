"""Each provider's outbound-send call must attempt exactly once on a
ReadTimeout — not silently retry into a duplicate real email/chat message.

Unlike services/shared/resilience/tests/test_resilience.py (which exercises
retry_async directly), these tests go through the real provider functions
end-to-end against a mocked transport, so a regression that drops the
idempotent=False flag at any call site — not just a bug in retry_async
itself — is caught.
"""
from __future__ import annotations

import httpx
import pytest

from app.providers import gmail, microsoft, slack
from resilience import CircuitBreaker


@pytest.fixture(autouse=True)
def _fresh_breakers(monkeypatch):
    # gmail/microsoft/slack each keep one CircuitBreaker as a module-level
    # singleton (by design — one per dependency per process). That means
    # consecutive tests in this file share breaker state unless reset: a
    # prior test's failures could tip the breaker OPEN and turn this test's
    # expected ReadTimeout into a misleading CircuitOpenError.
    monkeypatch.setattr(gmail, "_gmail_breaker", CircuitBreaker(fail_max=5, reset_timeout=30.0, name="gmail"))
    monkeypatch.setattr(microsoft, "_ms_breaker", CircuitBreaker(fail_max=5, reset_timeout=30.0, name="microsoft"))
    monkeypatch.setattr(slack, "_slack_breaker", CircuitBreaker(fail_max=5, reset_timeout=30.0, name="slack"))


class _TimeoutOnEveryCall:
    """Mock transport handler: always raises ReadTimeout, counts attempts."""

    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        raise httpx.ReadTimeout("simulated timeout after the request was sent", request=request)


@pytest.fixture
def mock_async_client(monkeypatch):
    """Routes every httpx.AsyncClient(...) construction in app.providers.* to
    a MockTransport, so no real network call is made."""
    handler = _TimeoutOnEveryCall()
    transport = httpx.MockTransport(handler)
    real_client_cls = httpx.AsyncClient

    def _patched(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client_cls(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", _patched)
    return handler


async def test_gmail_send_message_attempts_exactly_once_on_read_timeout(mock_async_client):
    with pytest.raises(httpx.ReadTimeout):
        await gmail.send_message("tok", "cmF3")
    assert mock_async_client.calls == 1


async def test_microsoft_send_mail_attempts_exactly_once_on_read_timeout(mock_async_client):
    with pytest.raises(httpx.ReadTimeout):
        await microsoft.send_mail(
            "tok", to="a@example.com", subject="Hi", body="hello"
        )
    assert mock_async_client.calls == 1


async def test_microsoft_send_chat_message_attempts_exactly_once_on_read_timeout(mock_async_client):
    with pytest.raises(httpx.ReadTimeout):
        await microsoft.send_chat_message("tok", "chat-1", "hello")
    assert mock_async_client.calls == 1


async def test_slack_post_message_attempts_exactly_once_on_read_timeout(mock_async_client):
    with pytest.raises(httpx.ReadTimeout):
        await slack.post_message("bot-tok", "C123", "hello")
    assert mock_async_client.calls == 1


# ── positive control: a read (not a send) still gets the full retry budget ──────
async def test_slack_auth_test_still_retries_a_read_timeout(mock_async_client):
    # auth_test() is idempotent (no side effect) — it must still retry, or
    # this whole test file would pass even if idempotent=False leaked onto
    # every call by accident.
    with pytest.raises(httpx.ReadTimeout):
        await slack.auth_test("tok")
    assert mock_async_client.calls == 3
