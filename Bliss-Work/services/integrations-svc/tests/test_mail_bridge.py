"""Turning a mail in a connected Outlook mailbox into one in the BlissWork inbox.

This is the producer that `/internal/mail/inbound` never had: sending worked,
receiving stopped at the member's real mailbox. What is pinned here is the
mapping, because it is the part that decides whether a mail is deliverable at
all — and the two fields it refuses to guess at.

The Message-ID is the one to look at twice. It is the RFC 5322 header, the SAME
string in every recipient's mailbox, while a Graph `id` is per-mailbox. Keying on
it is what makes two colleagues who both connect Outlook and were both on one
mail see ONE conversation in BlissWork rather than two unrelated copies.
"""

from app.mail_bridge import MAX_BODY_CHARS, from_graph_message

ORG = "018f0000-0000-7000-8000-0000000000cc"


def _graph(**over) -> dict:
    msg = {
        "id": "AAMkAGVmMDEz...",
        "internetMessageId": "<MWHPR6E1BE060@namprd22.prod.outlook.com>",
        "subject": "Q3 numbers",
        "body": {"contentType": "text", "content": "Deck attached.\r\nThanks!"},
        "bodyPreview": "Deck attached.",
        "from": {"emailAddress": {"name": "Partner Co", "address": "Partner@Outside.TEST"}},
        "toRecipients": [{"emailAddress": {"name": "Jane", "address": "Jane@Acme.test"}}],
        "ccRecipients": [{"emailAddress": {"address": "cc@acme.test"}}],
        "receivedDateTime": "2026-08-18T09:00:00Z",
    }
    msg.update(over)
    return msg


def test_a_whole_mail_maps_across():
    mail = from_graph_message(_graph(), org_id=ORG)

    assert mail is not None
    payload = mail.payload()
    assert payload["externalMessageId"] == "<MWHPR6E1BE060@namprd22.prod.outlook.com>"
    assert payload["fromAddress"] == "partner@outside.test"
    assert payload["fromName"] == "Partner Co"
    assert payload["subject"] == "Q3 numbers"
    assert payload["bodyText"] == "Deck attached.\r\nThanks!"
    assert payload["to"] == ["jane@acme.test"]
    assert payload["cc"] == ["cc@acme.test"]
    assert payload["sentAt"] == "2026-08-18T09:00:00Z"
    assert payload["orgId"] == ORG


def test_addresses_are_lowercased_so_they_match_the_directory():
    # messaging-svc resolves recipients against the org directory, which stores
    # addresses lowercased. "Jane@Acme.test" not matching "jane@acme.test" would
    # mean the mail resolves to nobody and is dropped as un-addressed.
    mail = from_graph_message(_graph(), org_id=ORG)
    assert mail is not None
    assert mail.to == ["jane@acme.test"]
    assert mail.from_address == "partner@outside.test"


def test_a_mail_with_no_message_id_is_refused():
    # That header IS the dedup key. Without it a re-walked delta files the same
    # mail again on every sweep, which is an inbox that grows on a timer.
    assert from_graph_message(_graph(internetMessageId=""), org_id=ORG) is None
    msg = _graph()
    del msg["internetMessageId"]
    assert from_graph_message(msg, org_id=ORG) is None


def test_a_mail_with_no_sender_is_refused():
    # The inbox renders a mail as being FROM somebody, and a reply needs an
    # address to go to.
    assert from_graph_message(_graph(**{"from": {}}), org_id=ORG) is None


def test_the_sender_falls_back_to_the_envelope_sender():
    # Graph omits `from` on some system-generated mail but still carries `sender`.
    msg = _graph()
    del msg["from"]
    msg["sender"] = {"emailAddress": {"address": "noreply@outside.test"}}

    mail = from_graph_message(msg, org_id=ORG)

    assert mail is not None
    assert mail.from_address == "noreply@outside.test"


def test_a_mail_addressed_to_nobody_here_is_still_mapped():
    # Not this function's call. messaging-svc resolves To/Cc against the org
    # directory and answers 422 when none of them are members — deciding it here
    # too would put the same rule in two places, out of step by construction.
    mail = from_graph_message(_graph(toRecipients=[], ccRecipients=[]), org_id=ORG)

    assert mail is not None
    assert mail.to == [] and mail.cc == []


