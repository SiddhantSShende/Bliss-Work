"""GET /tasks/projects/{projectId}/analytics — snapshot analytics across every
task in a project (tasks.project_id), joined to task_assignees.

The project-scoped sibling of test_channel_analytics.py: the same completion
metric rules and the same GROUP BY task_id double-counting guard, scoped by
tasks.project_id (a plain FK — a task belongs to at most one project, so there
is no join-table fan-out on that side at all) instead of task_channels.

Unlike a channel, a project's visibility (_AUTHORIZED_PROJECT, see
projects_read.py and test_projects.py) requires the caller to be the sender or
an assignee of at least one task (or schedule) in it — so, unlike
channel_analytics, there is no reachable "authorized but zero tasks" state:
a project only exists because some task created it, and nobody can see a
project without being a party to one of its tasks. The "no data" cases tested
here are therefore the ones that line up with that rule: a project nobody
has sent/been assigned a task on (404, same as non-membership), a project
that doesn't exist (404), and a real project's task list once its single
page of tasks runs out (pagination, not a 0/0 metrics body).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG_A = "11111111-1111-1111-1111-111111111111"
ORG_B = "22222222-2222-2222-2222-222222222222"
SENDER = "33333333-3333-3333-3333-333333333333"


def _id() -> str:
    return str(uuid.uuid4())


def _principal(user_id: str, org_id: str = ORG_A):
    from app.auth import Principal

    return Principal(user_id=user_id, org_id=org_id, roles=["member"], username="u")


async def _client(user_id: str, org_id: str = ORG_A) -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: _principal(user_id, org_id)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _project(org: str, sender: str, name: str = "Project") -> str:
    """Resolve (or create) a project exactly the way task creation does — the
    autouse `project_messaging` fixture (conftest.py) stubs the messaging-svc
    channel call, so this exercises the real resolve_or_create_project path."""
    from app.projects import resolve_or_create_project

    resolution = await resolve_or_create_project(org, sender, name)
    return resolution.project_id


async def _task(
    org: str,
    sender: str,
    project_id: str,
    *,
    title: str = "Task",
    created_at: datetime | None = None,
    deadline_at: datetime | None = None,
) -> str:
    from app.db import session, set_org_context
    from crypto import cryptor

    task_id = _id()
    async with session() as db:
        await set_org_context(db, org)
        enc = await cryptor().encrypt(db, org, title)
        await db.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, title_enc, project_id, created_at, deadline_at) "
                "VALUES (:t, :o, :s, :e, :p, COALESCE(:created, now()), :deadline)"
            ),
            {"t": task_id, "o": org, "s": sender, "e": enc, "p": project_id, "created": created_at, "deadline": deadline_at},
        )
        await db.commit()
    return task_id


async def _assignee_row(
    org: str,
    task_id: str,
    assignee_id: str,
    status: str,
    *,
    assigned_at: datetime | None = None,
) -> None:
    from app.db import session, set_org_context

    assert status in ("SENT", "IGNORED", "ACKNOWLEDGED", "COMPLETED", "LEFT", "MISSED")
    async with session() as db:
        await set_org_context(db, org)
        await db.execute(
            text(
                "INSERT INTO task_assignees (task_id, org_id, assignee_id, status, assigned_at) "
                f"VALUES (:t, :o, :a, '{status}', COALESCE(:assigned, now()))"
            ),
            {"t": task_id, "o": org, "a": assignee_id, "assigned": assigned_at},
        )
        await db.commit()


async def _get(project_id: str, as_user: str, org: str = ORG_A, **params) -> httpx.Response:
    async with await _client(as_user, org) as c:
        return await c.get(f"/api/v1/tasks/projects/{project_id}/analytics", params=params)


async def test_ten_tasks_three_completed_is_thirty_percent(db_app):
    project_id = await _project(ORG_A, SENDER, "Ten Tasks")
    assignee = _id()
    for i in range(10):
        task_id = await _task(ORG_A, SENDER, project_id)
        await _assignee_row(ORG_A, task_id, assignee, "COMPLETED" if i < 3 else "SENT")

    r = await _get(project_id, SENDER)
    assert r.status_code == 200, r.text
    completion = r.json()["completion"]
    assert completion["totalUniqueTasks"] == 10
    assert completion["completedUniqueTasks"] == 3
    assert completion["uniqueTaskCompletionRate"] == 30.0
    assert completion["totalAssignments"] == 10
    assert completion["completedAssignments"] == 3
    assert completion["assignmentCompletionRate"] == 30.0


async def test_multi_assignee_task_diverges_assignment_from_unique_rate(db_app):
    """One task, 4 assignees, 1 completed: assignment rate 25%, but the task
    is not unique-task-complete (3 remaining rows are incomplete)."""
    project_id = await _project(ORG_A, SENDER, "Multi Assignee")
    task_id = await _task(ORG_A, SENDER, project_id)
    a, b, c, d = _id(), _id(), _id(), _id()
    await _assignee_row(ORG_A, task_id, a, "COMPLETED")
    await _assignee_row(ORG_A, task_id, b, "SENT")
    await _assignee_row(ORG_A, task_id, c, "ACKNOWLEDGED")
    await _assignee_row(ORG_A, task_id, d, "SENT")

    r = await _get(project_id, SENDER)
    completion = r.json()["completion"]
    assert completion["totalUniqueTasks"] == 1
    assert completion["completedUniqueTasks"] == 0
    assert completion["remainingUniqueTasks"] == 1
    assert completion["totalAssignments"] == 4
    assert completion["completedAssignments"] == 1
    assert completion["assignmentCompletionRate"] == 25.0
    assert completion["uniqueTaskCompletionRate"] == 0.0


async def test_abandoned_task_is_excluded_from_completed_and_remaining(db_app):
    project_id = await _project(ORG_A, SENDER, "Abandoned")
    task_id = await _task(ORG_A, SENDER, project_id)
    a, b = _id(), _id()
    await _assignee_row(ORG_A, task_id, a, "LEFT")
    await _assignee_row(ORG_A, task_id, b, "IGNORED")

    r = await _get(project_id, SENDER)
    completion = r.json()["completion"]
    assert completion["totalUniqueTasks"] == 1
    assert completion["completedUniqueTasks"] == 0
    assert completion["abandonedUniqueTasks"] == 1
    assert completion["remainingUniqueTasks"] == 0

    [task] = r.json()["tasks"]
    assert task["taskStatus"] == "ABANDONED"
    assert task["overdue"] is False


async def test_missed_deadline_marks_task_overdue_but_not_completed(db_app):
    project_id = await _project(ORG_A, SENDER, "Overdue")
    past = datetime.now(timezone.utc) - timedelta(days=1)
    missed_task = await _task(ORG_A, SENDER, project_id, title="Missed it", deadline_at=past)
    await _assignee_row(ORG_A, missed_task, _id(), "MISSED")
    ontime_task = await _task(ORG_A, SENDER, project_id, title="On time")
    await _assignee_row(ORG_A, ontime_task, _id(), "COMPLETED")

    r = await _get(project_id, SENDER)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["overdueUniqueTasks"] == 1
    assert body["statusBreakdown"]["missed"] == 1
    # MISSED is "remaining" (not LEFT/IGNORED) but not COMPLETED, so the task
    # is neither completed nor abandoned — it stays IN_PROGRESS, flagged overdue.
    assert body["completion"]["completedUniqueTasks"] == 1
    assert body["completion"]["abandonedUniqueTasks"] == 0
    assert body["completion"]["remainingUniqueTasks"] == 1

    by_title = {t["title"]: t for t in body["tasks"]}
    assert by_title["Missed it"]["overdue"] is True
    assert by_title["Missed it"]["taskStatus"] == "IN_PROGRESS"
    assert by_title["On time"]["overdue"] is False
    assert by_title["On time"]["taskStatus"] == "COMPLETED"


async def test_per_assignee_workload(db_app):
    project_id = await _project(ORG_A, SENDER, "Workload")
    a, b = _id(), _id()
    t1 = await _task(ORG_A, SENDER, project_id)
    await _assignee_row(ORG_A, t1, a, "COMPLETED")
    t2 = await _task(ORG_A, SENDER, project_id)
    await _assignee_row(ORG_A, t2, a, "SENT")
    await _assignee_row(ORG_A, t2, b, "COMPLETED")

    r = await _get(project_id, SENDER)
    workload = {w["assigneeId"]: w for w in r.json()["workload"]}
    assert workload[a]["assignedCount"] == 2
    assert workload[a]["completedCount"] == 1
    assert workload[a]["completionRate"] == 50.0
    assert workload[b]["assignedCount"] == 1
    assert workload[b]["completedCount"] == 1
    assert workload[b]["completionRate"] == 100.0


async def test_task_breakdown_carries_title_assignees_dates_and_deadline(db_app, seed_members):
    project_id = await _project(ORG_A, SENDER, "Breakdown")
    await seed_members(ORG_A, SENDER)
    deadline = datetime.now(timezone.utc) + timedelta(days=3)
    task_id = await _task(ORG_A, SENDER, project_id, title="Ship the report", deadline_at=deadline)
    assignee = _id()
    await seed_members(ORG_A, assignee)
    await _assignee_row(ORG_A, task_id, assignee, "ACKNOWLEDGED")

    r = await _get(project_id, SENDER)
    assert r.status_code == 200, r.text
    [task] = r.json()["tasks"]
    assert task["taskId"] == task_id
    assert task["title"] == "Ship the report"
    assert task["senderId"] == SENDER
    assert task["senderUsername"] == "member-0"
    assert task["deadlineAt"] is not None
    assert task["createdAt"] is not None
    [a] = task["assignees"]
    assert a["assigneeId"] == assignee
    assert a["status"] == "ACKNOWLEDGED"
    assert a["assignedAt"] is not None


async def test_task_breakdown_is_paginated_without_skewing_aggregate_metrics(db_app):
    project_id = await _project(ORG_A, SENDER, "Paginated")
    base = datetime.now(timezone.utc)
    task_ids = []
    for i in range(5):
        task_id = await _task(ORG_A, SENDER, project_id, title=f"Task {i}", created_at=base - timedelta(minutes=i))
        await _assignee_row(ORG_A, task_id, _id(), "COMPLETED" if i < 2 else "SENT")
        task_ids.append(task_id)

    first_page = await _get(project_id, SENDER, limit=2, offset=0)
    assert first_page.status_code == 200, first_page.text
    body = first_page.json()
    assert body["tasksTotal"] == 5
    assert body["tasksLimit"] == 2
    assert body["tasksOffset"] == 0
    assert [t["title"] for t in body["tasks"]] == ["Task 0", "Task 1"]
    # Aggregate metrics are over the WHOLE project, not just this page.
    assert body["completion"]["totalUniqueTasks"] == 5
    assert body["completion"]["completedUniqueTasks"] == 2

    last_page = await _get(project_id, SENDER, limit=2, offset=4)
    assert last_page.status_code == 200, last_page.text
    last_body = last_page.json()
    assert [t["title"] for t in last_body["tasks"]] == ["Task 4"]
    assert last_body["tasksOffset"] == 4

    seen = set()
    for offset in (0, 2, 4):
        page = await _get(project_id, SENDER, limit=2, offset=offset)
        seen.update(t["taskId"] for t in page.json()["tasks"])
    assert seen == set(task_ids)


async def test_a_project_nobody_sent_or_was_assigned_a_task_on_is_not_found(db_app):
    """_AUTHORIZED_PROJECT requires the caller to be a sender or assignee of at
    least one task in the project — the same rule GET /projects/{id} enforces.
    A bystander with no task in the project gets a 404, exactly like a
    non-member hitting channel_analytics."""
    project_id = await _project(ORG_A, SENDER, "Not yours")
    task_id = await _task(ORG_A, SENDER, project_id)
    await _assignee_row(ORG_A, task_id, _id(), "SENT")

    outsider = _id()
    r = await _get(project_id, outsider)
    assert r.status_code == 404


async def test_nonexistent_project_is_not_found(db_app):
    r = await _get(_id(), SENDER)
    assert r.status_code == 404


async def test_malformed_project_id_is_not_found(db_app):
    async with await _client(SENDER) as c:
        r = await c.get("/api/v1/tasks/projects/not-a-uuid/analytics")
    assert r.status_code == 404


async def test_a_projects_tasks_from_another_org_are_invisible(db_app):
    project_a = await _project(ORG_A, SENDER, "Shared Name")
    task_a = await _task(ORG_A, SENDER, project_a)
    await _assignee_row(ORG_A, task_a, _id(), "COMPLETED")

    project_b = await _project(ORG_B, SENDER, "Shared Name")
    task_b = await _task(ORG_B, SENDER, project_b)
    await _assignee_row(ORG_B, task_b, _id(), "COMPLETED")

    assert project_a != project_b
    r = await _get(project_a, SENDER, org=ORG_A)
    assert r.status_code == 200, r.text
    assert r.json()["completion"]["totalUniqueTasks"] == 1
