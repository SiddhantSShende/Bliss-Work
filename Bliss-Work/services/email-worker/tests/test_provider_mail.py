"""The client that sends a member's mail through their own connected mailbox.

Everything here is about what each outcome MEANS to the caller, because the
three possible answers lead to three different fates for the mail:

  True   — delivered; the relay must not send a second copy.
  False  — not delivered here, send it over SMTP instead.
  raises — nothing happened yet; redeliver the event and try again.

Getting one of them wrong is not a cosmetic bug. A False read as True loses the
mail; a True read as False sends it twice; a permanent refusal read as
transient parks it on the topic forever.
"""
from __future__ import annotations

import httpx
import pytest

from app import provider_mail as pm
from app.resilience import CircuitBreaker


@pytest.fixture(autouse=True)
def _fresh_breaker(monkeypatch):
    """The breaker is module state shared by every caller in the process, so a
    test that trips it would otherwise decide the outcome of the next one."""
    monkeypatch.setattr(pm, "_breaker", CircuitBreaker(fail_max=5, reset_timeout=30.0))


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def _send(client: httpx.AsyncClient, **overrides) -> bool:
    kwargs = {
        "org_id": "org-1",
        "author_id": "user-1",
        "subject": "Q3",
        "text_body": "plain",
        "html_body": "<p>rich</p>",
        "to": ["partner@outside.test"],
        "cc": [],
        "bcc": [],
        "attachments": [],
    }
    kwargs.update(overrides)
    return await pm.send(client, "http://integrations-svc:8005", "tok", **kwargs)


@pytest.mark.asyncio
async def test_a_send_through_the_mailbox_reports_delivered():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["token"] = request.headers.get("X-Internal-Token")
        return httpx.Response(200, json={"status": "sent", "provider": "outlook"})

    async with _client(handler) as c:
        assert await _send(c) is True
    assert seen["url"].endswith("/internal/mail/send")
    # The shared secret, not a user JWT: this path is service-to-service and
    # sends as somebody without holding their session.
    assert seen["token"] == "tok"


@pytest.mark.asyncio
async def test_no_connected_mailbox_is_not_an_error():
    # The common case — most members have connected nothing. Raising here would
    # park every one of their mails on the topic instead of relaying it.
    async with _client(lambda _r: httpx.Response(404, json={"detail": "none"})) as c:
        assert await _send(c) is False


@pytest.mark.asyncio
async def test_an_author_we_do_not_know_is_not_even_asked():
    def handler(_request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("must not call integrations-svc without an author")

    async with _client(handler) as c:
        assert await _send(c, author_id="") is False


@pytest.mark.asyncio
async def test_a_mail_with_no_recipients_is_not_even_asked():
    def handler(_request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("must not send a mail addressed to nobody")

    async with _client(handler) as c:
        assert await _send(c, to=[], cc=[], bcc=[]) is False


@pytest.mark.asyncio
async def test_a_server_fault_is_transient_and_raises():
    # 5xx means the request never got a verdict. Relaying instead would risk a
    # second copy if the provider actually accepted it.
    async with _client(lambda _r: httpx.Response(503)) as c:
        with pytest.raises(pm.ProviderMailUnavailable):
            await _send(c)


@pytest.mark.asyncio
async def test_a_refusal_the_provider_will_repeat_falls_back_to_the_relay():
    # 400 is the message itself being unacceptable — most often attachments too
    # large to send inline. A retry reproduces it exactly; SMTP will not.
    async with _client(lambda _r: httpx.Response(400, json={"detail": "too large"})) as c:
        assert await _send(c) is False


@pytest.mark.asyncio
async def test_an_unreachable_service_is_transient_then_relays(monkeypatch):
    calls = {"n": 0}

    def handler(_request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ConnectError("connection refused")

    # Sized so one send's three attempts exhaust the breaker: the first send
    # still raises (an outage is transient AT FIRST, and the event is
    # redelivered), and the next one finds it open. Two behaviours in one.
    monkeypatch.setattr(pm, "_breaker", CircuitBreaker(fail_max=3, reset_timeout=30.0))

    async with _client(handler) as c:
        with pytest.raises(pm.ProviderMailUnavailable):
            await _send(c)
        before = calls["n"]
        assert await _send(c) is False
        # Fails fast: the open breaker means integrations-svc is not called at
        # all, so a down auxiliary service costs mail nothing but its identity.
        assert calls["n"] == before


@pytest.mark.asyncio
async def test_attachments_are_carried_as_base64():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"status": "sent", "provider": "outlook"})

    async with _client(handler) as c:
        await _send(c, attachments=[("deck.pdf", "application/pdf", b"bytes")])

    att = seen["body"]["attachments"][0]
    assert att["filename"] == "deck.pdf"
    assert att["contentBase64"] == "Ynl0ZXM="
