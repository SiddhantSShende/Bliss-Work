"""The pin lifecycle against a real Postgres, through the real consumer.

`tests/test_transitions.py` proves the RULE; this proves the SQL that carries it
out — the upsert, the version guard in a real transaction, the partial indexes
the watchdog query depends on, and the RLS policy.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.consumer import consumer
from app.db import session, set_bypass_rls, set_org_context

pytestmark = pytest.mark.integration

ORG_A = "11111111-1111-4111-8111-111111111111"
ORG_B = "22222222-2222-4222-8222-222222222222"
ALICE = "33333333-3333-4333-8333-333333333333"
BOB = "44444444-4444-4444-8444-444444444444"


def event(kind: str, *, org=ORG_A, assignee=ALICE, task=None, version=0, **extra) -> dict:
    return {
        "type": kind,
        "eventId": str(uuid.uuid4()),
        "orgId": org,
        "occurredAt": "2026-09-01T10:00:00.000Z",
        "taskId": task or str(uuid.uuid4()),
        "assigneeId": assignee,
        "senderId": BOB,
        "statusVersion": version,
        **extra,
    }


async def open_pins(org: str, assignee: str) -> list[dict]:
    """Read through RLS exactly as a request handler would."""
    async with session() as db:
        await set_org_context(db, org)
        rows = (
            await db.execute(
                text(
                    "SELECT task_id, status, assignee_status, close_reason, "
                    "       last_delivered_at, delivery_attempts "
                    "  FROM sticky_pins WHERE assignee_id = :me AND status = 'OPEN'"
                ),
                {"me": assignee},
            )
        ).all()
    return [dict(r._mapping) for r in rows]


class TestAssignmentSticksUntilTerminal:
    async def test_an_assignment_opens_a_pin(self, db_app):
        task = str(uuid.uuid4())
        await consumer.handle(event("task.assigned", task=task))
        pins = await open_pins(ORG_A, ALICE)
        assert [str(p["task_id"]) for p in pins] == [task]
        assert pins[0]["assignee_status"] == "SENT"

    async def test_acknowledging_keeps_it_open(self, db_app):
        task = str(uuid.uuid4())
        await consumer.handle(event("task.assigned", task=task))
        await consumer.handle(event("task.acknowledged", task=task, version=1))
        pins = await open_pins(ORG_A, ALICE)
        assert len(pins) == 1
        assert pins[0]["assignee_status"] == "ACKNOWLEDGED"

    @pytest.mark.parametrize(
        ("kind", "reason"),
        [
            ("task.completed", "COMPLETED"),
            ("task.ignored", "IGNORED"),
            ("task.left", "LEFT"),
        ],
    )
    async def test_a_terminal_status_closes_it(self, db_app, kind, reason):
        task = str(uuid.uuid4())
        await consumer.handle(event("task.assigned", task=task))
        await consumer.handle(event(kind, task=task, version=2))
        assert await open_pins(ORG_A, ALICE) == []

        async with session() as db:
            await set_org_context(db, ORG_A)
            row = (
                await db.execute(
                    text("SELECT status, close_reason, closed_at FROM sticky_pins "
                         " WHERE task_id = :t"),
                    {"t": task},
                )
            ).first()
        assert row.status == "CLOSED"
        assert row.close_reason == reason
        assert row.closed_at is not None


class TestRedeliveryIsSafeInSQLToo:
    async def test_the_same_event_twice_changes_nothing(self, db_app):
        task = str(uuid.uuid4())
        e = event("task.assigned", task=task)
        await consumer.handle(e)
        await consumer.handle(e)  # identical eventId — the dedup claim catches it
        assert len(await open_pins(ORG_A, ALICE)) == 1

    async def test_a_stale_event_cannot_resurrect_a_completed_task(self, db_app):
        # The one that would put a note back on someone's desktop for work they
        # have already finished.
        task = str(uuid.uuid4())
        await consumer.handle(event("task.assigned", task=task))
        await consumer.handle(event("task.completed", task=task, version=5))
        await consumer.handle(event("task.acknowledged", task=task, version=2))
        assert await open_pins(ORG_A, ALICE) == []

    async def test_reassignment_reopens_and_resets_delivery(self, db_app):
        task = str(uuid.uuid4())
        await consumer.handle(event("task.assigned", task=task))
        await consumer.handle(event("task.completed", task=task, version=3))
        await consumer.handle(event("task.assigned", task=task, version=0))
        pins = await open_pins(ORG_A, ALICE)
        assert len(pins) == 1
        # A reopened pin has never been delivered in its new life, so the
        # watchdog has to be able to see it again.
        assert pins[0]["last_delivered_at"] is None
        assert pins[0]["delivery_attempts"] == 0


class TestOrgIsolation:
    async def test_one_org_cannot_see_another_orgs_pins(self, db_app):
        await consumer.handle(event("task.assigned", org=ORG_A, assignee=ALICE))
        await consumer.handle(event("task.assigned", org=ORG_B, assignee=ALICE))
        assert len(await open_pins(ORG_A, ALICE)) == 1
        assert len(await open_pins(ORG_B, ALICE)) == 1

    async def test_a_session_with_no_org_context_reads_nothing(self, db_app):
        # RLS fails CLOSED: a handler that forgets set_org_context returns zero
        # rows rather than every org's pins.
        await consumer.handle(event("task.assigned"))
        async with session() as db:
            rows = (await db.execute(text("SELECT task_id FROM sticky_pins"))).all()
        assert rows == []


class TestDeliveryTracking:
    async def test_an_undelivered_pin_is_claimed_and_counted(self, db_app):
        task = str(uuid.uuid4())
        await consumer.handle(event("task.assigned", task=task))

        async def claim():
            async with session() as db:
                await set_bypass_rls(db)
                rows = (
                    await db.execute(
                        text(
                            "UPDATE sticky_pins SET delivery_attempts = delivery_attempts + 1 "
                            " WHERE (org_id, assignee_id, task_id) IN ("
                            "   SELECT org_id, assignee_id, task_id FROM sticky_pins"
                            "    WHERE status = 'OPEN' AND last_delivered_at IS NULL"
                            "      AND opened_at < now() - make_interval(secs => :age)"
                            "    ORDER BY opened_at ASC LIMIT :limit FOR UPDATE SKIP LOCKED) "
                            " RETURNING task_id, delivery_attempts"
                        ),
                        {"age": 0, "limit": 10},
                    )
                ).all()
                await db.commit()
            return rows

        first = await claim()
        assert [str(r.task_id) for r in first] == [task]
        assert first[0].delivery_attempts == 1

        # Claiming increments, so a second sweep can tell a repeatedly-nudged
        # pin from a fresh one and back off.
        second = await claim()
        assert second[0].delivery_attempts == 2

    async def test_acknowledging_delivery_takes_it_out_of_the_sweep(self, db_app):
        task = str(uuid.uuid4())
        await consumer.handle(event("task.assigned", task=task))
        async with session() as db:
            await set_org_context(db, ORG_A)
            await db.execute(
                text(
                    "UPDATE sticky_pins SET last_delivered_at = now() "
                    " WHERE assignee_id = :me AND task_id = :t AND status = 'OPEN'"
                ),
                {"me": ALICE, "t": task},
            )
            await db.commit()

        async with session() as db:
            await set_bypass_rls(db)
            rows = (
                await db.execute(
                    text(
                        "SELECT task_id FROM sticky_pins "
                        " WHERE status = 'OPEN' AND last_delivered_at IS NULL"
                    )
                )
            ).all()
        assert rows == []
