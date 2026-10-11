"""GET /tasks/{taskId}/analytics — snapshot analytics for one task.

Seeds task_assignees rows directly (bypassing the create endpoint, same
convention as test_task_channels_integrity.py) so each test controls the exact
status/timeline mix, then drives the real route over HTTP.
"""

from __future__ import annotations

import uuid
from datetime import datetime

import httpx
import pytest
from sqlalchemy import text


def _dt(iso: str | None):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")) if iso else None

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


async def _assignee_row(
    org: str,
    task_id: str,
    assignee_id: str,
    status: str,
    *,
    assigned_at: str | None = None,
    acknowledged_at: str | None = None,
    completed_at: str | None = None,
    ignored_at: str | None = None,
    left_at: str | None = None,
) -> None:
    from app.db import session, set_org_context

    assert status in ("SENT", "IGNORED", "ACKNOWLEDGED", "COMPLETED", "LEFT")
    async with session() as db:
        await set_org_context(db, org)
        await db.execute(
            text(
                "INSERT INTO task_assignees "
                "(task_id, org_id, assignee_id, status, assigned_at, acknowledged_at, completed_at, ignored_at, left_at) "
                f"VALUES (:t, :o, :a, '{status}', COALESCE(:assigned, now()), :ack, :comp, :ign, :left)"
            ),
            {
                "t": task_id,
                "o": org,
                "a": assignee_id,
                "assigned": _dt(assigned_at),
                "ack": _dt(acknowledged_at),
                "comp": _dt(completed_at),
                "ign": _dt(ignored_at),
                "left": _dt(left_at),
            },
        )
        await db.commit()


async def _get(task_id: str, as_user: str, org: str = ORG_A) -> httpx.Response:
    async with await _client(as_user, org) as c:
        return await c.get(f"/api/v1/tasks/{task_id}/analytics")


async def test_single_assignee_completed_task_reports_turnaround(db_app):
    task_id = await _task(ORG_A, SENDER)
    a = _id()
    await _assignee_row(
        ORG_A,
        task_id,
        a,
        "COMPLETED",
        assigned_at="2026-01-01T00:00:00Z",
        acknowledged_at="2026-01-01T01:00:00Z",
        completed_at="2026-01-01T03:00:00Z",
    )

    r = await _get(task_id, SENDER)
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["statusBreakdown"] == {
        "sent": 0, "acknowledged": 0, "completed": 1, "ignored": 0, "left": 0, "missed": 0,
    }
    assert body["completion"]["totalAssignments"] == 1
    assert body["completion"]["completedAssignments"] == 1
    assert body["completion"]["assignmentCompletionRate"] == 100.0
    assert body["completion"]["totalUniqueTasks"] == 1
    assert body["completion"]["completedUniqueTasks"] == 1
    assert body["completion"]["abandonedUniqueTasks"] == 0
    assert body["completion"]["uniqueTaskCompletionRate"] == 100.0
    # 3 hours = 10800 seconds.
    assert body["assignees"][0]["turnaroundSeconds"] == pytest.approx(10800.0)


async def test_mixed_assignees_diverge_assignment_vs_unique_task_rate(db_app):
    """1 of 3 rows COMPLETED, but the task is not unique-task-complete because
    two rows (SENT, ACKNOWLEDGED) are still remaining and incomplete."""
    task_id = await _task(ORG_A, SENDER)
    a, b, c = _id(), _id(), _id()
    await _assignee_row(ORG_A, task_id, a, "COMPLETED", completed_at="2026-01-01T00:00:00Z")
    await _assignee_row(ORG_A, task_id, b, "ACKNOWLEDGED")
    await _assignee_row(ORG_A, task_id, c, "SENT")

    r = await _get(task_id, SENDER)
    assert r.status_code == 200, r.text
    completion = r.json()["completion"]

    assert completion["totalAssignments"] == 3
    assert completion["completedAssignments"] == 1
    assert completion["assignmentCompletionRate"] == pytest.approx(100 / 3)
    assert completion["totalUniqueTasks"] == 1
    assert completion["completedUniqueTasks"] == 0
    assert completion["abandonedUniqueTasks"] == 0
    assert completion["remainingUniqueTasks"] == 1
    assert completion["uniqueTaskCompletionRate"] == 0.0


async def test_task_complete_when_every_remaining_row_is_completed_despite_a_left_row(db_app):
    """A left assignee does not block completion: only non-LEFT/non-IGNORED rows
    are tested, per the documented rule."""
    task_id = await _task(ORG_A, SENDER)
    a, b = _id(), _id()
    await _assignee_row(ORG_A, task_id, a, "COMPLETED", completed_at="2026-01-01T00:00:00Z")
    await _assignee_row(ORG_A, task_id, b, "LEFT", left_at="2026-01-01T00:00:00Z")

    r = await _get(task_id, SENDER)
    assert r.status_code == 200, r.text
    completion = r.json()["completion"]

    assert completion["completedAssignments"] == 1
    assert completion["assignmentCompletionRate"] == 50.0  # raw rate still counts the LEFT row
    assert completion["completedUniqueTasks"] == 1
    assert completion["abandonedUniqueTasks"] == 0
    assert completion["uniqueTaskCompletionRate"] == 100.0


async def test_everyone_left_or_ignored_is_abandoned_not_complete(db_app):
    task_id = await _task(ORG_A, SENDER)
    a, b = _id(), _id()
    await _assignee_row(ORG_A, task_id, a, "LEFT", left_at="2026-01-01T00:00:00Z")
    await _assignee_row(ORG_A, task_id, b, "IGNORED", ignored_at="2026-01-01T00:00:00Z")

    r = await _get(task_id, SENDER)
    assert r.status_code == 200, r.text
    completion = r.json()["completion"]

    assert completion["completedUniqueTasks"] == 0
    assert completion["abandonedUniqueTasks"] == 1
    assert completion["remainingUniqueTasks"] == 0
    assert completion["uniqueTaskCompletionRate"] == 0.0


async def test_visible_to_sender_and_to_an_assignee(db_app):
    task_id = await _task(ORG_A, SENDER)
    a = _id()
    await _assignee_row(ORG_A, task_id, a, "SENT")

    assert (await _get(task_id, SENDER)).status_code == 200
    assert (await _get(task_id, a)).status_code == 200


async def test_not_visible_to_an_unrelated_user(db_app):
    task_id = await _task(ORG_A, SENDER)
    a, stranger = _id(), _id()
    await _assignee_row(ORG_A, task_id, a, "SENT")

    r = await _get(task_id, stranger)
    assert r.status_code == 404


async def test_unknown_task_is_404(db_app):
    r = await _get(_id(), SENDER)
    assert r.status_code == 404


async def test_a_task_from_another_org_is_invisible(db_app):
    task_id = await _task(ORG_A, SENDER)
    a = _id()
    await _assignee_row(ORG_A, task_id, a, "SENT")

    r = await _get(task_id, SENDER, org=ORG_B)
    assert r.status_code == 404
