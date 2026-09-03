"""RefreshWorker's sweep loop and per-connection error handling.

Real Postgres/Kafka never enter here — the DB session is a bare stand-in, so
these pin the two behaviors that matter regardless of what's actually stored:
one connection's failure must not stop the sweep from reaching the rest of the
batch, and a connection whose OAuth app credentials are gone must surface as
status='error' rather than silently staying 'connected' forever.
"""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from app import refresh_worker as rw_module
from app.refresh_worker import RefreshWorker


async def _noop(*_a, **_kw) -> None:
    return None


class _FakeResult:
    def __init__(self, rows: list) -> None:
        self._rows = rows

    def all(self):
        return self._rows


class _FakeRow:
    def __init__(self, id_: str, org_id: str, provider: str, refresh_token_enc: bytes) -> None:
        self.id = id_
        self.org_id = org_id
        self.provider = provider
        self.refresh_token_enc = refresh_token_enc


class _FakeDb:
    """Records every execute() call; SELECT returns canned rows, everything
    else (UPDATE) returns an empty result. Never touches real SQL/Postgres."""

    def __init__(self, select_rows: list | None = None) -> None:
        self.executed: list[tuple[str, dict | None]] = []
        self._select_rows = select_rows or []

    async def execute(self, stmt, params=None):
        sql = str(stmt)
        self.executed.append((sql, params))
        if sql.strip().upper().startswith("SELECT"):
            return _FakeResult(self._select_rows)
        return _FakeResult([])

    async def commit(self) -> None:
        pass

    async def rollback(self) -> None:
        pass


class _FakeSession:
    def __init__(self, db: _FakeDb) -> None:
        self._db = db

    async def __aenter__(self) -> _FakeDb:
        return self._db

    async def __aexit__(self, *_exc) -> bool:
        return False


@pytest.fixture(autouse=True)
def _bypass_rls(monkeypatch):
    monkeypatch.setattr(rw_module, "set_bypass_rls", _noop)


# ── #1: one connection's failure must not block the rest of the batch ───────


async def test_refresh_due_does_not_stop_at_the_first_failing_connection(monkeypatch):
    rows = [
        _FakeRow("conn-1", "org-1", "gmail", b"rt1"),
        _FakeRow("conn-2", "org-2", "gmail", b"rt2"),
        _FakeRow("conn-3", "org-3", "gmail", b"rt3"),
    ]
    fake_db = _FakeDb(rows)
    monkeypatch.setattr(rw_module, "session", lambda: _FakeSession(fake_db))

    attempted: list[str] = []

    async def fake_refresh_one(_self, conn_id, _org_id, _provider, _rt_enc):
        attempted.append(conn_id)
        if conn_id == "conn-1":
            # Simulates a failure AFTER the token exchange succeeded (the
            # encrypt call or the UPDATE/commit) — the one class of error
            # _refresh_one's own try/except does not cover.
            raise RuntimeError("simulated post-exchange failure")

    monkeypatch.setattr(RefreshWorker, "_refresh_one", fake_refresh_one)

    worker = RefreshWorker()
    await worker._refresh_due()  # must not raise

    # conn-1 failing must not have prevented conn-2/conn-3 from being tried —
    # before the fix, the exception escaped the loop and only conn-1 ran.
    assert attempted == ["conn-1", "conn-2", "conn-3"]


# ── #4: deleted/rotated-out app credentials must surface as status='error' ──


async def test_missing_app_credentials_marks_the_connection_error(monkeypatch):
    fake_db = _FakeDb()
    monkeypatch.setattr(rw_module, "session", lambda: _FakeSession(fake_db))
    monkeypatch.setattr(rw_module.app_credentials, "vendor_for", lambda _provider: "google")
    monkeypatch.setattr(rw_module.app_credentials, "load", AsyncMock(return_value=None))
    # No org row and no server-env fallback for this provider — config_for
    # returns None exactly as it does in that situation for real.
    monkeypatch.setattr(rw_module.oauth, "config_for", lambda _provider, _creds: None)

    worker = RefreshWorker()
    await worker._refresh_one("conn-1", "org-1", "gmail", b"rt")

    updates = [sql for sql, _ in fake_db.executed if sql.strip().upper().startswith("UPDATE")]
    assert len(updates) == 1
    assert "status='error'" in updates[0]


async def test_a_working_refresh_never_touches_status(monkeypatch):
    # Guards the test above against a false positive: config_for succeeding
    # must NOT also hit the status='error' branch.
    fake_db = _FakeDb()
    monkeypatch.setattr(rw_module, "session", lambda: _FakeSession(fake_db))
    monkeypatch.setattr(rw_module.app_credentials, "vendor_for", lambda _provider: "google")
    monkeypatch.setattr(rw_module.app_credentials, "load", AsyncMock(return_value=object()))
    monkeypatch.setattr(rw_module.oauth, "config_for", lambda _provider, _creds: object())

    class _FakeCryptor:
        async def decrypt(self, _db, _org, _blob):
            return "refresh-token"

        async def encrypt(self, _db, _org, _value):
            return b"enc"

    monkeypatch.setattr(rw_module, "cryptor", lambda: _FakeCryptor())
    monkeypatch.setattr(
        rw_module.oauth,
        "refresh_access_token",
        AsyncMock(return_value={"access_token": "new-token", "expires_in": 3600}),
    )

    worker = RefreshWorker()
    await worker._refresh_one("conn-1", "org-1", "gmail", b"rt")

    updates = [sql for sql, _ in fake_db.executed if sql.strip().upper().startswith("UPDATE")]
    assert len(updates) == 1
    assert "status = 'connected'" in updates[0]
    assert "status='error'" not in updates[0]
