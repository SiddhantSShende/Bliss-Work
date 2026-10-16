"""B-INT-2: an in-flight token refresh must not resurrect a disconnected connection.

The refresh worker's Phase B (the provider call) runs outside any transaction.
If the user disconnected meanwhile (status 'revoked', every token NULLed), Phase C
UPDATEd the row WHERE id only — setting it back to 'connected' with fresh tokens,
so a connection the user explicitly removed came back to life. The terminal-error
path had the same hole (revoked -> 'error'), and a reconnect during the call would
have had its NEW tokens overwritten by ones derived from the OLD grant.

Real Postgres and the real DELETE route; only the provider's token endpoint (an
external system) is a stand-in, and it performs the user's action mid-call.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import httpx
import pytest
import uuid6
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
ME = "33333333-3333-3333-3333-333333333333"


async def _seed(refresh_plain: str = "old-refresh") -> tuple[str, bytes]:
    from crypto import cryptor
    from app.db import session, set_org_context

    conn_id = str(uuid6.uuid7())
    async with session() as db:
        await set_org_context(db, ORG)
        access_enc = await cryptor().encrypt(db, ORG, "old-access")
        refresh_enc = await cryptor().encrypt(db, ORG, refresh_plain)
        await db.execute(
            text(
                """
                INSERT INTO integration_connections
                    (id, org_id, owner_user_id, created_by, scope_kind, provider, status,
                     display_label, access_token_enc, refresh_token_enc, token_expires_at)
                VALUES (:id, :o, :u, :u, 'user', 'teams', 'connected', 'work',
                        :a, :r, now() + interval '1 minute')
                """
            ),
            {"id": conn_id, "o": ORG, "u": ME, "a": access_enc, "r": refresh_enc},
        )
        await db.commit()
    return conn_id, refresh_enc


async def _row(conn_id: str):
    from app.db import session, set_bypass_rls

    async with session() as db:
        await set_bypass_rls(db)
        return (
            await db.execute(
                text(
                    "SELECT status, access_token_enc, refresh_token_enc, last_error, "
                    "refresh_claimed_at FROM integration_connections WHERE id = :id"
                ),
                {"id": conn_id},
            )
        ).one()


async def _disconnect_via_route(conn_id: str) -> None:
    from app.auth import Principal, require_principal
    from app.main import app

    principal = Principal(user_id=ME, org_id=ORG, roles=[], username="me", plan="enterprise")
    app.dependency_overrides[require_principal] = lambda: principal
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        assert (await c.delete(f"/api/v1/integrations/{conn_id}")).status_code == 204


@pytest.fixture
def worker(monkeypatch):
    from app import refresh_worker as rw

    monkeypatch.setattr(rw.oauth, "config_for", lambda _p, _c: object())
    monkeypatch.setattr(rw, "_PERSIST_BACKOFF", 0)
    return rw.RefreshWorker(), rw


async def test_an_uninterrupted_refresh_still_stores_the_new_tokens(db_app, worker, monkeypatch):
    w, rw = worker
    conn_id, rt_enc = await _seed()
    monkeypatch.setattr(
        rw.oauth,
        "refresh_access_token",
        AsyncMock(return_value={"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600}),
    )

    await w._refresh_one(conn_id, ORG, "teams", rt_enc)  # noqa: SLF001

    row = await _row(conn_id)
    assert row.status == "connected" and row.refresh_claimed_at is None
    assert bytes(row.refresh_token_enc) != rt_enc, "the rotated refresh token was stored"


async def test_a_disconnect_during_the_refresh_is_not_undone(db_app, worker, monkeypatch):
    w, rw = worker
    conn_id, rt_enc = await _seed()

    async def _provider(_cfg, _refresh):
        await _disconnect_via_route(conn_id)  # the user clicks Disconnect mid-call
        return {"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600}

    monkeypatch.setattr(rw.oauth, "refresh_access_token", _provider)

    await w._refresh_one(conn_id, ORG, "teams", rt_enc)  # noqa: SLF001

    row = await _row(conn_id)
    assert row.status == "revoked", "disconnected connection must stay disconnected"
    assert row.access_token_enc is None and row.refresh_token_enc is None, "no fresh tokens written back"


async def test_a_terminal_refresh_error_does_not_overwrite_a_disconnect(db_app, worker, monkeypatch):
    w, rw = worker
    conn_id, rt_enc = await _seed()

    async def _provider(_cfg, _refresh):
        await _disconnect_via_route(conn_id)
        raise rw.oauth.OAuthError("invalid_grant")

    monkeypatch.setattr(rw.oauth, "refresh_access_token", _provider)

    await w._refresh_one(conn_id, ORG, "teams", rt_enc)  # noqa: SLF001

    row = await _row(conn_id)
    assert row.status == "revoked" and row.last_error is None


async def test_a_reconnect_during_the_refresh_keeps_the_new_credentials(db_app, worker, monkeypatch):
    from crypto import cryptor
    from app.db import session, set_bypass_rls

    w, rw = worker
    conn_id, rt_enc = await _seed()
    fresh = {}

    async def _provider(_cfg, _refresh):
        # The user reconnects: same row, brand-new grant.
        async with session() as db:
            await set_bypass_rls(db)
            fresh["rt"] = await cryptor().encrypt(db, ORG, "reconnected-refresh")
            await db.execute(
                text("UPDATE integration_connections SET refresh_token_enc = :r WHERE id = :id"),
                {"r": fresh["rt"], "id": conn_id},
            )
            await db.commit()
        return {"access_token": "stale-grant-access", "refresh_token": "stale-grant-refresh", "expires_in": 3600}

    monkeypatch.setattr(rw.oauth, "refresh_access_token", _provider)

    await w._refresh_one(conn_id, ORG, "teams", rt_enc)  # noqa: SLF001

    row = await _row(conn_id)
    assert bytes(row.refresh_token_enc) == bytes(fresh["rt"]), "tokens from the old grant must not replace the new ones"


async def test_a_transient_failure_storing_the_tokens_is_retried(db_app, worker, monkeypatch):
    w, rw = worker
    conn_id, rt_enc = await _seed()
    monkeypatch.setattr(
        rw.oauth,
        "refresh_access_token",
        AsyncMock(return_value={"access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600}),
    )
    real = rw.RefreshWorker._persist_tokens
    calls = {"n": 0}

    async def _flaky(self, *a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("db blip after the provider rotated the token")
        return await real(self, *a, **kw)

    monkeypatch.setattr(rw.RefreshWorker, "_persist_tokens", _flaky)

    await w._refresh_one(conn_id, ORG, "teams", rt_enc)  # noqa: SLF001

    assert calls["n"] == 2
    assert bytes((await _row(conn_id)).refresh_token_enc) != rt_enc, "the rotated token was not lost"
