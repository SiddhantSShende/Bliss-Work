"""POST /auth/refresh: a rejection that revokes a token family must PERSIST the
revocation, against a real Postgres.

── Why this cannot be a mock-only test ───────────────────────────────────────
rotate_refresh_token revokes the whole family and only THEN raises 'reused' (or
'deactivated'). The handler used to call it inside `async with engine.begin()`
and catch the error outside, so the exception left the transaction and the
revocation was rolled back: a replayed stolen token got its 401, but the
thief's copy of the current token kept rotating for the family's full lifetime.
Only a real transaction shows whether the UPDATE survived.

Same shape as test_create_org_lockout.py: the route function is called
directly, with auth_routes.engine pointed at the migrated test database.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from starlette.responses import Response

from app import service
from app.routes import auth as auth_routes
from app.schemas import RefreshRequest

pytestmark = pytest.mark.integration


@pytest.fixture
async def real_engine(monkeypatch: pytest.MonkeyPatch, sa_engine):
    monkeypatch.setattr(auth_routes, "engine", sa_engine)
    monkeypatch.setattr(service, "engine", sa_engine)
    return sa_engine


async def _rotated_family(engine) -> tuple[str, str, str]:
    """A family whose first token was rotated into a second one, long enough ago
    that the replay-grace window has passed. Returns (family_id, stale, current)."""
    user_id, family_id = str(uuid.uuid4()), str(uuid.uuid4())
    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)
        stale_raw, stale_id = await service.issue_refresh_token(conn, user_id=user_id, family_id=family_id)
        current_raw, current_id = await service.issue_refresh_token(conn, user_id=user_id, family_id=family_id)
        await conn.execute(
            text("UPDATE refresh_tokens SET rotated_to = :to, revoked = true WHERE id = :id"),
            {"to": current_id, "id": stale_id},
        )
        await conn.execute(
            text("UPDATE refresh_tokens SET issued_at = now() - interval '10 minutes' WHERE family_id = :fam"),
            {"fam": family_id},
        )
    return family_id, stale_raw, current_raw


async def _revoked_flags(engine, family_id: str) -> list[bool]:
    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)
        rows = await conn.execute(
            text("SELECT revoked FROM refresh_tokens WHERE family_id = :fam ORDER BY issued_at, id"),
            {"fam": family_id},
        )
        return [r.revoked for r in rows]


async def _refresh(raw: str):
    return await auth_routes.refresh(Response(), body=RefreshRequest(token=raw), refresh_token=None)


async def test_replaying_a_rotated_token_revokes_the_whole_family(real_engine):
    family_id, stale, current = await _rotated_family(real_engine)

    rejected = await _refresh(stale)

    assert rejected.status_code == 401 and b'"code":"reused"' in rejected.body
    # The stale token was already revoked; what matters is the CURRENT one — the
    # copy the thief would be holding.
    assert await _revoked_flags(real_engine, family_id) == [True, True]
    assert (await _refresh(current)).status_code == 401


async def test_a_deactivated_member_is_rejected_and_the_family_stays_revoked(real_engine):
    # No users row: the membership backstop treats that as deactivated.
    user_id, family_id = str(uuid.uuid4()), str(uuid.uuid4())
    async with real_engine.begin() as conn:
        await service.set_bypass_rls(conn)
        raw, _ = await service.issue_refresh_token(conn, user_id=user_id, family_id=family_id)

    rejected = await _refresh(raw)

    assert rejected.status_code == 401 and b'"code":"deactivated"' in rejected.body
    assert await _revoked_flags(real_engine, family_id) == [True]


async def test_an_unknown_token_is_rejected_and_touches_no_family(real_engine):
    family_id, _, _ = await _rotated_family(real_engine)
    before = await _revoked_flags(real_engine, family_id)

    rejected = await _refresh("not-a-token-anyone-issued")

    assert rejected.status_code == 401 and b'"code":"unknown"' in rejected.body
    assert await _revoked_flags(real_engine, family_id) == before
