"""Microsoft Graph adapter — error classification, delta paging, extraction.

The delta-paging test is the one that matters most. Graph returns
`@odata.nextLink` while pages remain and `@odata.deltaLink` only on the last
one; persisting a half-walked position as the cursor silently skips every
message beyond it, and the failure looks exactly like "no new mail".
"""

import base64
from datetime import datetime, timezone

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


# ── clientState verification ──────────────────────────────────────────────────
def test_client_state_matches():
    assert ms.verify_client_state("secret-abc", "secret-abc") is True


@pytest.mark.parametrize(
    "expected,received",
    [
        ("secret-abc", "secret-abd"),
        ("secret-abc", "secret-ab"),
        ("secret-abc", ""),
        ("secret-abc", None),
        ("", "secret-abc"),
        ("", ""),
        ("", None),
    ],
)
def test_client_state_fails_closed(expected, received):
    # This is the ONLY thing authenticating a Graph notification — the endpoint
    # is public and the payload is otherwise unauthenticated. Anything missing
    # or mismatched must be rejected, including a missing EXPECTED value (which
    # would otherwise let an unconfigured connection accept anything).
    assert ms.verify_client_state(expected, received) is False


# ── subscription expiry ───────────────────────────────────────────────────────
def test_expiry_is_iso8601_utc_with_trailing_z():
    now = datetime(2026, 7, 26, 12, 0, 0, tzinfo=timezone.utc)
    out = ms.subscription_expiry(60, now=now)
    assert out.startswith("2026-07-26T13:00:00")
    assert out.endswith("Z")


def test_subscription_windows_stay_under_graph_caps():
    # Graph rejects anything longer than its per-resource cap outright. The
    # margin also absorbs clock skew between us and Graph.
    assert ms.MAIL_SUBSCRIPTION_MINUTES < 4230
    assert ms.CHAT_SUBSCRIPTION_MINUTES < 60


def test_renew_margin_is_shorter_than_the_chat_window():
    # If the margin exceeded the chat lifetime, a chat subscription would be
    # "due for renewal" the instant it was created — a renewal loop.
    assert ms.RENEW_MARGIN_MINUTES < ms.CHAT_SUBSCRIPTION_MINUTES


# ── delta paging ──────────────────────────────────────────────────────────────
def _patch_pages(monkeypatch, pages: list[dict]) -> list[str]:
    """Serve `pages` in order, recording the URLs requested."""
    seen: list[str] = []
    queue = list(pages)

    async def fake_request(_token, _method, url, **_kw):
        seen.append(url)
        return queue.pop(0)

    monkeypatch.setattr(ms, "_request", fake_request)
    return seen


async def test_walk_follows_next_links_to_the_delta_link(monkeypatch):
    seen = _patch_pages(
        monkeypatch,
        [
            {"value": [{"id": "1"}], "@odata.nextLink": "https://graph/p2"},
            {"value": [{"id": "2"}], "@odata.nextLink": "https://graph/p3"},
            {"value": [{"id": "3"}], "@odata.deltaLink": "https://graph/delta-final"},
        ],
    )
    items, delta = await ms.walk_delta("tok", "/start")
    assert [i["id"] for i in items] == ["1", "2", "3"]
    assert delta == "https://graph/delta-final"
    assert seen == ["/start", "https://graph/p2", "https://graph/p3"]


async def test_incomplete_walk_returns_no_cursor(monkeypatch):
    # THE bug this guards: stopping mid-walk and persisting the nextLink as a
    # cursor skips every message past that point, silently and permanently.
    # Returning None forces the caller to keep its old cursor and re-fetch.
    _patch_pages(
        monkeypatch,
        [
            {"value": [{"id": "1"}], "@odata.nextLink": "https://graph/p2"},
            {"value": [{"id": "2"}], "@odata.nextLink": "https://graph/p3"},
        ],
    )
    items, delta = await ms.walk_delta("tok", "/start", max_pages=2)
    assert len(items) == 2
    assert delta is None


