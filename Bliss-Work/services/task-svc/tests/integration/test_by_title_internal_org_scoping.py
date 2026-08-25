"""`DELETE /internal/tasks/by-title/{title}` must never operate across orgs.

Regression test for the fix that made `org_id` a required parameter and
replaced an unconditional `set_bypass_rls` with `set_org_context(db, org_id)`
— previously this endpoint decrypted and title-matched EVERY task platform-wide
whenever `username` was omitted, and had no org filter at all on the
`username`-scoped branch either. See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md,
Phase 1.

Needs a real Postgres with RLS actually enforced (a non-owner role) — the
whole point is proving the DB itself, not just the endpoint's own SQL, blocks
a cross-org delete.
"""

from __future__ import annotations

import httpx
import pytest
import uuid6
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG_A = "11111111-1111-1111-1111-111111111111"
ORG_B = "22222222-2222-2222-2222-222222222222"
TEST_INTERNAL_TOKEN = "test-internal-token-for-by-title-suite"


async def _seed_task(org_id: str, title: str, *, username: str | None = None) -> str:
    """Insert one task (and optionally its sender's user_projection row) under
    bypass, using the real Cryptor so title_enc round-trips exactly like prod."""
    from crypto import cryptor
    from app.db import get_engine

    task_id = str(uuid6.uuid7())
    sender_id = str(uuid6.uuid7())
    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        title_enc = await cryptor().encrypt(conn, org_id, title)
        await conn.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, title_enc, description_enc) "
                "VALUES (:id, :org, :sender, :title_enc, :desc_enc)"
            ),
            {
                "id": task_id,
                "org": org_id,
                "sender": sender_id,
                "title_enc": title_enc,
                "desc_enc": await cryptor().encrypt(conn, org_id, ""),
            },
        )
        if username:
            await conn.execute(
                text(
                    "INSERT INTO user_projection (user_id, org_id, username, display_name) "
                    "VALUES (:uid, :org, :username, :username)"
                ),
                {"uid": sender_id, "org": org_id, "username": username},
            )
    return task_id


async def _task_exists(task_id: str) -> bool:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        row = (
            await conn.execute(text("SELECT 1 FROM tasks WHERE id = :id"), {"id": task_id})
        ).first()
        return row is not None


async def _client() -> httpx.AsyncClient:
    from app.main import app

    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture(autouse=True)
def _internal_token(db_app):
    from app.config import settings

    settings.internal_token = TEST_INTERNAL_TOKEN
    yield


async def test_org_id_is_required(db_app):
    async with await _client() as c:
        r = await c.delete(
            "/api/v1/internal/tasks/by-title/anything",
            headers={"X-Internal-Token": TEST_INTERNAL_TOKEN},
        )
        # FastAPI's own required-query-param validation — the service's
        # existing canonical error shape for a missing/malformed param
        # (errors.py), not a platform-wide scan.
        assert r.status_code == 422


async def test_cross_org_delete_is_a_no_op(db_app):
    task_id = await _seed_task(ORG_A, "Acme secret task")
    async with await _client() as c:
        r = await c.delete(
            "/api/v1/internal/tasks/by-title/Acme secret task",
            params={"org_id": ORG_B},
            headers={"X-Internal-Token": TEST_INTERNAL_TOKEN},
        )
        assert r.status_code == 200, r.text
        assert r.json()["deleted_tasks"] == 0
    assert await _task_exists(task_id) is True


async def test_same_org_delete_succeeds(db_app):
    task_id = await _seed_task(ORG_A, "Acme secret task")
    async with await _client() as c:
        r = await c.delete(
            "/api/v1/internal/tasks/by-title/Acme secret task",
            params={"org_id": ORG_A},
            headers={"X-Internal-Token": TEST_INTERNAL_TOKEN},
        )
        assert r.status_code == 200, r.text
        assert r.json()["deleted_tasks"] == 1
    assert await _task_exists(task_id) is False


async def test_username_branch_is_also_org_scoped(db_app):
    """A username that exists in org A must not let an org_id=B caller match it."""
    task_id = await _seed_task(ORG_A, "Acme secret task", username="alice")
    async with await _client() as c:
        r = await c.delete(
            "/api/v1/internal/tasks/by-title/Acme secret task",
            params={"org_id": ORG_B, "username": "alice"},
            headers={"X-Internal-Token": TEST_INTERNAL_TOKEN},
        )
        assert r.status_code == 200, r.text
        assert r.json()["deleted_tasks"] == 0
    assert await _task_exists(task_id) is True


async def test_wrong_internal_token_is_rejected(db_app):
    async with await _client() as c:
        r = await c.delete(
            "/api/v1/internal/tasks/by-title/anything",
            params={"org_id": ORG_A},
            headers={"X-Internal-Token": "not-the-real-token"},
        )
        assert r.status_code == 403
