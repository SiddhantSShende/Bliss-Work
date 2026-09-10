"""Regression test for SEC-finding G: the internal by-title delete endpoint's
org-scoping (services/task-svc/app/routes/tasks_write.py, `DELETE
/internal/tasks/by-title/{title}`).

History (see the endpoint's own docstring and docs/AUTH_AUTHZ_REMEDIATION_PLAN.md
Phase 1): the original version of this endpoint took no `org_id` at all and
issued `DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM tasks WHERE
title = :title)` — a genuinely cross-org, unscoped delete driven entirely by an
attacker/caller-controlled title. That was fixed by adding a required `org_id`
parameter and calling `set_org_context(db, org_id)` before any query.

This complements tests/integration/test_by_title_internal_org_scoping.py (the
recovered, historical test for the same fix, which drives the real HTTP
endpoint) by calling the route function directly — the two exercise slightly
different call layers of the same code path. Both use the shared `db_app`
fixture from this directory's conftest.py (a genuinely non-superuser Postgres
role, so RLS is actually enforced rather than bypassed) — an earlier version
of this file rolled its own separate testcontainers bootstrap under tests/
directly, which ran a second Postgres container and clobbered task-svc's
module-level engine/cryptor singletons whenever both files ran in the same
pytest session. Consolidating onto the one established fixture fixes that.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG_A = "77777777-7777-7777-7777-777777777771"
ORG_B = "88888888-8888-8888-8888-888888888882"
TEST_INTERNAL_TOKEN = "test-internal-token-for-delete-by-title-direct-call-suite"


@pytest.fixture(autouse=True)
def _internal_token(db_app):
    from app.config import settings

    settings.internal_token = TEST_INTERNAL_TOKEN
    yield


async def _seed_org_with_task(org_id: str, title: str) -> tuple[str, str]:
    """Create one org's worth of state: an admin user_projection row and one
    real task (genuine title_enc via the real Cryptor) with the given title,
    assigned to that same admin. Returns (admin_id, task_id)."""
    from crypto import cryptor
    from app.db import get_engine

    admin_id = str(uuid.uuid4())
    task_id = str(uuid.uuid4())
    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text(
                "INSERT INTO user_projection (user_id, org_id, username, display_name) "
                "VALUES (:u, :o, 'admin', 'Admin')"
            ),
            {"u": admin_id, "o": org_id},
        )
        title_enc = await cryptor().encrypt(conn, org_id, title)
        desc_enc = await cryptor().encrypt(conn, org_id, "seed")
        await conn.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, title_enc, description_enc) "
                "VALUES (:id, :o, :s, :t, :d)"
            ),
            {"id": task_id, "o": org_id, "s": admin_id, "t": title_enc, "d": desc_enc},
        )
        await conn.execute(
            text(
                "INSERT INTO task_assignees (task_id, org_id, assignee_id, status) "
                "VALUES (:tid, :o, :a, 'SENT')"
            ),
            {"tid": task_id, "o": org_id, "a": admin_id},
        )
    return admin_id, task_id


async def _task_exists(task_id: str) -> bool:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        row = (
            await conn.execute(text("SELECT 1 FROM tasks WHERE id = :id"), {"id": task_id})
        ).first()
        return row is not None


async def test_delete_by_title_only_touches_the_caller_named_org(db_app):
    """The core regression: two different orgs each have a task with the
    IDENTICAL title. Deleting by that title scoped to org A must remove ONLY
    org A's task — org B's same-titled task must survive untouched."""
    from app.routes.tasks_write import delete_task_by_title_internal

    shared_title = f"Quarterly report {uuid.uuid4()}"
    _admin_a, task_a = await _seed_org_with_task(ORG_A, shared_title)
    _admin_b, task_b = await _seed_org_with_task(ORG_B, shared_title)

    result = await delete_task_by_title_internal(
        title=shared_title,
        org_id=ORG_A,
        username=None,
        internal_token=TEST_INTERNAL_TOKEN,
    )
    assert result["deleted_tasks"] == 1
    assert result["deleted_assignees"] == 1

    assert await _task_exists(task_a) is False, "org A's task should have been deleted"
    assert await _task_exists(task_b) is True, (
        "org B's identically-titled task must survive — a cross-org delete here "
        "is exactly the vulnerability this endpoint was fixed for"
    )


async def test_wrong_internal_token_is_rejected_before_touching_any_org(db_app):
    from fastapi import HTTPException

    from app.routes.tasks_write import delete_task_by_title_internal

    title = f"Should never be reached {uuid.uuid4()}"
    _admin_a, task_a = await _seed_org_with_task(ORG_A, title)

    with pytest.raises(HTTPException) as exc_info:
        await delete_task_by_title_internal(
            title=title,
            org_id=ORG_A,
            username=None,
            internal_token="not-the-real-token",
        )
    assert exc_info.value.status_code == 403
    assert await _task_exists(task_a) is True, "a rejected call must not have touched the row at all"


async def test_username_filter_stays_within_the_named_org(db_app):
    """The `username` branch takes the same org_id-bound RLS path as the
    unscoped branch — prove it doesn't reach into a same-named user's tasks
    in a DIFFERENT org."""
    from app.routes.tasks_write import delete_task_by_title_internal

    title = f"Shared username collision {uuid.uuid4()}"
    _admin_a, task_a = await _seed_org_with_task(ORG_A, title)
    _admin_b, task_b = await _seed_org_with_task(ORG_B, title)
    # Both seeded admins are named "admin" (see _seed_org_with_task) — the
    # exact same-username-different-org collision this test targets.

    await delete_task_by_title_internal(
        title=title,
        org_id=ORG_A,
        username="admin",
        internal_token=TEST_INTERNAL_TOKEN,
    )

    assert await _task_exists(task_a) is False
    assert await _task_exists(task_b) is True, (
        "org B's task from a same-named user in a DIFFERENT org must survive"
    )
