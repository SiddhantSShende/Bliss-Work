"""Microsoft Graph adapter — error classification and outbound mail."""

import base64

import httpx
import pytest

from app.providers import microsoft as ms
from resilience import CircuitBreaker


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


@pytest.mark.parametrize("status,headers", [(503, {}), (504, {}), (504, {"Retry-After": "30"})])
async def test_send_mail_classifies_ambiguous_graph_status_without_retry(
    monkeypatch, status, headers
):
    class _FakeClient:
        calls = 0

        async def request(self, *_args, **_kwargs):
            self.calls += 1
            return _resp(status, {"error": {"message": "gateway failure"}}, headers)

    client = _FakeClient()
    monkeypatch.setattr(ms.httpclient, "shared", lambda: client)
    monkeypatch.setattr(
        ms, "_ms_breaker", CircuitBreaker(fail_max=5, reset_timeout=30.0, name="microsoft-test")
    )
    with pytest.raises(ms.MicrosoftAmbiguousDelivery):
        await ms.send_mail("tok", to="a@example.com", subject="s", body="b")
    assert client.calls == 1


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


# ── send_mail: draft-then-send, the shape of a member's own mail ─────────────
def _capture_send(monkeypatch, *, draft: dict | None = None) -> list[dict]:
    """Record every _request call send_mail makes, without touching the network.

    send_mail is now draft-then-send (see its docstring): call 0 creates the
    draft (and its return value is what send_mail reads graph_id/
    internetMessageId off of), call 1 sends it, and an optional call 2 deletes
    the Sent copy when save_to_sent_items=False.
    """
    calls: list[dict] = []
    draft = draft if draft is not None else {"id": "msg-1", "internetMessageId": "<abc@graph>"}

    async def _fake_request(_token, method, url, **kw):
        calls.append({"method": method, "url": url, "json": kw.get("json")})
        return draft if len(calls) == 1 else {}

    monkeypatch.setattr(ms, "_request", _fake_request)
    return calls


@pytest.mark.asyncio
async def test_a_notification_send_is_unchanged(monkeypatch):
    # The pre-existing caller passes only to/subject/body. Its message must stay
    # byte-identical: a plain-text body, one recipient, filed in Sent.
    calls = _capture_send(monkeypatch)
    graph_id, internet_message_id = await ms.send_mail(
        "tok", to="them@outside.test", subject="Hi", body="text"
    )

    assert calls[0]["method"] == "POST"
    assert calls[0]["url"] == "/me/messages"
    msg = calls[0]["json"]
    assert msg["body"] == {"contentType": "Text", "content": "text"}
    assert msg["toRecipients"] == [{"emailAddress": {"address": "them@outside.test"}}]
    assert "ccRecipients" not in msg and "bccRecipients" not in msg
    assert msg["isDraft"] is True

    assert calls[1]["method"] == "POST"
    assert calls[1]["url"] == "/me/messages/msg-1/send"
    assert len(calls) == 2  # no clean-up delete: save_to_sent_items defaults True

    assert graph_id == "msg-1"
    assert internet_message_id == "<abc@graph>"


@pytest.mark.asyncio
async def test_a_blind_copy_is_sent_blind(monkeypatch):
    calls = _capture_send(monkeypatch)
    await ms.send_mail(
        "tok",
        to=["a@outside.test"],
        cc=["b@outside.test"],
        bcc=["secret@outside.test"],
        subject="Q3",
        body="plain",
        html="<p>rich</p>",
    )

    msg = calls[0]["json"]
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
    calls = _capture_send(monkeypatch)
    await ms.send_mail(
        "tok", to="a@outside.test", subject="s", body="b",
        attachments=[("deck.pdf", "application/pdf", b"PDF-bytes")],
    )

    att = calls[0]["json"]["attachments"][0]
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


@pytest.mark.asyncio
async def test_save_to_sent_items_false_deletes_the_sent_copy_best_effort(monkeypatch):
    calls = _capture_send(monkeypatch)
    await ms.send_mail(
        "tok", to="a@outside.test", subject="s", body="b", save_to_sent_items=False
    )
    assert len(calls) == 3
    assert calls[2] == {"method": "DELETE", "url": "/me/messages/msg-1", "json": None}


