"""B-EW-2: ProviderMailUnavailable must not stall a partition forever.

_do_handle_outbound_mail used to answer ProviderMailUnavailable by releasing the
claim and returning False WITHOUT counting it toward poison_max_failures. A 409
from integrations-svc (its mail_send_attempts claim is parked 'sending' after a
lost outcome) maps to it on EVERY attempt, so the batch was rewound and retried
every _RETRY_BACKOFF indefinitely, blocking every mail behind it on the
partition. It now counts against the same per-event counter as every other
failure and, past the cap, takes the EXISTING poison path (DLQ + commit).

It never falls back to SMTP: the provider may already have sent the mail.
"""
from __future__ import annotations

import json

import httpx
import pytest

from app import provider_mail as pm
from app import relay_consumer as rc
from app.provider_mail import ProviderMailUnavailable
from tests.test_provider_transport import MAIL_ID, _consumer, _event

CONFLICT = ProviderMailUnavailable("409 conflict", conflict=True)
OUTAGE = ProviderMailUnavailable("503 service unavailable")


class _Raising:
    def __init__(self, exc: Exception) -> None:
        self.exc, self.calls = exc, 0

    async def __call__(self, *_a, **_kw):
        self.calls += 1
        raise self.exc


def _wire(monkeypatch, exc):
    provider = _Raising(exc)
    monkeypatch.setattr(rc, "provider_send", provider)
    c, mailer, transport = _consumer()
    dlq: list[tuple[dict, str]] = []

    async def _to_dlq(event, error):
        dlq.append((event, error))

    c._to_dlq = _to_dlq  # noqa: SLF001
    return c, mailer, transport, dlq, provider


@pytest.mark.asyncio
async def test_a_409_conflict_is_dead_lettered_after_the_poison_cap(monkeypatch):
    c, mailer, transport, dlq, _p = _wire(monkeypatch, CONFLICT)
    raw = _event("partner@outside.test", primary=True)

    results = [await c._handle(raw) for _ in range(3)]  # noqa: SLF001

    assert results == [False, False, True], "poison_max_failures=3 then commit"
    assert len(dlq) == 1
    assert "provider mail unavailable" in dlq[0][1]
    assert mailer.sends == [], "NEVER an SMTP fallback for the ambiguous 409 case"
    assert MAIL_ID not in transport, "no transport recorded: nothing was decided"
    assert c._failures == {}, "counter cleared once dead-lettered"  # noqa: SLF001


@pytest.mark.asyncio
async def test_a_plain_outage_is_still_retried_beyond_the_poison_cap_then_bounded(monkeypatch):
    c, mailer, _t, dlq, _p = _wire(monkeypatch, OUTAGE)
    raw = _event("partner@outside.test", primary=True)

    # A genuine outage (or a token mid-refresh) keeps its retries: well past
    # poison_max_failures (3) it has NOT been dead-lettered...
    for _ in range(rc._PROVIDER_UNAVAILABLE_MAX_FAILURES - 1):  # noqa: SLF001
        assert await c._handle(raw) is False  # noqa: SLF001
    assert dlq == []
    # ...but it is finite.
    assert await c._handle(raw) is True  # noqa: SLF001
    assert len(dlq) == 1
    assert mailer.sends == []


@pytest.mark.asyncio
async def test_the_failure_counter_is_per_mail(monkeypatch):
    c, _m, _t, dlq, _p = _wire(monkeypatch, CONFLICT)
    a = _event("partner@outside.test", primary=True, eventId="evt-a")
    b = _event("partner@outside.test", primary=True, eventId="evt-b")

    assert await c._handle(a) is False  # noqa: SLF001
    assert await c._handle(a) is False  # noqa: SLF001
    assert await c._handle(b) is False, "b starts from its own count"  # noqa: SLF001
    assert dlq == []


@pytest.mark.asyncio
async def test_a_stuck_mail_no_longer_blocks_its_partition_forever(monkeypatch):
    """Drive the real _consume_loop: the 409 mail is rewound until the cap, then
    the offset commits and the loop proceeds (the old code never committed)."""
    monkeypatch.setattr(rc, "_RETRY_BACKOFF", 0)
    c, _m, _t, dlq, provider = _wire(monkeypatch, CONFLICT)
    from tests.test_redelivery import _SeekableConsumer, _messages

    fake = _SeekableConsumer(_messages(_event("partner@outside.test", primary=True)))
    fake.on_done = c._stop.set  # noqa: SLF001

    await c._consume_loop(fake)  # noqa: SLF001

    assert provider.calls == 3
    assert fake.commits == 1, "committed only after the DLQ"
    assert len(dlq) == 1


@pytest.mark.asyncio
async def test_a_retry_below_the_cap_still_releases_the_claim(monkeypatch):
    c, _m, _t, _dlq, _p = _wire(monkeypatch, CONFLICT)
    released: list[tuple[str, str]] = []

    async def _release(event_id, key):
        released.append((event_id, key))

    c._release_claim = _release  # noqa: SLF001

    assert await c._handle(_event("partner@outside.test", primary=True)) is False  # noqa: SLF001
    assert released and released[0][1] == MAIL_ID


# ── provider_mail marks the 409 so the caller can tell it apart ──────────────


def _client(status: int) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(lambda _r: httpx.Response(status)))


async def _send(client):
    return await pm.send(
        client, "http://integrations-svc:8005", "tok", org_id="o", author_id="u",
        mail_id=MAIL_ID, subject="s", text_body="t", html_body="<p>t</p>",
        to=["a@b.test"], cc=[], bcc=[], attachments=[],
    )


@pytest.mark.asyncio
async def test_provider_mail_flags_a_409_as_a_conflict_and_a_503_as_not():
    async with _client(409) as c:
        with pytest.raises(ProviderMailUnavailable) as e:
            await _send(c)
    assert e.value.conflict is True
    async with _client(503) as c:
        with pytest.raises(ProviderMailUnavailable) as e:
            await _send(c)
    assert e.value.conflict is False
    assert json.dumps(str(e.value))  # message stays serialisable for the DLQ envelope
