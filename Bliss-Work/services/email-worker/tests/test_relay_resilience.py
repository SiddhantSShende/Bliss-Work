"""Regression tests for three related dedup/reaper bugs found in one audit:

  * The reaper used to reclaim ANY 'pending' row older than 30s, with no way
    to tell "still being retried by this process" apart from "actually
    abandoned". Mailer.send() retries internally for up to ~100s, so an
    ordinary in-flight retry could get flipped to 'sent' out from under
    itself — and if the send then genuinely failed, the redelivery that
    should have retried it was skipped as an already-sent duplicate,
    silently losing the message forever. _mark_inflight / _reap_once fix
    this by excluding whatever this process currently has in flight.

  * _is_sent / _mark_sent (and worker.py's _already_sent) used to be
    unguarded DB calls. A transient Postgres error at exactly the wrong
    moment (pool exhaustion, a brief failover) propagated all the way out of
    asyncio.gather in __main__.py and killed the ENTIRE worker process —
    every notification, invite, reset, and relayed mail, not just the one
    event that hit the error.

  * _mark_sent's write happens after the send already succeeded, so a DB
    error there can't be allowed to silently look like success (or crash the
    process) — it now retries a few times before giving up, narrowing the
    real-world window in which a crash right there could cause a redelivery
    to resend a message that already went out.

  * _read_transport / _record_transport (mail.outbound's transport-decision
    bookkeeping) were unguarded DB calls with no boundary above them at all —
    unlike every other DB call in this file, _handle_outbound_mail wrapped
    NONE of it in a try/except, so a transient Postgres error here didn't
    just fail one message, it propagated out of _handle, _consume_loop and
    run(), killing the whole worker process. _read_transport now retries
    like _mark_sent (giving up too early would look identical to "nobody
    decided yet" to the deciding copy, which could then send a user's mail
    through their mailbox a second time); _record_transport is best-effort
    like _mark_sent's write is; and _handle_outbound_mail now has the same
    catch-all boundary _handle already puts around the notification path.
"""
from __future__ import annotations

import json
import types

import asyncpg
import pytest

from app import relay_consumer, worker
from app.relay_consumer import RelayConsumer
from app.worker import EmailWorker


@pytest.fixture(autouse=True)
def _no_real_backoff(monkeypatch):
    """_mark_sent's retry backoff is real time (0.5s/1s) in production; skip
    the wait here so these tests stay fast without changing the retry count
    or control flow being tested."""

    async def _instant_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(relay_consumer.asyncio, "sleep", _instant_sleep)
    monkeypatch.setattr(worker.asyncio, "sleep", _instant_sleep)


def _relay_settings() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        smtp_host="mailpit", smtp_port=1025, smtp_from="no-reply@test.local",
        smtp_username="", smtp_password="", smtp_starttls=False,
        redis_url="redis://localhost:6379/0", poison_max_failures=3,
    )


class _Row(dict):
    """asyncpg Records support both attribute-free item access and __getitem__;
    a plain dict already satisfies every use of a row in the code under test."""


class _FailingConn:
    """A DB connection whose every call raises, to prove a hiccup here costs
    one operation, not the process."""

    def __init__(self, exc: BaseException | None = None) -> None:
        self._exc = exc or ConnectionError("connection reset by peer")

    async def fetchrow(self, *_a, **_kw):
        raise self._exc

    async def fetchval(self, *_a, **_kw):
        raise self._exc

    async def execute(self, *_a, **_kw):
        raise self._exc

    async def fetch(self, *_a, **_kw):
        raise self._exc

    async def executemany(self, *_a, **_kw):
        raise self._exc


class _FlakyThenOkConn:
    """Fails the first N calls, then succeeds — stands in for a DB blip that
    clears up within a couple of retries."""

    def __init__(
        self,
        fail_times: int,
        fetchval_result: str | None = None,
        fetchrow_result: dict | None = None,
    ) -> None:
        self.fail_times = fail_times
        self.calls = 0
        self._fetchval_result = fetchval_result
        self._fetchrow_result = fetchrow_result

    async def execute(self, *_a, **_kw):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise ConnectionError("connection reset by peer")
        return "UPDATE 1"

    async def fetchval(self, *_a, **_kw):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise ConnectionError("connection reset by peer")
        return self._fetchval_result

    async def fetchrow(self, *_a, **_kw):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise ConnectionError("connection reset by peer")
        return self._fetchrow_result