@pytest.mark.asyncio
async def test_save_to_sent_items_false_cleanup_failure_does_not_raise(monkeypatch):
    # The mail is already sent by this point — a failed clean-up is cosmetic
    # (an unwanted Sent-folder row), never surfaced as a send failure.
    calls: list[dict] = []

    async def _fake_request(_token, method, url, **kw):
        calls.append(url)
        if method == "DELETE":
            raise ms.MicrosoftError("404: not found")
        return {"id": "msg-1", "internetMessageId": "<x@graph>"} if len(calls) == 1 else {}

    monkeypatch.setattr(ms, "_request", _fake_request)
    graph_id, internet_message_id = await ms.send_mail(
        "tok", to="a@outside.test", subject="s", body="b", save_to_sent_items=False
    )
    assert graph_id == "msg-1"
    assert internet_message_id == "<x@graph>"


# ── subscriptions, delta paging, write-back ───────────────────────────────────
def test_subscription_expiry_formats_graph_iso8601():
    fixed_now = ms.datetime(2026, 1, 1, tzinfo=ms.timezone.utc)
    assert ms.subscription_expiry(60, now=fixed_now) == "2026-01-01T01:00:00.0000000Z"


def test_verify_client_state_fails_closed_on_missing():
    assert ms.verify_client_state("secret", "secret") is True
    assert ms.verify_client_state("secret", "wrong") is False
    assert ms.verify_client_state("secret", None) is False
    assert ms.verify_client_state("", "secret") is False


@pytest.mark.asyncio
async def test_walk_delta_refuses_to_return_a_cursor_from_a_half_walked_page(monkeypatch):
    # A page with ONLY @odata.nextLink (no deltaLink anywhere) must not yield
    # a cursor — persisting one here silently skips every message after it.
    # max_pages=1 bounds the walk to exactly this one still-incomplete page,
    # the same outcome a mailbox too large to finish in one sweep produces.
    async def _fake_request(_token, _method, _url, **_kw):
        return {"value": [{"id": "1"}], "@odata.nextLink": "https://graph/page2"}

    monkeypatch.setattr(ms, "_request", _fake_request)
    items, delta_link = await ms.walk_delta(
        "tok", "/me/mailFolders('inbox')/messages/delta", max_pages=1
    )
    assert delta_link is None
    assert len(items) == 1


@pytest.mark.asyncio
async def test_walk_delta_follows_nextlink_then_returns_the_deltalink(monkeypatch):
    pages = [
        {"value": [{"id": "1"}], "@odata.nextLink": "https://graph/page2"},
        {"value": [{"id": "2"}], "@odata.deltaLink": "https://graph/delta-cursor"},
    ]
    seen_urls = []

    async def _fake_request(_token, _method, url, **_kw):
        seen_urls.append(url)
        return pages.pop(0)

    monkeypatch.setattr(ms, "_request", _fake_request)
    items, delta_link = await ms.walk_delta("tok", "/me/mailFolders('inbox')/messages/delta")
    assert delta_link == "https://graph/delta-cursor"
    assert [i["id"] for i in items] == ["1", "2"]
    assert seen_urls[1] == "https://graph/page2"  # absolute nextLink passed straight through


def test_inbox_and_sentitems_delta_urls_are_distinct_folders():
    assert "mailFolders('inbox')" in ms.inbox_delta_url()
    assert "mailFolders('sentitems')" in ms.sentitems_delta_url()
    assert ms.inbox_delta_url() != ms.sentitems_delta_url()


def test_addresses_of_lowercases_and_handles_missing_collections():
    msg = {
        "from": {"emailAddress": {"address": "Sender@Example.com"}},
        "toRecipients": [{"emailAddress": {"address": "To@Example.com"}}],
        # ccRecipients deliberately omitted — Graph drops empty collections.
    }
    sender, to, cc = ms.addresses_of(msg)
    assert sender == "sender@example.com"
    assert to == ["to@example.com"]
    assert cc == []


@pytest.mark.asyncio
async def test_set_message_read_patches_is_read(monkeypatch):
    captured = {}

    async def _fake_request(_token, method, url, **kw):
        captured["method"], captured["url"], captured["json"] = method, url, kw.get("json")
        return {}

    monkeypatch.setattr(ms, "_request", _fake_request)
    await ms.set_message_read("tok", "msg-1", True)
    assert captured == {"method": "PATCH", "url": "/me/messages/msg-1", "json": {"isRead": True}}


@pytest.mark.asyncio
async def test_move_to_deleted_targets_deleteditems(monkeypatch):
    captured = {}

    async def _fake_request(_token, method, url, **kw):
        captured["method"], captured["url"], captured["json"] = method, url, kw.get("json")
        return {"id": "msg-2"}

    monkeypatch.setattr(ms, "_request", _fake_request)
    await ms.move_to_deleted("tok", "msg-1")
    assert captured == {
        "method": "POST",
        "url": "/me/messages/msg-1/move",
        "json": {"destinationId": "deleteditems"},
    }


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
