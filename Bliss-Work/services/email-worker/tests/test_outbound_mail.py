"""The relay path for a user's OWN email, as opposed to a notification about one.

``mail.outbound`` is not like the two event types beside it. ``message.created``
and ``task.assigned`` produce a courtesy email about something that already
happened in the app and that the recipient can go and look at; this one IS the
thing the user sent, and SMTP is the only way it reaches its recipient at all.
Three behaviours follow from that difference and are pinned here:

  * it is NOT presence-gated — there is no in-app copy for an external
    recipient to be watching, so "they're online, skip it" would silently drop
    somebody's mail;
  * the ENVELOPE is one address while the To/Cc header is the shared display
    list, which is the mechanism that keeps a Bcc'd address out of every
    header, including the Bcc'd person's own copy;
  * the author's own name and address go out as the From, because this mail is
    from them and not from the product — while the SMTP envelope stays on the
    deployment's authenticated address, which is what keeps it accepted.

These drive the REAL ``_handle`` / ``_handle_outbound_mail`` coroutines. Only
the two I/O edges are replaced: the dedup claim (Postgres) and the Mailer.
"""
from __future__ import annotations

import json
import types

import pytest

from app.relay_consumer import RelayConsumer


def _settings() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        smtp_host="mailpit",
        smtp_port=1025,
        smtp_from="no-reply@blisswork.test",
        smtp_username="",
        smtp_password="",
        smtp_starttls=False,
        redis_url="redis://localhost:6379/0",
        poison_max_failures=3,
        # Present so this harness matches a real Settings object. The events
        # here carry no attachments, so nothing reads them — but a stub missing
        # a field the code reads fails as an AttributeError inside the handler,
        # which reads as a broken relay rather than a stale test.
        messaging_internal_base="http://messaging-svc:8004",
        integrations_internal_base="http://integrations-svc:8005",
        internal_token="test-token",
        mail_attachment_budget_bytes=10 * 1024 * 1024,
    )


class _RecordingMailer:
    def __init__(self) -> None:
        self.sends: list[dict] = []
        self.fail = False

    async def send(self, **kwargs: object) -> None:
        if self.fail:
            raise RuntimeError("smtp is down")
        self.sends.append(dict(kwargs))


class _AlwaysOnlinePresence:
    """Every user is online. A notification would be skipped; mail must not be."""

    async def is_online(self, _user_id: str) -> bool:
        return True


def _consumer() -> tuple[RelayConsumer, _RecordingMailer, list[tuple[str, str]]]:
    c = RelayConsumer(_settings())
    mailer = _RecordingMailer()
    c._mailer = mailer  # noqa: SLF001
    c._presence = _AlwaysOnlinePresence()  # noqa: SLF001

    claimed: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()

    async def _claim(event_id: str, recipient_id: str) -> bool:
        key = (event_id, recipient_id)
        claimed.append(key)
        if key in seen:
            return False
        seen.add(key)
        return True

    async def _is_sent(event_id: str, recipient_id: str) -> bool:
        return (event_id, recipient_id) in seen

    async def _mark_sent(_event_id: str, _recipient_id: str) -> None:
        return None

    c._claim = _claim        # noqa: SLF001
    c._is_sent = _is_sent    # noqa: SLF001
    c._mark_sent = _mark_sent  # noqa: SLF001
    return c, mailer, claimed


MAIL_ID = "018f0000-0000-7000-8000-0000000000aa"


def _event(**overrides: object) -> bytes:
    event = {
        "type": "mail.outbound",
        "eventId": "018f0000-0000-7000-8000-0000000000bb",
        "orgId": "018f0000-0000-7000-8000-0000000000cc",
        "occurredAt": "2026-08-18T09:00:00.000Z",
        "mailId": MAIL_ID,
        "envelope": "partner@outside.test",
        "fromAddress": "jane@acme.test",
        "fromName": "Jane Okafor",
        "to": ["partner@outside.test"],
        "cc": ["cc-person@outside.test"],
        "subject": "Q3 numbers",
        "bodyText": "Deck attached.",
    }
    event.update(overrides)
    return json.dumps(event).encode("utf-8")


