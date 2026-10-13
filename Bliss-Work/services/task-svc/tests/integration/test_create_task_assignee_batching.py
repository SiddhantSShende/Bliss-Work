"""`POST /tasks` with multiple assignees — the batched-insert fan-out path.

Regression coverage for turning the per-assignee INSERT loop in
routes/tasks_write.py::create_task (task_assignees + outbox, one row each per
assignee) into a single multi-VALUES INSERT per table, plus the new
`schemas.MAX_ASSIGNEES` cap on the resolved assignee list. See
_insert_task_assignees's docstring for why: an unbounded, unbatched
per-assignee loop turns "assign to a big channel" into a many-round-trip
transaction with no upper bound.

Three things must hold after batching:
  * the resulting task_assignees / outbox rows are exactly what the old
    per-row loop would have produced (same columns, one row per assignee);
  * the idempotency-key claim-then-insert race handling is untouched — a
    replayed request must still return the SAME task rather than creating a
    second one, with no duplicate rows;
  * a resolved assignee list over MAX_ASSIGNEES is rejected with a clear 400
    and writes nothing, rather than being accepted and left to time out.

Needs a real Postgres with RLS enforced (matches
test_by_title_internal_org_scoping.py) since task_assignees is org-isolated
and the insert must pass its WITH CHECK for every row, not just the first.
"""

from __future__ import annotations

import json
import uuid

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
SENDER = "33333333-3333-3333-3333-333333333333"
CHANNEL = "44444444-4444-4444-4444-444444444444"


def _principal(user_id: str = SENDER, org_id: str = ORG):
    from app.auth import Principal

    return Principal(user_id=user_id, org_id=org_id, roles=["member"], username="sender")


async def _client(principal=None) -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: principal or _principal()
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def _assignee_rows(task_id: str) -> list:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        return (
            await conn.execute(
                text(
                    "SELECT assignee_id, org_id, status, status_version FROM task_assignees "
                    "WHERE task_id = :tid ORDER BY assignee_id"
                ),
                {"tid": task_id},
            )
        ).all()


async def _outbox_rows(task_id: str) -> list:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        return (
            await conn.execute(
                text("SELECT id, topic, kafka_key, payload FROM outbox WHERE kafka_key = :tid"),
                {"tid": task_id},
            )
        ).all()


async def _task_count(org_id: str = ORG) -> int:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        row = (
            await conn.execute(
                text("SELECT count(*) AS n FROM tasks WHERE org_id = :org"), {"org": org_id}
            )
        ).first()
        return int(row.n)


def _payload_dict(raw) -> dict:
    return json.loads(raw) if isinstance(raw, str) else raw


async def test_multi_assignee_create_batches_all_rows(db_app, seed_members):
    """Same three assignees the old per-row loop would have produced: one
    task_assignees row each (status SENT, status_version 0) and one outbox
    row each carrying that assignee's task.assigned event."""
    assignees = [str(uuid.uuid4()) for _ in range(3)]
    await seed_members(ORG, *assignees)
    async with await _client() as c:
        r = await c.post(
            "/api/v1/tasks",
            json={
                "taskTitle": "Ship it",
                "title": "Ship it",
                "description": "batched fan-out",
                "assigneeIds": assignees,
            },
        )
        assert r.status_code == 201, r.text
        task_id = r.json()["taskId"]

    rows = await _assignee_rows(task_id)
    assert sorted(str(row.assignee_id) for row in rows) == sorted(assignees)
    for row in rows:
        assert str(row.org_id) == ORG
        assert row.status == "SENT"
        assert row.status_version == 0

    outbox = await _outbox_rows(task_id)
    assert len(outbox) == len(assignees)
    got_assignee_ids = set()
    for row in outbox:
        assert row.topic == "task.events.v1"
        payload = _payload_dict(row.payload)
        assert payload["type"] == "task.assigned"
        assert payload["taskId"] == task_id
        got_assignee_ids.add(payload["assigneeId"])
    assert got_assignee_ids == set(assignees)


async def test_idempotency_key_replay_returns_same_task_without_duplicating_rows(db_app, seed_members):
    """A replayed create (same Idempotency-Key) must resolve to the SAME task
    and must not insert a second copy of its assignee/outbox rows — the
    claim-then-insert race handling this batching change must not disturb."""
    assignees = [str(uuid.uuid4()) for _ in range(2)]
    await seed_members(ORG, *assignees)
    body = {"taskTitle": "Ship it twice?", "title": "Ship it twice?", "assigneeIds": assignees}
    headers = {"Idempotency-Key": "replay-key-1"}

    async with await _client() as c:
        r1 = await c.post("/api/v1/tasks", json=body, headers=headers)
        assert r1.status_code == 201, r1.text
        task_id_1 = r1.json()["taskId"]

        r2 = await c.post("/api/v1/tasks", json=body, headers=headers)
        assert r2.status_code == 201, r2.text
        task_id_2 = r2.json()["taskId"]

    assert task_id_1 == task_id_2
    assert await _task_count() == 1

    rows = await _assignee_rows(task_id_1)
    assert sorted(str(row.assignee_id) for row in rows) == sorted(assignees)

    outbox = await _outbox_rows(task_id_1)
    assert len(outbox) == len(assignees)


async def test_channel_assignee_list_over_cap_is_rejected(db_app, monkeypatch):
    """The channel-resolved fan-out path never passes through pydantic's
    `assigneeIds` bound, so it needs MAX_ASSIGNEES enforced explicitly. A
    channel with more members than the cap must fail cleanly and write
    nothing, rather than being accepted into a transaction that would only
    time out."""
    from app.routes import tasks_write

    over_cap = [str(uuid.uuid4()) for _ in range(tasks_write.MAX_ASSIGNEES + 1)]

    async def _fake_resolve(channel_id: str, org_id: str, caller_id: str) -> tuple[list[str], str]:
        return over_cap, ""

    monkeypatch.setattr(tasks_write, "_resolve_channel_members", _fake_resolve)

    async with await _client() as c:
        r = await c.post(
            "/api/v1/tasks",
            json={"taskTitle": "Company all-hands", "title": "Company all-hands", "channelId": CHANNEL},
        )
        assert r.status_code == 400, r.text
        assert "too many assignees" in r.json()["error"]["message"]

    assert await _task_count() == 0


async def test_channel_assignee_list_at_cap_is_accepted(db_app, monkeypatch):
    """The boundary case: exactly MAX_ASSIGNEES resolved members is still
    accepted, and the batched INSERT actually produces a row for every one of
    them in a single statement."""
    from app.routes import tasks_write

    at_cap = [str(uuid.uuid4()) for _ in range(tasks_write.MAX_ASSIGNEES)]

    async def _fake_resolve(channel_id: str, org_id: str, caller_id: str) -> tuple[list[str], str]:
        return at_cap, ""

    monkeypatch.setattr(tasks_write, "_resolve_channel_members", _fake_resolve)

    async with await _client() as c:
        r = await c.post(
            "/api/v1/tasks",
            json={"taskTitle": "Company all-hands", "title": "Company all-hands", "channelId": CHANNEL},
        )
        assert r.status_code == 201, r.text
        task_id = r.json()["taskId"]

    rows = await _assignee_rows(task_id)
    assert len(rows) == tasks_write.MAX_ASSIGNEES
    assert sorted(str(row.assignee_id) for row in rows) == sorted(at_cap)
