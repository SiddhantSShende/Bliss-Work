"""outbox.py's FOR UPDATE SKIP LOCKED lock must survive an oversize quarantine.

_drain_once claims a batch with `FOR UPDATE SKIP LOCKED` specifically so a
second replica claims a different batch rather than racing this one (see the
comment at the SELECT). Two ways to get the quarantine wrong:

  * Committing the claiming session to quarantine an oversized row releases the
    lock on EVERY row in the batch (and the drain advisory lock), letting a
    second replica double-publish rows still queued below.
  * Quarantining on a SECOND session self-deadlocks: that session's UPDATE waits
    on the row locks the claiming session holds, until statement_timeout, so the
    row is never quarantined and every tick errors.

The fix quarantines on the claiming session itself and commits once, after the
send loop.
"""
from __future__ import annotations

import pytest

from app import outbox as outbox_module
from app.outbox import OutboxPoller


class _FakeResult:
    def __init__(self, rows: list) -> None:
        self._rows = rows

    def all(self):
        return self._rows

    def scalar_one(self):
        return self._rows[0]


class _Row:
    def __init__(self, id_: str, topic: str, kafka_key: str, payload: dict) -> None:
        self.id = id_
        self.topic = topic
        self.kafka_key = kafka_key
        self.payload = payload


class _FakeDb:
    def __init__(self, select_rows: list | None = None) -> None:
        self.executed: list[tuple[str, dict | None]] = []
        self.committed = False
        self._select_rows = select_rows or []

    async def execute(self, stmt, params=None):
        sql = str(stmt)
        self.executed.append((sql, params))
        if "pg_try_advisory_xact_lock" in sql:
            return _FakeResult([True])  # the drain lock is free
        if sql.strip().upper().startswith("SELECT"):
            return _FakeResult(self._select_rows)
        return _FakeResult([])

    async def commit(self) -> None:
        self.committed = True

    async def rollback(self) -> None:
        pass


class _FakeSessionCtx:
    def __init__(self, db: _FakeDb) -> None:
        self._db = db

    async def __aenter__(self) -> _FakeDb:
        return self._db

    async def __aexit__(self, *_exc) -> bool:
        return False


class _FakeProducer:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_and_wait(self, topic, value=None, key=None, headers=None):
        self.sent.append(key)


async def _noop(*_a, **_kw) -> None:
    return None


@pytest.fixture(autouse=True)
def _bypass_rls(monkeypatch):
    monkeypatch.setattr(outbox_module, "set_bypass_rls", _noop)


async def test_oversize_quarantine_rides_the_claiming_session_and_commits_after_sends(monkeypatch):
    good = _Row("good-1", "topic.a", "k1", {"small": True})
    bad = _Row("bad-1", "topic.a", "k2", {"huge": True})

    main_db = _FakeDb(select_rows=[bad, good])
    sessions_created: list[_FakeDb] = []
    events: list[str] = []

    def _session_factory():
        db = main_db if not sessions_created else _FakeDb()
        sessions_created.append(db)
        return _FakeSessionCtx(db)

    async def _quarantine(conn, ids):
        assert conn is main_db  # the connection that holds the row locks
        events.append(f"quarantine:{ids}")

    async def _commit() -> None:
        events.append("commit")
        main_db.committed = True

    main_db.commit = _commit
    producer = _FakeProducer()
    orig_send = producer.send_and_wait

    async def _send(*a, **kw):
        events.append("send")
        await orig_send(*a, **kw)

    producer.send_and_wait = _send
    monkeypatch.setattr(outbox_module, "session", _session_factory)
    monkeypatch.setattr(outbox_module, "payload_bytes", lambda p: 10**9 if p.get("huge") else 10)
    monkeypatch.setattr(outbox_module, "quarantine_oversize", _quarantine)

    poller = OutboxPoller()
    poller._lazy_producer._producer = producer  # noqa: SLF001 — skip real Kafka connect

    published = await poller._drain_once()  # noqa: SLF001

    assert published == 1  # only the non-oversized row
    assert len(sessions_created) == 1  # no second session: it would wait on our row locks
    # Exactly one commit, AFTER the healthy row was sent: committing earlier
    # would release the SKIP LOCKED / advisory locks on rows still to be sent.
    assert events == ["quarantine:['bad-1']", "send", "commit"]
    assert producer.sent == ["k1"]


async def test_a_batch_that_is_only_oversize_still_commits_the_quarantine(monkeypatch):
    bad = _Row("bad-1", "topic.a", "k2", {"huge": True})
    main_db = _FakeDb(select_rows=[bad])
    quarantined: list = []

    async def _quarantine(conn, ids):
        quarantined.append((conn, ids))

    monkeypatch.setattr(outbox_module, "session", lambda: _FakeSessionCtx(main_db))
    monkeypatch.setattr(outbox_module, "payload_bytes", lambda p: 10**9)
    monkeypatch.setattr(outbox_module, "quarantine_oversize", _quarantine)

    poller = OutboxPoller()
    poller._lazy_producer._producer = _FakeProducer()  # noqa: SLF001

    assert await poller._drain_once() == 0  # noqa: SLF001
    assert quarantined == [(main_db, ["bad-1"])]
    # Nothing was published, but the session must still commit or it rolls the
    # quarantine back on close and the row blocks the queue forever.
    assert main_db.committed is True
