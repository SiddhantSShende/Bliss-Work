from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
OTHER_ORG = "22222222-2222-2222-2222-222222222222"
SENDER = "33333333-3333-3333-3333-333333333333"


def _id() -> str:
    return str(uuid.uuid4())


def _principal(user_id: str = SENDER, org_id: str = ORG):
    from app.auth import Principal

    return Principal(user_id=user_id, org_id=org_id, roles=["member"], username="member")


async def _client(user_id: str = SENDER, org_id: str = ORG) -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: _principal(user_id, org_id)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _q(sql: str, **params) -> list:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        result = await conn.execute(text(sql), params)
        return result.all() if result.returns_rows else []


async def _create(title: str, assignee_id: str, *, org_id: str = ORG) -> httpx.Response:
    async with await _client(org_id=org_id) as client:
        return await client.post(
            "/api/v1/tasks",
            json={"taskTitle": title, "title": title, "assigneeIds": [assignee_id]},
        )


@pytest.fixture
def project_calls(monkeypatch):
    from app import projects
    from app import schedule_worker
    from app.routes import participants, reassign, tasks_write

    created: list[tuple[str, str, str]] = []
    synced: list[tuple[str, str, list[str]]] = []

    async def create_channel(org_id: str, creator_id: str, name: str) -> str:
        created.append((org_id, creator_id, name))
        await asyncio.sleep(0.02)
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"project-channel:{org_id}:{name.casefold()}"))

    async def sync_members(
        org_id: str, channel_id: str, actor_id: str, assignee_ids: list[str]
    ) -> None:
        synced.append((org_id, channel_id, list(assignee_ids)))

    monkeypatch.setattr(projects, "_create_project_channel", create_channel)
    monkeypatch.setattr(tasks_write, "sync_assignees_to_project_channel", sync_members)
    monkeypatch.setattr(participants, "sync_assignees_to_project_channel", sync_members)
    monkeypatch.setattr(reassign, "sync_assignees_to_project_channel", sync_members)
    monkeypatch.setattr(schedule_worker, "sync_assignees_to_project_channel", sync_members)
    return {"created": created, "synced": synced, "sync": sync_members}


async def test_create_and_reuse_project_channel_without_assigning_its_existing_members(
    db_app, seed_members, project_calls
):
    first, second = _id(), _id()
    await seed_members(ORG, first, second)

    created = await _create("  Quarterly   Planning  ", first)
    assert created.status_code == 201, created.text
    first_task_id = created.json()["taskId"]

    reused = await _create("quarterly\tplanning", second)
    assert reused.status_code == 201, reused.text
    second_task_id = reused.json()["taskId"]

    projects = await _q("SELECT id, channel_id FROM projects WHERE org_id = :org", org=ORG)
    assert len(projects) == 1
    project_id, channel_id = str(projects[0].id), str(projects[0].channel_id)
    task_projects = await _q(
        "SELECT project_id FROM tasks WHERE id = ANY(:ids)",
        ids=[first_task_id, second_task_id],
    )
    assert {str(row.project_id) for row in task_projects} == {project_id}
    assert project_calls["created"] == [(ORG, SENDER, "Quarterly Planning")]
    assert [call[2] for call in project_calls["synced"]] == [[first], [second]]

    # Project-channel membership is not a task assignment target. In particular,
    # a member added for the first task must not leak into the second task.
    assert (await _q("SELECT count(*) FROM task_assignees WHERE task_id = :id", id=second_task_id))[0][0] == 1
    assert (await _q("SELECT count(*) FROM task_channels WHERE task_id = ANY(:ids)", ids=[first_task_id, second_task_id]))[0][0] == 0
    lookup = await _client()
    async with lookup as client:
        response = await client.get("/api/v1/projects/by-name", params={"name": " QUARTERLY planning "})
    assert response.status_code == 200, response.text
    assert response.json() == {
        "id": project_id,
        "name": "Quarterly Planning",
        "channelId": channel_id,
        "status": "ACTIVE",
        "canComplete": True,
    }


async def test_concurrent_same_name_creation_claims_one_project_and_channel(
    db_app, seed_members, project_calls
):
    assignee = _id()
    await seed_members(ORG, assignee)

    results = await asyncio.gather(
        _create("Concurrent Project", assignee),
        _create(" concurrent   project ", assignee),
    )
    assert all(response.status_code == 201 for response in results), [r.text for r in results]
    assert len(project_calls["created"]) == 1
    assert (await _q("SELECT count(*) FROM projects WHERE org_id = :org", org=ORG))[0][0] == 1
    assert (await _q("SELECT count(*) FROM tasks WHERE org_id = :org", org=ORG))[0][0] == 2