def test_the_preview_is_a_fallback_and_never_a_substitute():
    # Graph caps bodyPreview at 255 characters. It is what a mail looks like when
    # the full body could not be had, not a shorter version of one that could.
    msg = _graph()
    del msg["body"]

    mail = from_graph_message(msg, org_id=ORG)

    assert mail is not None
    assert mail.body_text == "Deck attached."


def test_a_very_long_thread_is_bounded():
    # A mail replied to forty times carries every earlier copy. An inbox row is
    # something to read, not an archive.
    mail = from_graph_message(
        _graph(body={"contentType": "text", "content": "x" * (MAX_BODY_CHARS + 5_000)}),
        org_id=ORG,
    )

    assert mail is not None
    assert len(mail.body_text) == MAX_BODY_CHARS


def test_malformed_recipient_entries_do_not_break_the_mapping():
    # Everything here came off the wire. A shape Graph should never send must
    # cost that address, not the mail.
    mail = from_graph_message(
        _graph(toRecipients=["not-a-dict", {}, {"emailAddress": None},
                             {"emailAddress": {"address": "real@acme.test"}}]),
        org_id=ORG,
    )

    assert mail is not None
    assert mail.to == ["real@acme.test"]


def test_a_recipient_collection_that_is_not_a_list_is_ignored():
    mail = from_graph_message(_graph(ccRecipients={"emailAddress": {}}), org_id=ORG)

    assert mail is not None
    assert mail.cc == []


# ── delivery ──────────────────────────────────────────────────────────────────
import httpx  # noqa: E402
import pytest  # noqa: E402

from app import mail_bridge  # noqa: E402


class _FakeClient:
    """Stands in for httpx.AsyncClient; records the request it was given."""

    def __init__(self, handler):
        self._handler = handler

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, **kw):
        return self._handler(url, kw)


def _patch(monkeypatch, handler):
    monkeypatch.setattr(mail_bridge.httpx, "AsyncClient", lambda **_kw: _FakeClient(handler))


def _mail() -> "mail_bridge.InboundMail":
    m = from_graph_message(_graph(), org_id=ORG)
    assert m is not None
    return m


async def test_a_delivered_mail_is_posted_with_the_internal_token(monkeypatch):
    seen = {}

    def handler(url, kw):
        seen["url"] = url
        seen["headers"] = kw["headers"]
        seen["json"] = kw["json"]
        return httpx.Response(200, json={"mailId": "x", "delivered": 1})

    _patch(monkeypatch, handler)

    assert await mail_bridge.deliver(_mail()) is True
    assert seen["url"].endswith("/internal/mail/inbound")
    assert "X-Internal-Token" in seen["headers"]
    assert seen["json"]["externalMessageId"].startswith("<MWHPR6E1BE060@")


async def test_a_mail_addressed_to_nobody_here_is_not_retried(monkeypatch):
    # 422 is the ordinary case, not a fault: most of a real mailbox is mail that
    # no member of this org was addressed on. Retrying it three times per mail
    # would cost three round trips for every newsletter someone receives.
    calls = []

    def handler(url, _kw):
        calls.append(1)
        return httpx.Response(422, json={"error": "no recipient resolved"},
                              request=httpx.Request("POST", url))

    _patch(monkeypatch, handler)

    assert await mail_bridge.deliver(_mail()) is False
    assert len(calls) == 1


async def test_messaging_svc_being_down_does_not_raise(monkeypatch):
    # The caller is mid-sweep and about to advance the provider cursor. An
    # exception here would stall every message behind this one, and the mail is
    # still in the member's real mailbox either way.
    def handler(_url, _kw):
        raise httpx.ConnectError("connection refused")

    _patch(monkeypatch, handler)

    assert await mail_bridge.deliver(_mail()) is False


async def test_a_server_error_is_retried_before_giving_up(monkeypatch):
    calls = []

    def handler(url, _kw):
        calls.append(1)
        # A Response needs its request attached or raise_for_status() raises a
        # RuntimeError instead of the HTTPStatusError the retry classifies on.
        return httpx.Response(503, request=httpx.Request("POST", url))

    _patch(monkeypatch, handler)

    assert await mail_bridge.deliver(_mail()) is False
    assert len(calls) > 1, "a 5xx is transient and must be retried"