class _Pool:
    """Minimal stand-in for asyncpg.Pool: only .acquire() as an async
    context manager, handing back the same connection every time."""

    def __init__(self, conn) -> None:
        self._conn = conn

    def acquire(self):
        return self

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


class _FetchOnlyConn:
    """Returns fixed candidate rows from fetch(); records what executemany()
    was asked to update."""

    def __init__(self, rows: list[dict]) -> None:
        self._rows = rows
        self.updated: list[tuple] = []

    async def fetch(self, *_a, **_kw):
        return [_Row(r) for r in self._rows]

    async def executemany(self, _sql, rows):
        self.updated.extend(rows)


# ── _is_sent / _already_sent: a DB error must not propagate ─────────────────


async def test_relay_is_sent_survives_a_db_error():
    consumer = RelayConsumer(_relay_settings())
    consumer._db = _Pool(_FailingConn())  # noqa: SLF001

    result = await consumer._is_sent("evt-1", "recipient-1")  # noqa: SLF001

    assert result is False  # treated as "not confirmed sent" -> normal retry path


async def test_worker_already_sent_survives_a_db_error():
    worker = EmailWorker(_relay_settings())
    worker._db = _Pool(_FailingConn())  # noqa: SLF001

    result = await worker._already_sent("evt-1")  # noqa: SLF001

    assert result is False


# ── _mark_sent: retries a DB hiccup, then gives up without raising ──────────


async def test_relay_mark_sent_retries_a_transient_failure_and_succeeds():
    consumer = RelayConsumer(_relay_settings())
    conn = _FlakyThenOkConn(fail_times=2)
    consumer._db = _Pool(conn)  # noqa: SLF001

    ok = await consumer._mark_sent("evt-1", "recipient-1")  # noqa: SLF001

    assert ok is True
    assert conn.calls == 3


async def test_relay_mark_sent_gives_up_after_repeated_failure_without_raising():
    consumer = RelayConsumer(_relay_settings())
    consumer._db = _Pool(_FailingConn())  # noqa: SLF001

    ok = await consumer._mark_sent("evt-1", "recipient-1")  # noqa: SLF001

    assert ok is False  # logged, not raised — must not crash the process


async def test_worker_mark_sent_retries_a_transient_failure_and_succeeds():
    worker = EmailWorker(_relay_settings())
    conn = _FlakyThenOkConn(fail_times=1)
    worker._db = _Pool(conn)  # noqa: SLF001

    ok = await worker._mark_sent("evt-1", "recipient-1")  # noqa: SLF001

    assert ok is True
    assert conn.calls == 2


# ── reaper: must not reclaim a row this process is still retrying ───────────


async def test_reap_once_skips_rows_this_process_has_inflight():
    consumer = RelayConsumer(_relay_settings())
    conn = _FetchOnlyConn([
        {"event_id": "evt-inflight", "recipient_id": "r1"},
        {"event_id": "evt-abandoned", "recipient_id": "r2"},
    ])
    consumer._db = _Pool(conn)  # noqa: SLF001
    consumer._inflight.add(("evt-inflight", "r1"))  # noqa: SLF001

    await consumer._reap_once()  # noqa: SLF001

    assert conn.updated == [("evt-abandoned", "r2")]


async def test_reap_once_reclaims_nothing_when_everything_is_inflight():
    consumer = RelayConsumer(_relay_settings())
    conn = _FetchOnlyConn([{"event_id": "evt-1", "recipient_id": "r1"}])
    consumer._db = _Pool(conn)  # noqa: SLF001
    consumer._inflight.add(("evt-1", "r1"))  # noqa: SLF001

    await consumer._reap_once()  # noqa: SLF001

    assert conn.updated == []


