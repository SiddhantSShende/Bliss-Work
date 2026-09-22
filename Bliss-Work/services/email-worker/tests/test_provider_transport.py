"""Choosing between a member's own mailbox and the shared SMTP relay.

The relay authenticates as ONE address for the whole deployment, so mail a
member composes can only CLAIM to be theirs — and a recipient's mail system
reads an unfamiliar third party asserting somebody's identity exactly as it
looks. Sending through the member's own connected mailbox removes the claim:
the address is theirs because the mailbox is, their provider signs it with
their domain, and the copy lands in their Sent folder.

The awkward part, and what these tests pin, is that the two transports disagree
about what a "copy" is. SMTP takes one envelope recipient at a time with a
shared To/Cc header — that split is what keeps a Bcc'd address out of everyone's
headers. A mailbox provider has no envelope at all and delivers to exactly the
addresses it is handed, so ONE send covers every external recipient and the
remaining copies must do nothing. Which of the two happened is not derivable
from a copy's own payload, so the deciding copy records it and the rest read it.

These drive the REAL _handle / _handle_outbound_mail / _decide_transport
coroutines. Only the I/O edges are replaced: the dedup claim, the transport
record, the Mailer and the call into integrations-svc.
"""
from __future__ import annotations

import json
import types

import pytest

from app import relay_consumer as rc
from app.provider_mail import ProviderMailUnavailable
from app.relay_consumer import RelayConsumer

MAIL_ID = "018f0000-0000-7000-8000-0000000000aa"
ORG_ID = "018f0000-0000-7000-8000-0000000000cc"
AUTHOR_ID = "018f0000-0000-7000-8000-0000000000dd"


def _settings() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        smtp_host="mailpit",
        smtp_port=1025,
        smtp_from="no-reply@blisswork.test",
        smtp_username="",
        smtp_password="",
        smtp_starttls=False,
        redis_url="redis://localhost:6379/0", relay_max_concurrency=4,
        poison_max_failures=3,
        messaging_internal_base="http://messaging-svc:8004",
        integrations_internal_base="http://integrations-svc:8005",
        messaging_internal_token="test-token",
        integrations_internal_token="test-token",
        mail_attachment_budget_bytes=10 * 1024 * 1024,
    )


class _RecordingMailer:
    def __init__(self) -> None:
        self.sends: list[dict] = []

    async def send(self, **kwargs: object) -> None:
        self.sends.append(dict(kwargs))


def _consumer() -> tuple[RelayConsumer, _RecordingMailer, dict[str, str]]:
    """A consumer with the relay's two databases replaced by dicts.

    `transport` is returned so a test can both assert what was recorded and
    pre-seed a decision a previous copy would have left behind.
    """
    c = RelayConsumer(_settings())
    mailer = _RecordingMailer()
    c._mailer = mailer  # noqa: SLF001
    c._presence = None  # noqa: SLF001 — mail is never presence-gated

    sent: set[tuple[str, str]] = set()
    transport: dict[str, tuple[str, frozenset[str]]] = {}

    async def _claim(event_id: str, recipient_id: str) -> bool:
        return (event_id, recipient_id) not in sent

    async def _is_sent(event_id: str, recipient_id: str) -> bool:
        return (event_id, recipient_id) in sent

    async def _mark_sent(event_id: str, recipient_id: str) -> None:
        sent.add((event_id, recipient_id))

    async def _read_transport(mail_id: str) -> tuple[str, frozenset[str]] | None:
        return transport.get(mail_id)

    async def _record_transport(mail_id: str, value: str, covered: frozenset[str]) -> None:
        transport.setdefault(mail_id, (value, covered))

    c._claim = _claim                        # noqa: SLF001
    c._is_sent = _is_sent                    # noqa: SLF001
    c._mark_sent = _mark_sent                # noqa: SLF001
    c._read_transport = _read_transport      # noqa: SLF001
    c._record_transport = _record_transport  # noqa: SLF001
    return c, mailer, transport


class _RecordingProvider:
    """Stands in for integrations-svc. `available` is whether the author has a
    connected mailbox at all — the 404 that sends everything back to the relay."""

    def __init__(self, *, available: bool = True, raises: bool = False) -> None:
        self.available = available
        self.raises = raises
        self.sends: list[dict] = []

    async def __call__(self, _client, _base, _token, **kwargs: object) -> bool:
        if self.raises:
            raise ProviderMailUnavailable("integrations-svc is restarting")
        self.sends.append(dict(kwargs))
        return self.available


