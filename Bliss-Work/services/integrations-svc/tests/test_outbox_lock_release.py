"""outbox.py's FOR UPDATE SKIP LOCKED lock must survive an oversize quarantine.

_drain_once claims a batch with `FOR UPDATE SKIP LOCKED` specifically so a
second replica claims a different batch rather than racing this one (see the
comment at the SELECT). Committing that same session to quarantine an
oversized row releases the lock on EVERY row in the batch, not just the
oversized one — including rows still queued to be published below, letting a
second replica double-publish them. The fix commits the quarantine on a
separate session instead.
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


async def test_oversize_quarantine_commits_on_a_separate_session(monkeypatch):
    good = _Row("good-1", "topic.a", "k1", {"small": True})
    bad = _Row("bad-1", "topic.a", "k2", {"huge": True})
    rows = [bad, good]

    main_db = _FakeDb(select_rows=rows)
    sessions_created: list[_FakeDb] = []

    def _session_factory():
        # First call (the batch SELECT) is main_db; every later call (the
        # oversize quarantine) gets a fresh, separate one.
        db = main_db if not sessions_created else _FakeDb()
        sessions_created.append(db)
        return _FakeSessionCtx(db)

    monkeypatch.setattr(outbox_module, "session", _session_factory)
    monkeypatch.setattr(outbox_module, "payload_bytes", lambda p: 10**9 if p.get("huge") else 10)
    monkeypatch.setattr(outbox_module, "quarantine_oversize", _noop)

    poller = OutboxPoller()
    poller._lazy_producer._producer = _FakeProducer()  # noqa: SLF001 — skip real Kafka connect

    published = await poller._drain_once()  # noqa: SLF001

    assert published == 1  # only the non-oversized row
    assert len(sessions_created) == 2  # the batch session + a separate quarantine session
    quarantine_db = sessions_created[1]
    assert quarantine_db.committed is True
    assert quarantine_db is not main_db
    # The batch session's own commit (publishing "good-1") must be a SEPARATE,
    # LATER event from the quarantine session's — never the same commit that
    # released the SKIP LOCKED lock on "good-1" before it was actually published.
    assert main_db.committed is True
    assert poller._lazy_producer._producer.sent == ["k1"]  # noqa: SLF001
