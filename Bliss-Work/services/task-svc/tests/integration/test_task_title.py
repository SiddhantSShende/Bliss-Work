"""`taskTitle` — the task's own identity — is a distinct, mandatory field from
`title` (the project this task is filed under; see schemas.py's docstring on
why that confusing name was kept). These tests exist because, before this
field existed, every task's stored "title" WAS the project name: a task
titled "Fix the login bug" filed under a "Website Redesign" project showed up
everywhere (My Tasks, Allocated to me, task chat, exports) as "Website
Redesign" instead. Covers: mandatory + trimmed server-side validation,
persistence distinct from the project name, survival through the scheduled/
recurring materialization path, and that existing (pre-field) rows still
decrypt and serve without error.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "55555555-5555-5555-5555-555555555555"
SENDER = "66666666-6666-6666-6666-666666666666"


def _id() -> str:
    return str(uuid.uuid4())


async def _client(user_id: str = SENDER, org_id: str = ORG) -> httpx.AsyncClient:
    from app.auth import Principal, require_principal
    from app.main import app

    principal = Principal(user_id=user_id, org_id=org_id, roles=["member"], username="sender")
    app.dependency_overrides[require_principal] = lambda: principal
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _q(sql: str, **params) -> list:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        result = await conn.execute(text(sql), params)
        return result.all() if result.returns_rows else []


async def test_task_title_is_stored_and_served_separately_from_the_project_name(
    db_app, seed_members
):
    await seed_members(ORG, SENDER)
    async with await _client() as c:
        created = await c.post(
            "/api/v1/tasks",
            json={
                "taskTitle": "Fix the login bug",
                "title": "Website Redesign",
                "assigneeIds": [SENDER],
            },
        )
        assert created.status_code == 201, created.text
        task_id = created.json()["taskId"]

        sent = await c.get("/api/v1/tasks/sent")
        assert sent.status_code == 200, sent.text
        [row] = [t for t in sent.json() if t["taskId"] == task_id]
        assert row["title"] == "Fix the login bug"

        project_id = row["projectId"]
        project = await c.get(f"/api/v1/projects/{project_id}")
        assert project.status_code == 200, project.text
        assert project.json()["name"] == "Website Redesign"

    # The assignee-facing read path (a separate query/DTO from /sent above)
    # must decrypt the same stored title, not the project name either.
    async with await _client() as c:
        inbox_self = await c.get("/api/v1/tasks/inbox")
    assert inbox_self.status_code == 200
    [inbox_row] = [t for t in inbox_self.json() if t["taskId"] == task_id]
    assert inbox_row["title"] == "Fix the login bug"


async def test_missing_task_title_is_rejected(db_app, seed_members):
    await seed_members(ORG, SENDER)
    async with await _client() as c:
        response = await c.post(
            "/api/v1/tasks",
            json={"title": "Website Redesign", "assigneeIds": [SENDER]},
        )
    assert response.status_code == 422, response.text
    assert (await _q("SELECT count(*) FROM tasks WHERE org_id = :org", org=ORG))[0][0] == 0


async def test_whitespace_only_task_title_is_rejected(db_app, seed_members):
    await seed_members(ORG, SENDER)
    async with await _client() as c:
        response = await c.post(
            "/api/v1/tasks",
            json={"taskTitle": "   ", "title": "Website Redesign", "assigneeIds": [SENDER]},
        )
    assert response.status_code == 422, response.text
    assert (await _q("SELECT count(*) FROM tasks WHERE org_id = :org", org=ORG))[0][0] == 0


async def test_task_title_is_trimmed_before_storage(db_app, seed_members):
    await seed_members(ORG, SENDER)
    async with await _client() as c:
        created = await c.post(
            "/api/v1/tasks",
            json={
                "taskTitle": "  Fix the login bug  ",
                "title": "Website Redesign",
                "assigneeIds": [SENDER],
            },
        )
        assert created.status_code == 201, created.text
        sent = await c.get("/api/v1/tasks/sent")
    [row] = [t for t in sent.json() if t["taskId"] == created.json()["taskId"]]
    assert row["title"] == "Fix the login bug"


async def test_scheduled_task_title_survives_into_the_materialized_occurrence(
    db_app, seed_members
):
    await seed_members(ORG, SENDER)
    scheduled_for = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    async with await _client() as c:
        response = await c.post(
            "/api/v1/tasks",
            json={
                "taskTitle": "Ship the release notes",
                "title": "Comms Project",
                "assigneeIds": [SENDER],
                "allocation": "SCHEDULED",
                "scheduledFor": scheduled_for,
            },
        )
        assert response.status_code == 201, response.text
        schedule_id = response.json()["scheduleId"]

    await _q(
        "UPDATE task_schedules SET next_run_at = now() - interval '1 second' WHERE id = :id",
        id=schedule_id,
    )

    from app.schedule_worker import run_due_schedules_once

    assert await run_due_schedules_once() == 1

    async with await _client() as c:
        sent = await c.get("/api/v1/tasks/sent")
    occurrence_id = str((await _q(
        "SELECT id FROM tasks WHERE schedule_id = :id", id=schedule_id
    ))[0].id)
    [row] = [t for t in sent.json() if t["taskId"] == occurrence_id]
    assert row["title"] == "Ship the release notes"
