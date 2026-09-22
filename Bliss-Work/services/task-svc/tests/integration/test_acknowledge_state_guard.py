"""acknowledge must not report success for an invalid transition.

Regression coverage: complete/ignore/leave (transitions.py) all check the
current status when their conditional UPDATE no-ops, returning success only
when the no-op means "already at the target" and 409 for anything else.
acknowledge used to skip that check and always return 200 — so re-acknowledging
a task the assignee had already COMPLETED (or IGNORED, or LEFT) reported fake
success instead of the real conflict.
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


async def _assignee_status(task_id: str, assignee_id: str) -> str:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        row = (
            await conn.execute(
                text("SELECT status FROM task_assignees WHERE task_id = :tid AND assignee_id = :aid"),
                {"tid": task_id, "aid": assignee_id},
            )
        ).first()
        return row.status


# ── The bug: re-acknowledging a COMPLETED task must 409, not 200 ────────────
async def test_acknowledge_after_complete_is_a_conflict_not_a_fake_success(db_app, seed_members):
    await seed_members(ORG, SENDER)
    async with await _client() as c:
        r = await c.post("/api/v1/tasks", json={"title": "one shot", "assigneeIds": [SENDER]})
        assert r.status_code == 201, r.text
        task_id = r.json()["taskId"]

        assert (await c.post(f"/api/v1/tasks/{task_id}/assignees/me/acknowledge")).status_code == 200
        assert (await c.post(f"/api/v1/tasks/{task_id}/assignees/me/complete")).status_code == 200
        assert await _assignee_status(task_id, SENDER) == "COMPLETED"

        # The bug: this used to return 200 with the (misleadingly reported)
        # current status, as if the acknowledge itself had succeeded.
        stale_ack = await c.post(f"/api/v1/tasks/{task_id}/assignees/me/acknowledge")
        assert stale_ack.status_code == 409, stale_ack.text
        assert "COMPLETED" in stale_ack.json()["error"]["message"]

    # And the state itself must be untouched by the rejected call.
    assert await _assignee_status(task_id, SENDER) == "COMPLETED"


# ── Positive control: acknowledging an already-ACKNOWLEDGED task is still a
# genuinely idempotent 200 ───────────────────────────────────────────────────
async def test_acknowledge_twice_in_a_row_is_still_idempotent(db_app, seed_members):
    await seed_members(ORG, SENDER)
    async with await _client() as c:
        r = await c.post("/api/v1/tasks", json={"title": "double ack", "assigneeIds": [SENDER]})
        assert r.status_code == 201, r.text
        task_id = r.json()["taskId"]

        first = await c.post(f"/api/v1/tasks/{task_id}/assignees/me/acknowledge")
        assert first.status_code == 200, first.text

        second = await c.post(f"/api/v1/tasks/{task_id}/assignees/me/acknowledge")
        assert second.status_code == 200, second.text
        assert second.json()["status"] == "ACKNOWLEDGED"

    assert await _assignee_status(task_id, SENDER) == "ACKNOWLEDGED"
