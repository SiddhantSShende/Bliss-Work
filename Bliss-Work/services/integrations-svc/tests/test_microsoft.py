"""Microsoft Graph adapter — error classification and Teams chat."""

import httpx
import pytest

from app.providers import microsoft as ms


def _resp(status: int, body: dict | None = None, headers: dict | None = None) -> httpx.Response:
    return httpx.Response(
        status_code=status,
        json=body if body is not None else {},
        headers=headers or {},
        request=httpx.Request("GET", "https://graph.microsoft.com/v1.0/me"),
    )


# ── error classification ──────────────────────────────────────────────────────
def test_401_is_auth_not_a_dead_connection():
    with pytest.raises(ms.MicrosoftAuthError):
        ms._raise_for_status(_resp(401, {"error": {"message": "InvalidAuthenticationToken"}}))


@pytest.mark.parametrize("status", [429, 503, 504])
def test_throttling_and_load_shedding_are_retryable(status):
    # Graph sheds load with 503/504 + Retry-After. Treating those as definitive
    # would drop the sweep instead of pausing it.
    with pytest.raises(ms.MicrosoftRateLimited) as ei:
        ms._raise_for_status(_resp(status, {"error": {"message": "busy"}}, {"Retry-After": "120"}))
    assert ei.value.retry_after == 120.0


def test_non_numeric_retry_after_is_ignored_not_crashed():
    # Graph occasionally sends an HTTP-date here. We can't parse it usefully, so
    # fall back to our own backoff rather than raising inside the error handler.
    with pytest.raises(ms.MicrosoftRateLimited) as ei:
        ms._raise_for_status(_resp(429, {}, {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}))
    assert ei.value.retry_after is None


@pytest.mark.parametrize("status", [400, 403, 404, 500])
def test_other_errors_are_definitive(status):
    with pytest.raises(ms.MicrosoftError) as ei:
        ms._raise_for_status(_resp(status, {"error": {"message": "nope"}}))
    assert not isinstance(ei.value, ms.MicrosoftRateLimited)


def test_success_does_not_raise():
    ms._raise_for_status(_resp(200, {"value": []}))


@pytest.mark.parametrize(
    "status,headers",
    [(504, {}), (504, {"Retry-After": "30"}), (503, {})],
)
def test_non_idempotent_send_gateway_errors_are_ambiguous(status, headers):
    with pytest.raises(ms.MicrosoftAmbiguousDelivery):
        ms._raise_for_status(
            _resp(status, {"error": {"message": "gateway timeout"}}, headers),
            ambiguous_delivery=True,
        )


def test_503_with_retry_after_remains_explicitly_retryable_for_send():
    with pytest.raises(ms.MicrosoftRateLimited) as ei:
        ms._raise_for_status(
            _resp(503, {"error": {"message": "busy"}}, {"Retry-After": "30"}),
            ambiguous_delivery=True,
        )
    assert ei.value.retry_after == 30.0


@pytest.mark.asyncio
async def test_chat_id_is_encoded_as_one_graph_path_segment(monkeypatch):
    captured = {}

    async def _fake_request(_token, method, url, **kw):
        captured["method"], captured["url"] = method, url
        return {"id": "m1"}

    monkeypatch.setattr(ms, "_request", _fake_request)
    await ms.send_chat_message("tok", "team/a?x=1#fragment", "hello")
    assert captured["url"] == "/chats/team%2Fa%3Fx%3D1%23fragment/messages"


@pytest.mark.asyncio
async def test_dot_segment_chat_id_is_rejected_before_request(monkeypatch):
    request_called = False

    async def _fake_request(*_args, **_kwargs):
        nonlocal request_called
        request_called = True
        return {}

    monkeypatch.setattr(ms, "_request", _fake_request)
    with pytest.raises(ms.MicrosoftError, match="invalid Teams chat id"):
        await ms.send_chat_message("tok", "..", "hello")
    assert request_called is False
