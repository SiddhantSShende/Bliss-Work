"""`POST /tasks` with the sender in `assigneeIds` (self-assignment).

Regression coverage for lifting the `sender_id in assignee_ids` 400 in
routes/tasks_write.py::create_task. Self-assignment already flowed through
untouched via channel mode (a caller who is a member of the target channel),
so this only extends the same allowance to the direct People-mode path: the
People picker (usePeopleCandidates, `includeSelf`) now offers the caller as a
pick target.

Two things must hold:
  * creating a task assigned to yourself is accepted and persists exactly
    like any other single-assignee task;
  * the Acknowledge/Ignore lifecycle (transitions.py) does not assume the
    assignee differs from the sender — a self-assigned task can still be
    acknowledged end-to-end.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
SENDER = "33333333-3333-3333-3333-333333333333"


def _principal(user_id: str = SENDER, org_id: str = ORG):
    from app.auth import Principal

    return Principal(user_id=user_id, org_id=org_id, roles=["member"], username="sender")


async def _client(principal=None) -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: principal or _principal()
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def _assignee_row(task_id: str, assignee_id: str):
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        return (
            await conn.execute(
                text(
                    "SELECT status, status_version FROM task_assignees "
                    "WHERE task_id = :tid AND assignee_id = :aid"
                ),
                {"tid": task_id, "aid": assignee_id},
            )
        ).first()


async def test_self_assignment_is_accepted_and_persists(db_app, seed_members):
    await seed_members(ORG, SENDER)
    async with await _client() as c:
        r = await c.post(
            "/api/v1/tasks",
            json={"title": "Follow up with myself", "assigneeIds": [SENDER]},
        )
        assert r.status_code == 201, r.text
        task_id = r.json()["taskId"]

    row = await _assignee_row(task_id, SENDER)
    assert row is not None
    assert row.status == "SENT"
    assert row.status_version == 0


async def test_self_assigned_task_can_be_acknowledged(db_app, seed_members):
    await seed_members(ORG, SENDER)
    async with await _client() as c:
        r = await c.post(
            "/api/v1/tasks",
            json={"title": "Remember to do this", "assigneeIds": [SENDER]},
        )
        assert r.status_code == 201, r.text
        task_id = r.json()["taskId"]

        ack = await c.post(f"/api/v1/tasks/{task_id}/assignees/me/acknowledge")
        assert ack.status_code == 200, ack.text

    row = await _assignee_row(task_id, SENDER)
    assert row.status == "ACKNOWLEDGED"
