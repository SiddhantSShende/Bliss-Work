"""The user's own pin/unpin against a real Postgres, through the real handlers.

`tests/test_transitions.py` proves the RULE; this proves the SQL and the
transaction around it — the row lock, the same-transaction outbox write, RLS
isolation between users and orgs, and that the Kafka consumer and a user's
choice do not trample each other.
"""

from __future__ import annotations

import json
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from app.auth import Principal
from app.consumer import consumer
from app.db import session, set_bypass_rls, set_org_context
from app.outbox import OutboxPoller
from app.routes.internal import undelivered
from app.routes.pins import list_pins, pin_task, unpin_task

pytestmark = pytest.mark.integration

ORG_A = "11111111-1111-4111-8111-111111111111"
ORG_B = "22222222-2222-4222-8222-222222222222"
ALICE = "33333333-3333-4333-8333-333333333333"
BOB = "44444444-4444-4444-8444-444444444444"


def who(user: str, org: str = ORG_A) -> Principal:
    return Principal(user_id=user, org_id=org, roles=["member"], username=user[:4])


def event(kind: str, *, task: str, assignee: str = ALICE, org: str = ORG_A, version: int = 0) -> dict:
    return {
        "type": kind,
        "eventId": str(uuid.uuid4()),
        "orgId": org,
        "occurredAt": "2026-09-01T10:00:00.000Z",
        "taskId": task,
        "assigneeId": assignee,
        "senderId": BOB,
        "statusVersion": version,
    }


async def assigned(assignee: str = ALICE, org: str = ORG_A) -> str:
    task = str(uuid.uuid4())
    await consumer.handle(event("task.assigned", task=task, assignee=assignee, org=org))
    return task


async def ids(user: str, org: str = ORG_A, *, include_unpinned: bool = False) -> dict[str, str]:
    pins = await list_pins(principal=who(user, org), limit=100, offset=0, include_unpinned=include_unpinned)
    return {p.taskId: p.pinState for p in pins}


async def outbox() -> list[dict]:
    async with session() as db:
        await set_bypass_rls(db)
        rows = (await db.execute(text("SELECT topic, kafka_key, payload FROM outbox ORDER BY created_at"))).all()
    return [
        {"topic": r.topic, "key": r.kafka_key, "payload": r.payload if isinstance(r.payload, dict) else json.loads(r.payload)}
        for r in rows
    ]


@pytest.fixture(autouse=True)
async def _clean_outbox(db_app):
    async with session() as db:
        await set_bypass_rls(db)
        await db.execute(text("DELETE FROM outbox"))
        await db.commit()


# ── Pin ───────────────────────────────────────────────────────────────────────
class TestPin:
    async def test_a_new_assignment_is_pinned_by_default(self, db_app):
        task = await assigned()
        assert await ids(ALICE) == {task: "PINNED"}

    async def test_pin_returns_the_state_and_persists_it(self, db_app):
        task = await assigned()
        await unpin_task(uuid.UUID(task), principal=who(ALICE))
        res = await pin_task(uuid.UUID(task), principal=who(ALICE))
        assert (res.taskId, res.state, res.pinState, res.status) == (task, "PINNED", "PINNED", "OPEN")
        assert await ids(ALICE) == {task: "PINNED"}  # a fresh read, not the response

    async def test_repeated_pin_is_idempotent_and_emits_once(self, db_app):
        task = await assigned()
        await unpin_task(uuid.UUID(task), principal=who(ALICE))
        await pin_task(uuid.UUID(task), principal=who(ALICE))
        again = await pin_task(uuid.UUID(task), principal=who(ALICE))
        assert again.state == "PINNED"
        assert await ids(ALICE) == {task: "PINNED"}
        # unpin + the first pin only: the retry changed nothing, so it said nothing.
        assert [e["payload"]["pinState"] for e in await outbox()] == ["UNPINNED", "PINNED"]


# ── Unpin ─────────────────────────────────────────────────────────────────────
class TestUnpin:
    async def test_unpin_closes_the_sticky_for_that_user(self, db_app):
        task = await assigned()
        res = await unpin_task(uuid.UUID(task), principal=who(ALICE))
        assert (res.state, res.pinState, res.status) == ("UNPINNED", "UNPINNED", "OPEN")
        # Gone from the default read (what an older client floats from)…
        assert await ids(ALICE) == {}
        # …but still an open commitment a newer client can see and re-pin.
        assert await ids(ALICE, include_unpinned=True) == {task: "UNPINNED"}

    async def test_repeated_unpin_is_idempotent_and_emits_once(self, db_app):
        task = await assigned()
        await unpin_task(uuid.UUID(task), principal=who(ALICE))
        again = await unpin_task(uuid.UUID(task), principal=who(ALICE))
        assert again.state == "UNPINNED"
        assert await ids(ALICE, include_unpinned=True) == {task: "UNPINNED"}
        assert len(await outbox()) == 1

    async def test_an_unpinned_note_is_not_nudged_by_the_watchdog(self, db_app):
        # An unpinned note is not "lost in transit"; nudging would fight the user.
        from app.config import settings

        settings.internal_token = "t"
        await assigned()
        task_unpinned = await assigned()
        await unpin_task(uuid.UUID(task_unpinned), principal=who(ALICE))
        claimed = await undelivered(older_than_s=0, limit=50, internal_token="t")
        assert task_unpinned not in {c.taskId for c in claimed}
        assert len(claimed) == 1