async def test_projects_are_isolated_by_organization(db_app, seed_members, project_calls):
    assignee_a, assignee_b = _id(), _id()
    await seed_members(ORG, assignee_a)
    await seed_members(OTHER_ORG, assignee_b)

    a = await _create("Same name", assignee_a)
    b = await _create("Same name", assignee_b, org_id=OTHER_ORG)
    assert a.status_code == b.status_code == 201
    rows = await _q(
        "SELECT org_id, id, channel_id FROM projects ORDER BY org_id"
    )
    assert len(rows) == 2
    assert rows[0].org_id != rows[1].org_id
    assert rows[0].id != rows[1].id
    assert rows[0].channel_id != rows[1].channel_id

    async with await _client(org_id=ORG) as client:
        visible = await client.get("/api/v1/projects")
        other_name = await client.get("/api/v1/projects/by-name", params={"name": "Same name"})
    assert visible.status_code == 200 and len(visible.json()) == 1
    assert other_name.status_code == 200
    assert other_name.json()["id"] == str(rows[0].id)


async def test_project_reads_hide_projects_without_a_sender_or_assignee_task(
    db_app, seed_members, project_calls
):
    assignee, outsider = _id(), _id()
    await seed_members(ORG, assignee, outsider)
    created = await _create("Private project", assignee)
    assert created.status_code == 201, created.text
    project_id = str((await _q("SELECT id FROM projects WHERE org_id = :org", org=ORG))[0].id)

    async with await _client(outsider) as client:
        detail = await client.get(f"/api/v1/projects/{project_id}")
        by_name = await client.get("/api/v1/projects/by-name", params={"name": "Private project"})
    assert detail.status_code == by_name.status_code == 404

    async with await _client(assignee) as client:
        visible = await client.get("/api/v1/projects")
    assert visible.status_code == 200
    assert [item["id"] for item in visible.json()] == [project_id]


async def test_channel_creation_failure_rolls_back_project_and_task(
    db_app, seed_members, monkeypatch
):
    from app import projects

    assignee = _id()
    await seed_members(ORG, assignee)

    async def fail_create(*_args, **_kwargs):
        raise HTTPException(status_code=503, detail="messaging service unavailable")

    monkeypatch.setattr(projects, "_create_project_channel", fail_create)
    response = await _create("Uncreated project", assignee)
    assert response.status_code == 503
    assert (await _q("SELECT count(*) FROM projects WHERE org_id = :org", org=ORG))[0][0] == 0
    assert (await _q("SELECT count(*) FROM tasks WHERE org_id = :org", org=ORG))[0][0] == 0


async def test_create_membership_sync_failure_does_not_persist_task(
    db_app, seed_members, project_calls, monkeypatch
):
    from app.routes import tasks_write

    assignee = _id()
    await seed_members(ORG, assignee)

    async def fail_sync(*_args, **_kwargs):
        raise HTTPException(status_code=502, detail="membership sync failed")

    monkeypatch.setattr(tasks_write, "sync_assignees_to_project_channel", fail_sync)
    response = await _create("Sync must succeed", assignee)
    assert response.status_code == 502
    assert (await _q("SELECT count(*) FROM projects WHERE org_id = :org", org=ORG))[0][0] == 1
    assert (await _q("SELECT count(*) FROM tasks WHERE org_id = :org", org=ORG))[0][0] == 0


async def test_add_member_and_reassign_report_post_commit_sync_failures(
    db_app, seed_members, project_calls, monkeypatch
):
    from app.routes import participants, reassign

    assignee, added = _id(), _id()
    await seed_members(ORG, assignee, added)
    created = await _create("Membership hooks", assignee)
    assert created.status_code == 201, created.text
    task_id = created.json()["taskId"]

    async def fail_sync(*_args, **_kwargs):
        raise HTTPException(status_code=502, detail="membership sync failed")

    monkeypatch.setattr(participants, "sync_assignees_to_project_channel", fail_sync)
    async with await _client() as client:
        added_response = await client.post(
            f"/api/v1/tasks/{task_id}/assignees", json={"userIds": [added]}
        )
    assert added_response.status_code == 200, added_response.text
    assert added_response.json()["projectChannelSyncFailed"] is True
    assert (await _q(
        "SELECT count(*) FROM task_assignees WHERE task_id = :id AND assignee_id = :uid",
        id=task_id,
        uid=added,
    ))[0][0] == 1

    await _q(
        "UPDATE task_assignees SET status = 'COMPLETED' WHERE task_id = :id",
        id=task_id,
    )
    monkeypatch.setattr(reassign, "sync_assignees_to_project_channel", fail_sync)
    async with await _client() as client:
        reassigned = await client.post(f"/api/v1/tasks/{task_id}/reassign")
    assert reassigned.status_code == 200, reassigned.text
    assert reassigned.json()["projectChannelSyncFailed"] is True