def _event(envelope: str, *, primary: bool, **overrides: object) -> bytes:
    """One copy of a three-way mail: two external To addresses and one Bcc."""
    event: dict = {
        "type": "mail.outbound",
        "eventId": f"018f0000-0000-7000-8000-{abs(hash(envelope)) % 10**12:012d}",
        "orgId": ORG_ID,
        "occurredAt": "2026-08-18T09:00:00.000Z",
        "mailId": MAIL_ID,
        "envelope": envelope,
        "authorId": AUTHOR_ID,
        "fromAddress": "jane@acme.test",
        "fromName": "Jane Okafor",
        "to": ["partner@outside.test"],
        "cc": ["cc-person@outside.test"],
        "subject": "Q3 numbers",
        "bodyText": "Deck attached.",
    }
    if primary:
        event["providerCopy"] = True
        event["providerTo"] = ["partner@outside.test"]
        event["providerCc"] = ["cc-person@outside.test"]
        event["providerBcc"] = ["blind@outside.test"]
    event.update(overrides)
    return json.dumps(event).encode("utf-8")


@pytest.mark.asyncio
async def test_the_deciding_copy_sends_through_the_authors_mailbox(monkeypatch):
    provider = _RecordingProvider()
    monkeypatch.setattr(rc, "provider_send", provider)
    c, mailer, transport = _consumer()

    assert await c._handle(_event("partner@outside.test", primary=True)) is True  # noqa: SLF001

    # One send through the mailbox, and NOTHING over the relay: the whole point
    # is that this mail never touches the deployment's shared SMTP identity.
    assert len(provider.sends) == 1
    assert mailer.sends == []
    assert transport[MAIL_ID] == (
        rc.TRANSPORT_PROVIDER,
        frozenset({"partner@outside.test", "cc-person@outside.test", "blind@outside.test"}),
    )


@pytest.mark.asyncio
async def test_bcc_stays_blind_through_the_provider(monkeypatch):
    provider = _RecordingProvider()
    monkeypatch.setattr(rc, "provider_send", provider)
    c, _mailer, _t = _consumer()

    await c._handle(_event("partner@outside.test", primary=True))  # noqa: SLF001

    sent = provider.sends[0]
    assert sent["to"] == ["partner@outside.test"]
    assert sent["cc"] == ["cc-person@outside.test"]
    # The blind address is handed over as a Bcc rather than folded into To —
    # that is the one part of the envelope/header split a provider preserves,
    # and losing it would expose a blind recipient to everybody on the mail.
    assert sent["bcc"] == ["blind@outside.test"]
    assert "blind@outside.test" not in sent["to"] + sent["cc"]


@pytest.mark.asyncio
async def test_the_other_copies_defer_to_the_recorded_transport(monkeypatch):
    provider = _RecordingProvider()
    monkeypatch.setattr(rc, "provider_send", provider)
    c, mailer, _t = _consumer()

    # Order matters and is guaranteed: every copy of one mail carries the mailId
    # as its Kafka key, so they arrive on one partition in this order.
    assert await c._handle(_event("partner@outside.test", primary=True)) is True  # noqa: SLF001
    assert await c._handle(_event("cc-person@outside.test", primary=False)) is True  # noqa: SLF001
    assert await c._handle(_event("blind@outside.test", primary=False)) is True  # noqa: SLF001

    # Still exactly one provider send: it already delivered to all three. A
    # second would put a duplicate in front of every recipient AND a second copy
    # in the author's Sent folder.
    assert len(provider.sends) == 1
    assert mailer.sends == []


@pytest.mark.asyncio
async def test_no_connected_mailbox_sends_every_copy_over_the_relay(monkeypatch):
    provider = _RecordingProvider(available=False)
    monkeypatch.setattr(rc, "provider_send", provider)
    c, mailer, transport = _consumer()

    assert await c._handle(_event("partner@outside.test", primary=True)) is True  # noqa: SLF001
    assert await c._handle(_event("cc-person@outside.test", primary=False)) is True  # noqa: SLF001

    assert transport[MAIL_ID] == (rc.TRANSPORT_RELAY, frozenset())
    # One envelope per copy, which is what the relay needs and what keeps a Bcc
    # out of the headers. The deployment with no integrations configured is the
    # common one, and it behaves exactly as it did before.
    assert [s["to"] for s in mailer.sends] == [
        "partner@outside.test",
        "cc-person@outside.test",
    ]