async def test_single_page_delta(monkeypatch):
    _patch_pages(monkeypatch, [{"value": [{"id": "1"}], "@odata.deltaLink": "https://graph/d"}])
    items, delta = await ms.walk_delta("tok", "/start")
    assert len(items) == 1 and delta == "https://graph/d"


async def test_empty_delta_still_advances_the_cursor(monkeypatch):
    # No new mail is a successful sweep, and the new deltaLink must be stored or
    # the next sweep re-reads from the old position forever.
    _patch_pages(monkeypatch, [{"value": [], "@odata.deltaLink": "https://graph/d2"}])
    items, delta = await ms.walk_delta("tok", "/start")
    assert items == [] and delta == "https://graph/d2"


async def test_page_without_either_link_terminates(monkeypatch):
    # Malformed/truncated response: stop rather than loop, and report no cursor.
    _patch_pages(monkeypatch, [{"value": [{"id": "1"}]}])
    items, delta = await ms.walk_delta("tok", "/start")
    assert len(items) == 1 and delta is None


def test_inbox_delta_url_excludes_the_message_body():
    # Mention detection needs addressing fields only; pulling `body` would move
    # far more PII through this service than it ever stores.
    url = ms.inbox_delta_url()
    assert "$select=" in url
    assert "toRecipients" in url and "ccRecipients" in url
    assert "body" not in url.split("$select=")[1]


# ── mail address extraction ───────────────────────────────────────────────────
def test_addresses_are_extracted_and_lowercased():
    msg = {
        "from": {"emailAddress": {"address": "Sender@Acme.com"}},
        "toRecipients": [{"emailAddress": {"address": "Me@Acme.com"}}],
        "ccRecipients": [{"emailAddress": {"address": "Team@Acme.com"}}],
    }
    assert ms.addresses_of(msg) == ("sender@acme.com", ["me@acme.com"], ["team@acme.com"])


@pytest.mark.parametrize(
    "msg",
    [
        {},
        {"from": {}},
        {"from": {"emailAddress": {}}},
        {"toRecipients": []},
        {"toRecipients": [{}]},
        {"toRecipients": [{"emailAddress": {}}]},
    ],
)
def test_address_extraction_tolerates_sparse_payloads(msg):
    # Graph omits collections entirely when empty and nests two levels deep, so
    # every level needs a guard.
    sender, to, cc = ms.addresses_of(msg)
    assert isinstance(sender, str) and to == [] and cc == []


# ── Teams mentions ────────────────────────────────────────────────────────────
def test_extracts_mentioned_user_ids():
    msg = {
        "mentions": [
            {"mentioned": {"user": {"id": "aad-1", "displayName": "A"}}},
            {"mentioned": {"user": {"id": "aad-2"}}},
        ]
    }
    assert ms.mentioned_user_ids(msg) == ["aad-1", "aad-2"]


def test_dedupes_repeated_mentions_of_one_person():
    msg = {"mentions": [{"mentioned": {"user": {"id": "aad-1"}}}] * 3}
    assert ms.mentioned_user_ids(msg) == ["aad-1"]


@pytest.mark.parametrize(
    "msg",
    [
        {},
        {"mentions": []},
        {"mentions": [{}]},
        {"mentions": [{"mentioned": {}}]},
        # @team / @channel broadcast — the firehose the feed exists to replace.
        {"mentions": [{"mentioned": {"conversation": {"id": "team-1"}}}]},
        # a bot mention
        {"mentions": [{"mentioned": {"application": {"id": "app-1"}}}]},
    ],
)
def test_non_user_mentions_are_ignored(msg):
    assert ms.mentioned_user_ids(msg) == []


def test_bot_authored_messages_are_detected():
    # A bot echoing our own forwarded message must not be ingested as a mention:
    # that is how a message loop starts.
    assert ms.is_from_bot({"from": {"application": {"id": "app-1"}}}) is True
    assert ms.is_from_bot({"from": {"user": {"id": "aad-1"}}}) is False


@pytest.mark.parametrize("msg", [{}, {"from": {}}, {"from": None}])
def test_message_with_no_identifiable_sender_counts_as_a_bot(msg):
    # Fail closed: an unattributable message is not a person tagging you.
    assert ms.is_from_bot(msg) is True


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