async def test_scheduled_occurrence_inherits_project_without_channel_assignment_fanout(
    db_app, seed_members, project_calls
):
    assignee = _id()
    await seed_members(ORG, assignee)
    scheduled_for = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    async with await _client() as client:
        scheduled = await client.post(
            "/api/v1/tasks",
            json={
                "taskTitle": "Recurring project",
                "title": "Recurring project",
                "assigneeIds": [assignee],
                "allocation": "SCHEDULED",
                "scheduledFor": scheduled_for,
            },
        )
    assert scheduled.status_code == 201, scheduled.text
    schedule_id = scheduled.json()["scheduleId"]
    schedule_project = (await _q(
        "SELECT project_id FROM task_schedules WHERE id = :id", id=schedule_id
    ))[0].project_id
    async with await _client() as client:
        schedules = await client.get("/api/v1/tasks/schedules")
        sender_projects = await client.get(f"/api/v1/projects/{schedule_project}")
    async with await _client(assignee) as client:
        assignee_projects = await client.get("/api/v1/projects")
    async with await _client(_id()) as client:
        outsider_project = await client.get(f"/api/v1/projects/{schedule_project}")
    assert schedules.status_code == sender_projects.status_code == assignee_projects.status_code == 200
    assert schedules.json()[0]["projectId"] == str(schedule_project)
    assert sender_projects.json()["id"] == str(schedule_project)
    assert [project["id"] for project in assignee_projects.json()] == [str(schedule_project)]
    assert outsider_project.status_code == 404
    await _q(
        "UPDATE task_schedules SET next_run_at = now() - interval '1 second' WHERE id = :id",
        id=schedule_id,
    )

    from app.schedule_worker import run_due_schedules_once

    assert await run_due_schedules_once() == 1
    occurrence = (await _q(
        "SELECT id, project_id, channel_id FROM tasks WHERE schedule_id = :id",
        id=schedule_id,
    ))[0]
    assert str(occurrence.project_id) == str(schedule_project)
    assert occurrence.channel_id is None
    assert (await _q(
        "SELECT count(*) FROM task_channels WHERE task_id = :id", id=occurrence.id
    ))[0][0] == 0
    assert project_calls["synced"][-1][2] == [assignee]


async def test_scheduled_project_sync_failure_rolls_back_and_retries(
    db_app, seed_members, project_calls, monkeypatch
):
    from app import schedule_worker

    assignee = _id()
    await seed_members(ORG, assignee)
    scheduled_for = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    async with await _client() as client:
        response = await client.post(
            "/api/v1/tasks",
            json={
                "taskTitle": "Retry project membership",
                "title": "Retry project membership",
                "assigneeIds": [assignee],
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

    async def fail_sync(*_args, **_kwargs):
        raise HTTPException(status_code=502, detail="membership sync failed")

    monkeypatch.setattr(schedule_worker, "sync_assignees_to_project_channel", fail_sync)
    assert await schedule_worker.run_due_schedules_once() == 0
    assert (await _q("SELECT count(*) FROM tasks WHERE schedule_id = :id", id=schedule_id))[0][0] == 0
    status = (await _q("SELECT status FROM task_schedules WHERE id = :id", id=schedule_id))[0].status
    assert status == "ACTIVE"

    schedule_worker._parked_until.pop(schedule_id, None)
    monkeypatch.setattr(
        schedule_worker, "sync_assignees_to_project_channel", project_calls["sync"]
    )
    assert await schedule_worker.run_due_schedules_once() == 1
    assert (await _q("SELECT count(*) FROM tasks WHERE schedule_id = :id", id=schedule_id))[0][0] == 1
    assert project_calls["synced"][-1][2] == [assignee]