async def test_reap_once_survives_a_db_error():
    consumer = RelayConsumer(_relay_settings())
    consumer._db = _Pool(_FailingConn())  # noqa: SLF001

    await consumer._reap_once()  # noqa: SLF001 - must not raise


# ── _mark_inflight: adds for the duration of the block, removes after ───────


async def test_mark_inflight_is_present_during_the_block_and_gone_after():
    consumer = RelayConsumer(_relay_settings())
    marker = ("evt-1", "recipient-1")

    async with consumer._mark_inflight(*marker):  # noqa: SLF001
        assert marker in consumer._inflight  # noqa: SLF001
    assert marker not in consumer._inflight  # noqa: SLF001


async def test_mark_inflight_is_removed_even_if_the_block_raises():
    consumer = RelayConsumer(_relay_settings())
    marker = ("evt-1", "recipient-1")

    with pytest.raises(ValueError):
        async with consumer._mark_inflight(*marker):  # noqa: SLF001
            raise ValueError("boom")

    assert marker not in consumer._inflight  # noqa: SLF001


# ── _read_transport / _record_transport / _handle_outbound_mail's boundary ──


async def test_relay_read_transport_retries_a_transient_failure_and_succeeds():
    consumer = RelayConsumer(_relay_settings())
    conn = _FlakyThenOkConn(
        fail_times=2,
        fetchrow_result=_Row(
            transport=relay_consumer.TRANSPORT_PROVIDER, covered_envelopes=["partner@outside.test"]
        ),
    )
    consumer._db = _Pool(conn)  # noqa: SLF001

    result = await consumer._read_transport("mail-1")  # noqa: SLF001

    assert result == (relay_consumer.TRANSPORT_PROVIDER, frozenset({"partner@outside.test"}))
    assert conn.calls == 3


async def test_relay_read_transport_treats_a_null_covered_set_as_unknown():
    # A 'provider' row written before 0003_mail_transport_covered_envelopes.sql
    # shipped has covered_envelopes = NULL — there was nowhere to record it.
    # Must come back as covered=None (the caller then falls back to the OLD
    # "assume covered" behavior for that row) rather than an empty frozenset,
    # which would look identical to "the provider send covered nobody" and
    # relay every copy of an in-flight, pre-migration mail a second time.
    consumer = RelayConsumer(_relay_settings())
    conn = _FlakyThenOkConn(
        fail_times=0,
        fetchrow_result=_Row(transport=relay_consumer.TRANSPORT_PROVIDER, covered_envelopes=None),
    )
    consumer._db = _Pool(conn)  # noqa: SLF001

    result = await consumer._read_transport("mail-1")  # noqa: SLF001

    assert result == (relay_consumer.TRANSPORT_PROVIDER, None)


async def test_relay_read_transport_gives_up_after_repeated_failure_without_raising():
    consumer = RelayConsumer(_relay_settings())
    consumer._db = _Pool(_FailingConn())  # noqa: SLF001

    result = await consumer._read_transport("mail-1")  # noqa: SLF001

    # None, not raised — the deciding copy in _decide_transport treats this
    # exactly like "no decision recorded yet" (safe: nothing has been sent),
    # and the non-deciding copies treat it as TRANSPORT_UNDECIDED, which
    # bounces through _on_failure's normal bounded-retry-then-DLQ path rather
    # than crashing.
    assert result is None


async def test_relay_read_transport_survives_pool_exhaustion():
    consumer = RelayConsumer(_relay_settings())
    consumer._db = _Pool(  # noqa: SLF001
        _FailingConn(asyncpg.exceptions.TooManyConnectionsError("sorry, too many clients already"))
    )

    result = await consumer._read_transport("mail-1")  # noqa: SLF001

    assert result is None