@pytest.mark.asyncio
async def test_a_transient_provider_fault_is_retried_not_relayed(monkeypatch):
    provider = _RecordingProvider(raises=True)
    monkeypatch.setattr(rc, "provider_send", provider)
    c, mailer, transport = _consumer()

    # False means "do not advance the offset" — Kafka redelivers. Relaying
    # instead would send under the wrong identity a mailbox outage made
    # momentarily unavailable, and record that as the mail's transport forever.
    assert await c._handle(_event("partner@outside.test", primary=True)) is False  # noqa: SLF001
    assert mailer.sends == []
    assert MAIL_ID not in transport


@pytest.mark.asyncio
async def test_the_deciding_copy_does_not_send_twice_after_a_redelivery(monkeypatch):
    provider = _RecordingProvider()
    monkeypatch.setattr(rc, "provider_send", provider)
    c, _mailer, _t = _consumer()

    raw = _event("partner@outside.test", primary=True)
    assert await c._handle(raw) is True  # noqa: SLF001
    # A redelivery after a crash between the send and the offset commit. The
    # recorded transport is what makes the deciding copy idempotent.
    assert await c._handle(raw) is True  # noqa: SLF001
    assert len(provider.sends) == 1


@pytest.mark.asyncio
async def test_an_event_without_an_author_still_relays(monkeypatch):
    provider = _RecordingProvider()
    monkeypatch.setattr(rc, "provider_send", provider)
    c, mailer, _t = _consumer()

    # Produced before authorId existed and still on the topic. SMTP is the only
    # route it was ever emitted expecting, and it must keep working.
    raw = _event("partner@outside.test", primary=True, authorId="")
    assert await c._handle(raw) is True  # noqa: SLF001
    assert provider.sends == []
    assert len(mailer.sends) == 1


@pytest.mark.asyncio
async def test_a_local_members_own_copy_is_still_relayed_after_a_provider_send(monkeypatch):
    # Regression: mail_send.go's relayRecipients() deliberately gives a local
    # org member a real wire copy too (their in-app inbox row is not a copy in
    # their ACTUAL mailbox) — but a mailbox-provider send only ever reaches
    # providerTo/Cc/Bcc, which never includes a local member (that would
    # double-deliver to someone who already has the in-app copy). Before this
    # fix, TRANSPORT_PROVIDER short-circuited EVERY copy of the mail, silently
    # dropping the local member's own copy instead of relaying it.
    provider = _RecordingProvider()
    monkeypatch.setattr(rc, "provider_send", provider)
    c, mailer, transport = _consumer()

    # The deciding copy: an external address, sent through the author's mailbox.
    assert await c._handle(_event("partner@outside.test", primary=True)) is True  # noqa: SLF001
    assert len(provider.sends) == 1
    assert transport[MAIL_ID][0] == rc.TRANSPORT_PROVIDER

    # A local colleague's own copy of the SAME mail — never in providerTo/Cc/Bcc,
    # so the provider send above did not (and must not) reach them.
    local_member = "colleague@acme.test"
    assert await c._handle(_event(local_member, primary=False)) is True  # noqa: SLF001

    # Still exactly one provider send (unchanged) — but the local member's copy
    # must have gone out over the relay, not been silently marked done.
    assert len(provider.sends) == 1
    assert [s["to"] for s in mailer.sends] == [local_member]


@pytest.mark.asyncio
async def test_an_empty_subject_is_not_sent_as_an_empty_header(monkeypatch):
    provider = _RecordingProvider()
    monkeypatch.setattr(rc, "provider_send", provider)
    c, _mailer, _t = _consumer()

    # A blank Subject reads as nothing to the recipient and as a signal to the
    # filters in front of them. Both transports send the same placeholder.
    await c._handle(_event("partner@outside.test", primary=True, subject="   "))  # noqa: SLF001
    assert provider.sends[0]["subject"] == "(no subject)"
