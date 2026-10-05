"""`GET /sticky/pins` paging must be stable when pins share an `opened_at`.

Tasks assigned in one burst open their pins in the same instant. The list was
ordered by `opened_at` alone, so LIMIT/OFFSET pages could skip a pin or repeat one
(PostgreSQL's top-N sort breaks ties differently per LIMIT+OFFSET). A skipped pin
is a task that never gets stuck to the desktop. `task_id` is the tiebreaker.
"""

from __future__ import annotations

import uuid

import pytest

from sqlalchemy import text

from app.auth import Principal
from app.consumer import consumer
from app.db import session, set_bypass_rls
from app.routes.pins import list_pins

pytestmark = pytest.mark.integration

ORG = "11111111-1111-4111-8111-111111111111"
ALICE = "33333333-3333-4333-8333-333333333333"
BOB = "44444444-4444-4444-8444-444444444444"


async def _assign(task: str) -> None:
    await consumer.handle(
        {
            "type": "task.assigned",
            "eventId": str(uuid.uuid4()),
            "orgId": ORG,
            "occurredAt": "2026-09-01T10:00:00.000Z",
            "taskId": task,
            "assigneeId": ALICE,
            "senderId": BOB,
            "statusVersion": 0,
        }
    )


async def _open_all_in_the_same_instant() -> None:
    """opened_at is the database's now(), so pins only tie when they are written in one
    transaction (a batched fetch of assignments). Pin them to one value to reproduce that."""
    async with session() as db:
        await set_bypass_rls(db)
        await db.execute(text("UPDATE sticky_pins SET opened_at = TIMESTAMPTZ '2026-09-01T10:00:00Z'"))
        await db.commit()


async def _page(limit: int, offset: int) -> list[str]:
    principal = Principal(user_id=ALICE, org_id=ORG, roles=["member"], username="alice")
    pins = await list_pins(principal=principal, limit=limit, offset=offset)
    return [p.taskId for p in pins]


async def test_paging_shows_every_pin_once_when_they_share_an_opened_at(db_app):
    tasks = [f"{n:08x}-0000-4000-8000-000000000000" for n in range(1, 61)]
    for task in reversed(tasks):  # inserted against task_id order, so heap order != tiebreak order
        await _assign(task)
    await _open_all_in_the_same_instant()

    everything = await _page(100, 0)
    paged: list[str] = []
    for offset in range(0, 60, 7):
        paged += await _page(7, offset)

    assert sorted(paged) == sorted(tasks)  # none skipped, none repeated
    assert paged == everything  # and in the order one unpaged read gives
    assert paged == sorted(tasks)  # oldest-first, task id breaking the tie
