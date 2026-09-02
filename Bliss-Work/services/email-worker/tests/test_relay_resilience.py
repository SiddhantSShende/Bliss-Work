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
"""
from __future__ import annotations

import types

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

    async def fetchrow(self, *_a, **_kw):
        raise ConnectionError("connection reset by peer")

    async def execute(self, *_a, **_kw):
        raise ConnectionError("connection reset by peer")

    async def fetch(self, *_a, **_kw):
        raise ConnectionError("connection reset by peer")

    async def executemany(self, *_a, **_kw):
        raise ConnectionError("connection reset by peer")


class _FlakyThenOkConn:
    """Fails the first N calls, then succeeds — stands in for a DB blip that
    clears up within a couple of retries."""

    def __init__(self, fail_times: int) -> None:
        self.fail_times = fail_times
        self.calls = 0

    async def execute(self, *_a, **_kw):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise ConnectionError("connection reset by peer")
        return "UPDATE 1"


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