@pytest.mark.asyncio
async def test_online_recipient_does_not_suppress_a_users_mail():
    # The presence stub reports everyone online. A notification would be
    # skipped here; this is the user's actual email and must still go out.
    c, mailer, _ = _consumer()
    assert await c._handle(_event()) is True  # noqa: SLF001
    assert len(mailer.sends) == 1
    assert mailer.sends[0]["to"] == "partner@outside.test"


@pytest.mark.asyncio
async def test_envelope_is_this_copy_and_headers_are_the_shared_list():
    # The Bcc'd address is the `envelope`, but To/Cc carry only the addresses
    # everyone is allowed to see — so nothing in this copy reveals the Bcc.
    c, mailer, _ = _consumer()
    await c._handle(_event(envelope="secret@outside.test"))  # noqa: SLF001
    sent = mailer.sends[0]
    assert sent["to"] == "secret@outside.test"
    assert sent["display_to"] == ["partner@outside.test"]
    assert sent["display_cc"] == ["cc-person@outside.test"]
    assert "secret@outside.test" not in sent["display_to"]
    assert "secret@outside.test" not in sent["display_cc"]


@pytest.mark.asyncio
async def test_the_author_is_who_the_mail_comes_from():
    # Both halves of the identity reach the mailer: the member's display name
    # and the member's own address. test_from_header.py pins what it builds
    # from them, including the envelope that does NOT follow the address here.
    c, mailer, _ = _consumer()
    await c._handle(_event())  # noqa: SLF001
    sent = mailer.sends[0]
    assert sent["from_name"] == "Jane Okafor"
    assert sent["from_address"] == "jane@acme.test"


@pytest.mark.asyncio
async def test_unparseable_author_address_yields_no_reply_to():
    # An address nobody can reply to is worse than none: it produces a bounce
    # instead of an obvious "this came through BlissWork". The From falls back
    # to the deployment sender for the same reason — see test_from_header.py.
    c, mailer, _ = _consumer()
    await c._handle(_event(fromAddress="not-an-address"))  # noqa: SLF001
    assert mailer.sends[0]["reply_to"] == ""


@pytest.mark.asyncio
async def test_malformed_envelope_is_dropped_rather_than_retried_forever():
    # messaging-svc validates on the way in, so reaching here means a broken
    # producer. SMTP would reject it on every redelivery, so the offset must
    # advance instead of pinning the consumer.
    c, mailer, _ = _consumer()
    assert await c._handle(_event(envelope="not-an-address")) is True  # noqa: SLF001
    assert mailer.sends == []


@pytest.mark.asyncio
async def test_dedup_is_keyed_on_the_mail_not_a_user_id():
    # One event is emitted per external addressee, so (eventId, mailId) is
    # already unique per copy — and a redelivered batch must not send the same
    # person the same mail twice.
    c, mailer, claimed = _consumer()
    await c._handle(_event())  # noqa: SLF001
    await c._handle(_event())  # noqa: SLF001 - redelivery
    assert [key[1] for key in claimed] == [MAIL_ID, MAIL_ID]
    assert len(mailer.sends) == 1


@pytest.mark.asyncio
async def test_an_in_app_delivery_never_becomes_an_email():
    # mail.delivered means the recipient has a BlissWork account and the mail is
    # already in their Inbox. Relaying it would email someone to tell them they
    # have an email.
    c, mailer, _ = _consumer()
    assert await c._handle(json.dumps({  # noqa: SLF001
        "type": "mail.delivered",
        "eventId": "018f0000-0000-7000-8000-0000000000dd",
        "mailId": MAIL_ID,
        "members": ["018f0000-0000-7000-8000-0000000000ee"],
    }).encode("utf-8")) is True
    assert mailer.sends == []


@pytest.mark.asyncio
async def test_a_transient_smtp_failure_leaves_the_offset_uncommitted():
    # Below the poison threshold the copy must be retried, which means NOT
    # advancing the offset — otherwise a brief SMTP outage silently eats mail.
    c, mailer, _ = _consumer()
    mailer.fail = True
    assert await c._handle(_event()) is False  # noqa: SLF001
