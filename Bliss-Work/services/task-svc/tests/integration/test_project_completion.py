"""`POST /projects/{id}/complete` — mark a project COMPLETED once every task
filed under it is COMPLETED.

The real app, RLS, and a real Postgres; nothing is stubbed except the
messaging-svc channel call (see the autouse `project_messaging` fixture in
conftest.py), the same boundary every other project-flow suite replaces.
"""

from __future__ import annotations

import uuid
from datetime import datetime

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG_A = "11111111-1111-1111-1111-111111111111"
ORG_B = "22222222-2222-2222-2222-222222222222"
OWNER = "33333333-3333-3333-3333-333333333333"


def _id() -> str:
    return str(uuid.uuid4())


def _principal(user_id: str, org_id: str = ORG_A, roles: list[str] | None = None):
    from app.auth import Principal

    return Principal(user_id=user_id, org_id=org_id, roles=roles or ["member"], username="u")


async def _client(user_id: str, org_id: str = ORG_A, roles: list[str] | None = None) -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: _principal(user_id, org_id, roles)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _project(org: str, creator: str, name: str = "Project") -> str:
    """Resolve (or create) a project exactly the way task creation does — the
    autouse `project_messaging` fixture stubs the messaging-svc channel call."""
    from app.projects import resolve_or_create_project

    resolution = await resolve_or_create_project(org, creator, name)
    return resolution.project_id


async def _task(org: str, sender: str, project_id: str, *, title: str = "Task") -> str:
    from app.db import session, set_org_context
    from crypto import cryptor

    task_id = _id()
    async with session() as db:
        await set_org_context(db, org)
        enc = await cryptor().encrypt(db, org, title)
        await db.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, title_enc, project_id, created_at) "
                "VALUES (:t, :o, :s, :e, :p, now())"
            ),
            {"t": task_id, "o": org, "s": sender, "e": enc, "p": project_id},
        )
        await db.commit()
    return task_id


async def _assignee_row(org: str, task_id: str, assignee_id: str, status: str) -> None:
    from app.db import session, set_org_context

    assert status in ("SENT", "IGNORED", "ACKNOWLEDGED", "COMPLETED", "LEFT", "MISSED")
    async with session() as db:
        await set_org_context(db, org)
        await db.execute(
            text(
                "INSERT INTO task_assignees (task_id, org_id, assignee_id, status, assigned_at) "
                f"VALUES (:t, :o, :a, '{status}', now())"
            ),
            {"t": task_id, "o": org, "a": assignee_id},
        )
        await db.commit()


async def _complete(project_id: str, as_user: str, org: str = ORG_A, roles: list[str] | None = None) -> httpx.Response:
    async with await _client(as_user, org, roles) as c:
        return await c.post(f"/api/v1/projects/{project_id}/complete")


async def _row(project_id: str) -> dict[str, object]:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        result = await conn.execute(
            text("SELECT status, completed_at, completed_by FROM projects WHERE id = :id"),
            {"id": project_id},
        )
        row = result.first()
        return {"status": row.status, "completed_at": row.completed_at, "completed_by": row.completed_by}


async def test_owner_completes_a_project_whose_every_task_is_completed(db_app):
    project_id = await _project(ORG_A, OWNER)
    task_id = await _task(ORG_A, OWNER, project_id)
    await _assignee_row(ORG_A, task_id, _id(), "COMPLETED")

    r = await _complete(project_id, OWNER)

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "COMPLETED"
    assert body["id"] == project_id
    row = await _row(project_id)
    assert row["status"] == "COMPLETED"
    assert isinstance(row["completed_at"], datetime)
    assert str(row["completed_by"]) == OWNER


async def test_org_admin_who_is_not_the_owner_can_also_complete_it(db_app):
    project_id = await _project(ORG_A, OWNER)
    task_id = await _task(ORG_A, OWNER, project_id)
    await _assignee_row(ORG_A, task_id, _id(), "COMPLETED")
    admin = _id()

    r = await _complete(project_id, admin, roles=["org_admin"])

    assert r.status_code == 200, r.text
    assert (await _row(project_id))["status"] == "COMPLETED"


async def test_a_bystander_who_is_neither_owner_nor_admin_is_refused(db_app):
    project_id = await _project(ORG_A, OWNER)
    task_id = await _task(ORG_A, OWNER, project_id)
    await _assignee_row(ORG_A, task_id, _id(), "COMPLETED")
    bystander = _id()

    r = await _complete(project_id, bystander)

    assert r.status_code == 403, r.text
    assert (await _row(project_id))["status"] == "ACTIVE"


