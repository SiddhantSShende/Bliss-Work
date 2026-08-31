"""Microsoft Graph adapter — error classification and outbound mail."""

import base64

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


# ── sendMail: the shape of a member's own mail ────────────────────────────────
def _capture_send(monkeypatch) -> dict:
    """Record the /me/sendMail body without touching the network."""
    captured: dict = {}

    async def _fake_request(_token, method, url, **kw):
        captured["method"], captured["url"] = method, url
        captured["json"] = kw.get("json")
        return {}

    monkeypatch.setattr(ms, "_request", _fake_request)
    return captured


@pytest.mark.asyncio
async def test_a_notification_send_is_unchanged(monkeypatch):
    # The pre-existing caller passes only to/subject/body. Its message must stay
    # byte-identical: a plain-text body, one recipient, filed in Sent.
    captured = _capture_send(monkeypatch)
    await ms.send_mail("tok", to="them@outside.test", subject="Hi", body="text")

    assert captured["url"] == "/me/sendMail"
    msg = captured["json"]["message"]
    assert msg["body"] == {"contentType": "Text", "content": "text"}
    assert msg["toRecipients"] == [{"emailAddress": {"address": "them@outside.test"}}]
    assert "ccRecipients" not in msg and "bccRecipients" not in msg
    assert captured["json"]["saveToSentItems"] is True


@pytest.mark.asyncio
async def test_a_blind_copy_is_sent_blind(monkeypatch):
    captured = _capture_send(monkeypatch)
    await ms.send_mail(
        "tok",
        to=["a@outside.test"],
        cc=["b@outside.test"],
        bcc=["secret@outside.test"],
        subject="Q3",
        body="plain",
        html="<p>rich</p>",
    )

    msg = captured["json"]["message"]
    # Graph strips Bcc from the headers every recipient sees, exactly as an MTA
    # does. Folding it into To instead would expose the address to everyone.
    assert msg["bccRecipients"] == [{"emailAddress": {"address": "secret@outside.test"}}]
    assert msg["toRecipients"] == [{"emailAddress": {"address": "a@outside.test"}}]
    assert msg["ccRecipients"] == [{"emailAddress": {"address": "b@outside.test"}}]
    # ONE body: Graph takes a single content, so sending the text of a mail that
    # has an HTML rendering would deliver the version without the formatting.
    assert msg["body"] == {"contentType": "HTML", "content": "<p>rich</p>"}


@pytest.mark.asyncio
async def test_attachments_ride_as_base64_file_attachments(monkeypatch):
    captured = _capture_send(monkeypatch)
    await ms.send_mail(
        "tok", to="a@outside.test", subject="s", body="b",
        attachments=[("deck.pdf", "application/pdf", b"PDF-bytes")],
    )

    att = captured["json"]["message"]["attachments"][0]
    assert att["@odata.type"] == "#microsoft.graph.fileAttachment"
    assert att["name"] == "deck.pdf"
    assert base64.b64decode(att["contentBytes"]) == b"PDF-bytes"


@pytest.mark.asyncio
async def test_a_mail_too_large_to_send_inline_is_refused_not_truncated(monkeypatch):
    # Graph caps the whole /sendMail request at 4 MB and anything larger needs an
    # upload session against a draft. Refusing lets the caller relay the copy
    # over SMTP instead; sending a truncated file would corrupt it silently.
    _capture_send(monkeypatch)
    oversized = b"x" * (ms.MAX_INLINE_ATTACHMENT_BYTES + 1)
    with pytest.raises(ms.MicrosoftError):
        await ms.send_mail(
            "tok", to="a@outside.test", subject="s", body="b",
            attachments=[("big.bin", "application/octet-stream", oversized)],
        )