async def test_relay_record_transport_survives_a_db_error_without_retrying():
    consumer = RelayConsumer(_relay_settings())
    conn = _FlakyThenOkConn(fail_times=99)  # would never succeed within a retry budget
    consumer._db = _Pool(conn)  # noqa: SLF001

    await consumer._record_transport(  # noqa: SLF001 - must not raise
        "mail-1", relay_consumer.TRANSPORT_PROVIDER, frozenset({"partner@outside.test"})
    )

    # Exactly one attempt: transport bookkeeping is best-effort, not
    # delivery-critical (the provider send it follows already happened, so
    # retrying here can't change whether the mail went out, only delay
    # recording it) — unlike _mark_sent, which does retry.
    assert conn.calls == 1


def _outbound_mail_event(**overrides: object) -> dict:
    event: dict = {
        "type": "mail.outbound",
        "eventId": "evt-mail-1",
        "orgId": "org-1",
        "mailId": "mail-1",
        "envelope": "partner@outside.test",
        "authorId": "author-1",
        "providerCopy": True,
        "fromAddress": "jane@acme.test",
        "fromName": "Jane Okafor",
        "to": ["partner@outside.test"],
        "cc": [],
        "subject": "Q3 numbers",
        "bodyText": "Deck attached.",
        "providerTo": ["partner@outside.test"],
        "providerCc": [],
        "providerBcc": [],
    }
    event.update(overrides)
    return event


class _RecordingMailer:
    def __init__(self) -> None:
        self.sends: list[dict] = []

    async def send(self, **kwargs: object) -> None:
        self.sends.append(dict(kwargs))


def _outbound_consumer() -> RelayConsumer:
    """A consumer whose dedup layer always succeeds, for driving the real
    _handle / _handle_outbound_mail coroutines without a real DB pool."""
    consumer = RelayConsumer(_relay_settings())
    consumer._mailer = _RecordingMailer()  # noqa: SLF001
    consumer._presence = None  # noqa: SLF001 - mail.outbound is never presence-gated

    async def _claim(_event_id: str, _key: str) -> bool:
        return True

    async def _is_sent(_event_id: str, _key: str) -> bool:
        return False

    async def _mark_sent(_event_id: str, _key: str) -> bool:
        return True

    consumer._claim = _claim              # noqa: SLF001
    consumer._is_sent = _is_sent          # noqa: SLF001
    consumer._mark_sent = _mark_sent      # noqa: SLF001
    return consumer


async def test_handle_outbound_mail_survives_an_unexpected_decide_transport_failure():
    consumer = _outbound_consumer()

    async def _boom(*_a, **_kw):
        raise ConnectionError("connection reset by peer")

    consumer._decide_transport = _boom  # noqa: SLF001

    # No exception escapes _handle — the new boundary in _handle_outbound_mail
    # routes it through the same _on_failure poison-message handling every
    # other failure in this file already uses, instead of letting it crash
    # RelayConsumer.run() and every consumer in the process with it.
    result = await consumer._handle(json.dumps(_outbound_mail_event()).encode())  # noqa: SLF001

    assert result is False  # below the poison threshold: don't commit, Kafka redelivers
    assert consumer._mailer.sends == []  # noqa: SLF001 - never reached the send


async def test_handle_outbound_mail_failure_does_not_stop_the_consumer_processing_later_events():
    consumer = _outbound_consumer()
    calls = {"n": 0}

    async def _flaky_decide(*_a, **_kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("connection reset by peer")
        return relay_consumer.TRANSPORT_RELAY, frozenset()

    consumer._decide_transport = _flaky_decide  # noqa: SLF001

    first = await consumer._handle(  # noqa: SLF001
        json.dumps(_outbound_mail_event(eventId="evt-mail-1", mailId="mail-1")).encode()
    )
    assert first is False

    # A second, unrelated event on the same still-alive consumer instance —
    # proof the process (and this consumer) is still functioning normally,
    # not that one bad message took the whole thing down.
    second = await consumer._handle(  # noqa: SLF001
        json.dumps(_outbound_mail_event(eventId="evt-mail-2", mailId="mail-2")).encode()
    )
    assert second is True
    assert len(consumer._mailer.sends) == 1  # noqa: SLF001