# ── Re-pin ────────────────────────────────────────────────────────────────────
class TestRepin:
    async def test_unpin_then_pin_again_reopens_the_sticky(self, db_app):
        task = await assigned()
        await unpin_task(uuid.UUID(task), principal=who(ALICE))
        assert await ids(ALICE) == {}
        await pin_task(uuid.UUID(task), principal=who(ALICE))
        assert await ids(ALICE) == {task: "PINNED"}
        assert await ids(ALICE, include_unpinned=True) == {task: "PINNED"}

    async def test_an_explicit_unpin_never_blacklists_the_task(self, db_app):
        task = await assigned()
        for _ in range(3):
            await unpin_task(uuid.UUID(task), principal=who(ALICE))
            await pin_task(uuid.UUID(task), principal=who(ALICE))
        assert await ids(ALICE) == {task: "PINNED"}

    async def test_a_repin_is_visible_to_the_delivery_watchdog_again(self, db_app):
        task = await assigned()
        async with session() as db:
            await set_org_context(db, ORG_A)
            await db.execute(
                text("UPDATE sticky_pins SET last_delivered_at = now(), delivery_attempts = 3 WHERE task_id = :t"),
                {"t": task},
            )
            await db.commit()
        await unpin_task(uuid.UUID(task), principal=who(ALICE))
        await pin_task(uuid.UUID(task), principal=who(ALICE))
        pins = await list_pins(principal=who(ALICE), limit=10, offset=0)
        assert pins[0].lastDeliveredAt is None


# ── Isolation and authorization ───────────────────────────────────────────────
class TestIsolation:
    async def test_one_users_unpin_does_not_touch_another_users_pin(self, db_app):
        task = str(uuid.uuid4())
        await consumer.handle(event("task.assigned", task=task, assignee=ALICE))
        await consumer.handle(event("task.assigned", task=task, assignee=BOB))
        await unpin_task(uuid.UUID(task), principal=who(ALICE))
        assert await ids(ALICE) == {}
        assert await ids(BOB) == {task: "PINNED"}

    async def test_one_users_pin_does_not_touch_another_users_unpin(self, db_app):
        task = str(uuid.uuid4())
        await consumer.handle(event("task.assigned", task=task, assignee=ALICE))
        await consumer.handle(event("task.assigned", task=task, assignee=BOB))
        await unpin_task(uuid.UUID(task), principal=who(BOB))
        await unpin_task(uuid.UUID(task), principal=who(ALICE))
        await pin_task(uuid.UUID(task), principal=who(ALICE))
        assert await ids(ALICE) == {task: "PINNED"}
        assert await ids(BOB, include_unpinned=True) == {task: "UNPINNED"}

    async def test_events_are_addressed_to_the_user_who_acted(self, db_app):
        task = str(uuid.uuid4())
        await consumer.handle(event("task.assigned", task=task, assignee=ALICE))
        await consumer.handle(event("task.assigned", task=task, assignee=BOB))
        await unpin_task(uuid.UUID(task), principal=who(ALICE))
        [e] = await outbox()
        assert e["payload"]["assigneeId"] == ALICE and e["key"] == ALICE

    async def test_a_task_that_is_not_yours_is_a_404(self, db_app):
        task = await assigned(assignee=BOB)  # Bob's task
        for call in (pin_task, unpin_task):
            with pytest.raises(HTTPException) as exc:
                await call(uuid.UUID(task), principal=who(ALICE))
            assert exc.value.status_code == 404
        assert await ids(BOB) == {task: "PINNED"}
        assert await outbox() == []

    async def test_another_orgs_task_is_a_404(self, db_app):
        task = await assigned(assignee=ALICE, org=ORG_B)
        with pytest.raises(HTTPException) as exc:
            await unpin_task(uuid.UUID(task), principal=who(ALICE, ORG_A))
        assert exc.value.status_code == 404
        assert await ids(ALICE, ORG_B) == {task: "PINNED"}

    async def test_an_unknown_task_is_a_404(self, db_app):
        with pytest.raises(HTTPException) as exc:
            await pin_task(uuid.uuid4(), principal=who(ALICE))
        assert exc.value.status_code == 404