async def test_an_assignee_is_not_the_owner_and_cannot_complete_it(db_app):
    project_id = await _project(ORG_A, OWNER)
    assignee = _id()
    task_id = await _task(ORG_A, OWNER, project_id)
    await _assignee_row(ORG_A, task_id, assignee, "COMPLETED")

    r = await _complete(project_id, assignee)

    assert r.status_code == 403, r.text


async def test_a_project_with_no_tasks_cannot_be_completed(db_app):
    project_id = await _project(ORG_A, OWNER, "Empty Project")

    r = await _complete(project_id, OWNER)

    assert r.status_code == 409, r.text


async def test_a_project_with_an_incomplete_task_cannot_be_completed(db_app):
    project_id = await _project(ORG_A, OWNER)
    done_task = await _task(ORG_A, OWNER, project_id)
    await _assignee_row(ORG_A, done_task, _id(), "COMPLETED")
    pending_task = await _task(ORG_A, OWNER, project_id)
    await _assignee_row(ORG_A, pending_task, _id(), "SENT")

    r = await _complete(project_id, OWNER)

    assert r.status_code == 409, r.text
    assert (await _row(project_id))["status"] == "ACTIVE"


async def test_a_wholly_abandoned_task_is_not_completed_either(db_app):
    """An ABANDONED task (every assignee left/ignored) is not "done" — it's
    unresolved work nobody is doing, not a reason to let the project close."""
    project_id = await _project(ORG_A, OWNER)
    task_id = await _task(ORG_A, OWNER, project_id)
    await _assignee_row(ORG_A, task_id, _id(), "LEFT")
    await _assignee_row(ORG_A, task_id, _id(), "IGNORED")

    r = await _complete(project_id, OWNER)

    assert r.status_code == 409, r.text


async def test_an_already_completed_project_cannot_be_completed_again(db_app):
    project_id = await _project(ORG_A, OWNER)
    task_id = await _task(ORG_A, OWNER, project_id)
    await _assignee_row(ORG_A, task_id, _id(), "COMPLETED")
    first = await _complete(project_id, OWNER)
    assert first.status_code == 200, first.text

    second = await _complete(project_id, OWNER)

    assert second.status_code == 409, second.text


async def test_a_second_concurrent_request_after_the_first_succeeds_is_refused(db_app):
    project_id = await _project(ORG_A, OWNER)
    task_id = await _task(ORG_A, OWNER, project_id)
    await _assignee_row(ORG_A, task_id, _id(), "COMPLETED")

    first = await _complete(project_id, OWNER)
    second = await _complete(project_id, OWNER)

    assert first.status_code == 200, first.text
    assert second.status_code == 409, second.text


async def test_another_org_cannot_see_or_complete_it(db_app):
    project_id = await _project(ORG_A, OWNER)
    task_id = await _task(ORG_A, OWNER, project_id)
    await _assignee_row(ORG_A, task_id, _id(), "COMPLETED")

    r = await _complete(project_id, OWNER, org=ORG_B)

    assert r.status_code == 404, r.text
    assert (await _row(project_id))["status"] == "ACTIVE"


async def test_unknown_and_malformed_ids_are_404(db_app):
    assert (await _complete(_id(), OWNER)).status_code == 404
    assert (await _complete("not-a-uuid", OWNER)).status_code == 404


async def test_project_reads_expose_status_and_can_complete(db_app):
    project_id = await _project(ORG_A, OWNER)
    task_id = await _task(ORG_A, OWNER, project_id)
    await _assignee_row(ORG_A, task_id, _id(), "COMPLETED")
    assignee = _id()
    await _assignee_row(ORG_A, await _task(ORG_A, OWNER, project_id), assignee, "COMPLETED")

    async with await _client(OWNER) as c:
        owner_view = await c.get(f"/api/v1/projects/{project_id}")
    async with await _client(assignee) as c:
        # Sees the project (it's a party to a task in it) but did not create
        # it and holds no org_admin role.
        assignee_view = await c.get(f"/api/v1/projects/{project_id}")

    assert owner_view.status_code == 200, owner_view.text
    assert owner_view.json()["status"] == "ACTIVE"
    assert owner_view.json()["canComplete"] is True
    assert assignee_view.status_code == 200, assignee_view.text
    assert assignee_view.json()["canComplete"] is False

    await _complete(project_id, OWNER)

    async with await _client(OWNER) as c:
        after = await c.get(f"/api/v1/projects/{project_id}")
    assert after.json()["status"] == "COMPLETED"
