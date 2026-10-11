"""GET /tasks/channels/{channelId}/analytics — snapshot analytics across every
task attached to a channel (task_channels), joined to task_assignees.

messaging-svc's channel-membership check is stubbed exactly like
test_create_task_mixed_targets.py stubs it for task creation: _resolve_channel_members
is bound at import in app.routes.tasks_analytics too, so the patch target here is
that module, not tasks_write.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from fastapi import HTTPException
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


@pytest.fixture
def channels(monkeypatch):
    """channel id -> membership answer: a list of member ids, or "dead" (404,
    not a member / channel doesn't exist), mirroring test_create_task_mixed_targets.py."""
    from app.routes import tasks_analytics

    table: dict[str, list[str] | str] = {}

    async def _resolve(channel_id: str, org_id: str, caller_id: str) -> list[str]:
        answer = table.get(channel_id, "dead")
        if answer == "dead":
            raise HTTPException(status_code=404, detail="channel not found")
        return list(answer)

    monkeypatch.setattr(tasks_analytics, "_resolve_channel_members", _resolve)
    return table


async def _task(org: str, sender: str, title: str = "Task") -> str:
    from app.db import session, set_org_context
    from crypto import cryptor

    task_id = _id()
    async with session() as db:
        await set_org_context(db, org)
        enc = await cryptor().encrypt(db, org, title)
        await db.execute(
            text("INSERT INTO tasks (id, org_id, sender_id, title_enc) VALUES (:t, :o, :s, :e)"),
            {"t": task_id, "o": org, "s": sender, "e": enc},
        )
        await db.commit()
    return task_id


async def _attach_channel(org: str, task_id: str, channel_id: str) -> None:
    from app.db import session, set_org_context

    async with session() as db:
        await set_org_context(db, org)
        await db.execute(
            text("INSERT INTO task_channels (task_id, org_id, channel_id) VALUES (:t, :o, :c)"),
            {"t": task_id, "o": org, "c": channel_id},
        )
        await db.commit()


async def _assignee_row(org: str, task_id: str, assignee_id: str, status: str) -> None:
    from app.db import session, set_org_context

    assert status in ("SENT", "IGNORED", "ACKNOWLEDGED", "COMPLETED", "LEFT")
    async with session() as db:
        await set_org_context(db, org)
        await db.execute(
            text(
                "INSERT INTO task_assignees (task_id, org_id, assignee_id, status) "
                f"VALUES (:t, :o, :a, '{status}')"
            ),
            {"t": task_id, "o": org, "a": assignee_id},
        )
        await db.commit()


async def _get(channel_id: str, as_user: str, org: str = ORG_A) -> httpx.Response:
    async with await _client(as_user, org) as c:
        return await c.get(f"/api/v1/tasks/channels/{channel_id}/analytics")


async def test_channel_with_no_tasks_is_all_zero_not_divide_by_zero(db_app, channels):
    ch = _id()
    channels[ch] = [SENDER]

    r = await _get(ch, SENDER)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["completion"]["totalUniqueTasks"] == 0
    assert body["completion"]["assignmentCompletionRate"] == 0.0
    assert body["completion"]["uniqueTaskCompletionRate"] == 0.0
    assert body["workload"] == []


async def test_hundred_tasks_thirty_completed_is_thirty_percent(db_app, channels):
    """The exact example from the feature request: 100 unique tasks, 30
    complete (single assignee each, so assignment-level and unique-task-level
    coincide) -> 30% both ways."""
    ch = _id()
    channels[ch] = [SENDER]
    assignee = _id()

    for i in range(100):
        task_id = await _task(ORG_A, SENDER)
        await _attach_channel(ORG_A, task_id, ch)
        await _assignee_row(ORG_A, task_id, assignee, "COMPLETED" if i < 30 else "SENT")

    r = await _get(ch, SENDER)
    assert r.status_code == 200, r.text
    completion = r.json()["completion"]
    assert completion["totalUniqueTasks"] == 100
    assert completion["completedUniqueTasks"] == 30
    assert completion["uniqueTaskCompletionRate"] == 30.0
    assert completion["totalAssignments"] == 100
    assert completion["completedAssignments"] == 30
    assert completion["assignmentCompletionRate"] == 30.0


async def test_multi_assignee_task_diverges_assignment_from_unique_rate(db_app, channels):
    """One task, 4 assignees, 1 completed: assignment rate 25%, but the task is
    not unique-task-complete (3 remaining rows are incomplete)."""
    ch = _id()
    channels[ch] = [SENDER]
    task_id = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, task_id, ch)
    a, b, c, d = _id(), _id(), _id(), _id()
    await _assignee_row(ORG_A, task_id, a, "COMPLETED")
    await _assignee_row(ORG_A, task_id, b, "SENT")
    await _assignee_row(ORG_A, task_id, c, "ACKNOWLEDGED")
    await _assignee_row(ORG_A, task_id, d, "SENT")

    r = await _get(ch, SENDER)
    completion = r.json()["completion"]
    assert completion["totalUniqueTasks"] == 1
    assert completion["completedUniqueTasks"] == 0
    assert completion["remainingUniqueTasks"] == 1
    assert completion["totalAssignments"] == 4
    assert completion["completedAssignments"] == 1
    assert completion["assignmentCompletionRate"] == 25.0
    assert completion["uniqueTaskCompletionRate"] == 0.0


async def test_abandoned_task_is_excluded_from_completed_and_remaining(db_app, channels):
    ch = _id()
    channels[ch] = [SENDER]
    task_id = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, task_id, ch)
    a, b = _id(), _id()
    await _assignee_row(ORG_A, task_id, a, "LEFT")
    await _assignee_row(ORG_A, task_id, b, "IGNORED")

    r = await _get(ch, SENDER)
    completion = r.json()["completion"]
    assert completion["totalUniqueTasks"] == 1
    assert completion["completedUniqueTasks"] == 0
    assert completion["abandonedUniqueTasks"] == 1
    assert completion["remainingUniqueTasks"] == 0


async def test_per_assignee_workload(db_app, channels):
    ch = _id()
    channels[ch] = [SENDER]
    a, b = _id(), _id()
    t1 = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, t1, ch)
    await _assignee_row(ORG_A, t1, a, "COMPLETED")
    t2 = await _task(ORG_A, SENDER)
    await _attach_channel(ORG_A, t2, ch)
    await _assignee_row(ORG_A, t2, a, "SENT")
    await _assignee_row(ORG_A, t2, b, "COMPLETED")

    r = await _get(ch, SENDER)
    workload = {w["assigneeId"]: w for w in r.json()["workload"]}
    assert workload[a]["assignedCount"] == 2
    assert workload[a]["completedCount"] == 1
    assert workload[a]["completionRate"] == 50.0
    assert workload[b]["assignedCount"] == 1
    assert workload[b]["completedCount"] == 1
    assert workload[b]["completionRate"] == 100.0


async def test_non_member_is_rejected(db_app, channels):
    ch = _id()  # not registered in `channels` -> "dead"
    r = await _get(ch, SENDER)
    assert r.status_code == 404


async def test_a_channels_tasks_from_another_org_are_invisible(db_app, channels):
    ch = _id()
    channels[ch] = [SENDER]
    task_id = await _task(ORG_B, SENDER)
    await _attach_channel(ORG_B, task_id, ch)
    await _assignee_row(ORG_B, task_id, _id(), "COMPLETED")

    r = await _get(ch, SENDER, org=ORG_A)
    assert r.status_code == 200, r.text
    assert r.json()["completion"]["totalUniqueTasks"] == 0