# ── Lifecycle ─────────────────────────────────────────────────────────────────
class TestLifecycle:
    async def test_a_terminal_status_closes_the_sticky(self, db_app):
        task = await assigned()
        await consumer.handle(event("task.completed", task=task, version=2))
        assert await ids(ALICE, include_unpinned=True) == {}

    async def test_terminal_closure_is_not_recorded_as_an_unpin(self, db_app):
        task = await assigned()
        await consumer.handle(event("task.completed", task=task, version=2))
        async with session() as db:
            await set_org_context(db, ORG_A)
            row = (await db.execute(text("SELECT status, pin_state, close_reason FROM sticky_pins WHERE task_id = :t"), {"t": task})).first()
        assert (row.status, row.pin_state, row.close_reason) == ("CLOSED", "PINNED", "COMPLETED")
        assert await outbox() == []  # and it is not a pin-change event either

    async def test_a_closed_task_cannot_be_pinned_but_unpin_stays_idempotent(self, db_app):
        task = await assigned()
        await consumer.handle(event("task.completed", task=task, version=2))
        with pytest.raises(HTTPException) as exc:
            await pin_task(uuid.UUID(task), principal=who(ALICE))
        assert exc.value.status_code == 409
        res = await unpin_task(uuid.UUID(task), principal=who(ALICE))
        assert res.state == "CLOSED"
        assert await outbox() == []

    async def test_lifecycle_events_do_not_overwrite_an_explicit_unpin(self, db_app):
        task = await assigned()
        await unpin_task(uuid.UUID(task), principal=who(ALICE))
        await consumer.handle(event("task.acknowledged", task=task, version=1))
        await consumer.handle(event("task.assigned", task=task, version=0))  # a redelivered/duplicate assignment
        assert await ids(ALICE, include_unpinned=True) == {task: "UNPINNED"}

    async def test_lifecycle_events_do_not_overwrite_an_explicit_repin(self, db_app):
        task = await assigned()
        await unpin_task(uuid.UUID(task), principal=who(ALICE))
        await pin_task(uuid.UUID(task), principal=who(ALICE))
        await consumer.handle(event("task.acknowledged", task=task, version=1))
        assert await ids(ALICE) == {task: "PINNED"}

    async def test_a_fresh_assignment_after_a_terminal_close_starts_pinned_again(self, db_app):
        # An Unpin was a decision about the PREVIOUS commitment. A task assigned
        # afresh must surface, not stay hidden behind it.
        task = await assigned()
        await unpin_task(uuid.UUID(task), principal=who(ALICE))
        await consumer.handle(event("task.completed", task=task, version=3))
        await consumer.handle(event("task.assigned", task=task, version=0))
        assert await ids(ALICE) == {task: "PINNED"}


# ── Realtime ──────────────────────────────────────────────────────────────────
class TestRealtime:
    async def test_pin_and_unpin_each_emit_one_event_with_the_right_payload(self, db_app):
        task = await assigned()
        await unpin_task(uuid.UUID(task), principal=who(ALICE))
        await pin_task(uuid.UUID(task), principal=who(ALICE))
        events = await outbox()
        assert [e["payload"]["pinState"] for e in events] == ["UNPINNED", "PINNED"]
        for e in events:
            assert e["topic"] == "task.events.v1"
            p = e["payload"]
            assert p["type"] == "sticky.pin.changed"
            assert (p["assigneeId"], p["taskId"], p["orgId"]) == (ALICE, task, ORG_A)
            assert p["eventId"] and p["occurredAt"].endswith("Z")
            assert set(p) == {"type", "eventId", "orgId", "occurredAt", "assigneeId", "taskId", "pinState"}

    async def test_the_event_commits_with_the_state_or_not_at_all(self, db_app):
        # A request that fails after the write must leave neither: no state
        # change without its event, no event for a change that rolled back.
        task = await assigned()
        from app import events as ev

        real = ev.enqueue

        async def boom(*a, **k):
            raise RuntimeError("outbox unavailable")

        import app.routes.pins as pins_mod

        pins_mod.enqueue = boom
        try:
            with pytest.raises(RuntimeError):
                await unpin_task(uuid.UUID(task), principal=who(ALICE))
        finally:
            pins_mod.enqueue = real
        assert await ids(ALICE) == {task: "PINNED"}
        assert await outbox() == []

    async def test_the_poller_publishes_the_event_to_kafka(self, db_app):
        task = await assigned()
        await unpin_task(uuid.UUID(task), principal=who(ALICE))

        sent: list[dict] = []

        class FakeProducer:
            async def send_and_wait(self, topic, value, key, headers):
                sent.append({"topic": topic, "value": value, "key": key})

        poller = OutboxPoller()

        async def ensure():
            return FakeProducer()

        poller._ensure_producer = ensure  # type: ignore[method-assign]
        assert await poller._drain_once() == 1
        assert sent[0]["topic"] == "task.events.v1"
        assert sent[0]["key"] == ALICE
        assert sent[0]["value"]["type"] == "sticky.pin.changed"
        assert sent[0]["value"]["pinState"] == "UNPINNED"
        assert await poller._drain_once() == 0  # marked published, not re-sent
