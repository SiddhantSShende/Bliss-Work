"""RefreshWorker's sweep loop and per-connection error handling.

Real Postgres/Kafka never enter here — the DB session is a bare stand-in, so
these pin the two behaviors that matter regardless of what's actually stored:
one connection's failure must not stop the sweep from reaching the rest of the
batch, and a connection whose OAuth app credentials are gone must surface as
status='error' rather than silently staying 'connected' forever.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from app import refresh_worker as rw_module
from app.refresh_worker import RefreshWorker


async def _noop(*_a, **_kw) -> None:
    return None


class _FakeResult:
    rowcount = 1

    def __init__(self, rows: list) -> None:
        self._rows = rows

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None


class _FakeRow:
    def __init__(self, id_: str, org_id: str, provider: str, refresh_token_enc: bytes) -> None:
        self.id = id_
        self.org_id = org_id
        self.provider = provider
        self.refresh_token_enc = refresh_token_enc


class _ClaimedRefresh:
    def __init__(self, credential_id: str | None) -> None:
        self.refresh_token_enc = b"rt"
        self.oauth_app_credential_id = credential_id


class _FakeDb:
    """Records every execute() call; SELECT returns canned rows, everything
    else (UPDATE) returns an empty result. Never touches real SQL/Postgres."""

    def __init__(
        self, select_rows: list | None = None, credential_id: str | None = None
    ) -> None:
        self.executed: list[tuple[str, dict | None]] = []
        self._select_rows = select_rows or []
        self._credential_id = credential_id

    async def execute(self, stmt, params=None):
        sql = str(stmt)
        self.executed.append((sql, params))
        if sql.strip().upper().startswith("SELECT"):
            return _FakeResult(self._select_rows)
        if "RETURNING refresh_token_enc, oauth_app_credential_id" in sql:
            return _FakeResult([_ClaimedRefresh(self._credential_id)])
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


async def test_refresh_due_limits_concurrent_provider_calls(monkeypatch):
    rows = [
        _FakeRow(f"conn-{i}", f"org-{i}", "gmail", b"rt")
        for i in range(rw_module._CONCURRENCY + 3)
    ]
    fake_db = _FakeDb(rows)
    monkeypatch.setattr(rw_module, "session", lambda: _FakeSession(fake_db))
    active = 0
    peak = 0

    async def fake_refresh_one(_self, *_args):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0)
        active -= 1

    monkeypatch.setattr(RefreshWorker, "_refresh_one", fake_refresh_one)
    await RefreshWorker()._refresh_due()
    assert peak == rw_module._CONCURRENCY
    select_sql = next(sql for sql, _ in fake_db.executed if sql.strip().upper().startswith("SELECT"))
    assert "refresh_next_attempt_at" in select_sql


async def test_refresh_due_schedules_independent_retry_after_row_failure(monkeypatch):
    rows = [
        _FakeRow("conn-1", "org-1", "gmail", b"rt"),
        _FakeRow("conn-2", "org-2", "gmail", b"rt"),
    ]
    fake_db = _FakeDb(rows)
    monkeypatch.setattr(rw_module, "session", lambda: _FakeSession(fake_db))
    attempted: list[str] = []

    async def fake_refresh_one(_self, conn_id, *_args):
        attempted.append(conn_id)
        if conn_id == "conn-1":
            raise RuntimeError("temporary provider failure")

    monkeypatch.setattr(RefreshWorker, "_refresh_one", fake_refresh_one)
    await RefreshWorker()._refresh_due()
    assert attempted == ["conn-1", "conn-2"]
    retry_update = next(sql for sql, _ in fake_db.executed if "refresh_failure_count" in sql)
    assert "refresh_next_attempt_at" in retry_update
    assert "refresh_claimed_at = NULL" in retry_update


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
    assert len(updates) == 2
    assert "refresh_claimed_at = now()" in updates[0]
    assert "status='error'" in updates[1]


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
    assert len(updates) == 2
    assert "refresh_claimed_at = now()" in updates[0]
    assert "status = 'connected'" in updates[1]
    assert "status='error'" not in updates[1]


async def test_refresh_uses_legacy_connection_app_id_when_pinned(monkeypatch):
    fake_db = _FakeDb(credential_id="legacy-app-id")
    monkeypatch.setattr(rw_module, "session", lambda: _FakeSession(fake_db))
    monkeypatch.setattr(rw_module.app_credentials, "vendor_for", lambda _p: "microsoft")
    legacy_credentials = AsyncMock(return_value=object())
    monkeypatch.setattr(rw_module.app_credentials, "load_by_id", legacy_credentials)
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

    await RefreshWorker()._refresh_one("conn-1", "org-1", "teams", b"rt")

    legacy_credentials.assert_awaited_once_with(fake_db, "org-1", "legacy-app-id")
