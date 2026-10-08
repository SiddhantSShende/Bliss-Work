"""An oversized outbox row is quarantined, not left to wedge the queue.

Two bugs made the quarantine a no-op on a real database (mocked-connection unit
tests could not see either):

  * `quarantine_oversize` bound a Python int to a Postgres-inferred TEXT
    parameter, which asyncpg rejects — so the quarantine UPDATE always raised.
  * The poller ran that UPDATE on a SECOND connection while its own transaction
    still held FOR UPDATE on the rows, so it waited on itself until the 30 s
    statement_timeout.

Real Postgres; only the Kafka producer (an external system) is a stand-in.
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from sqlalchemy import text

from app.outbox import OutboxPoller
from app.outbox_dlq import MAX_PUBLISH_BYTES

pytestmark = pytest.mark.integration


class _Producer:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_and_wait(self, topic, *, value, key, headers=None):
        self.sent.append(key)


@pytest.fixture
def poller(monkeypatch: pytest.MonkeyPatch) -> tuple[OutboxPoller, _Producer]:
    producer = _Producer()
    p = OutboxPoller()

    async def _ensure() -> _Producer:
        return producer

    monkeypatch.setattr(p, "_ensure_producer", _ensure)
    return p, producer


async def _seed(rows: list[tuple[str, dict]]) -> None:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(text("DELETE FROM outbox"))
        for offset, (key, payload) in enumerate(rows):
            await conn.execute(
                text(
                    "INSERT INTO outbox (id, topic, kafka_key, payload, created_at) "
                    "VALUES (:id, 'tasks', :key, CAST(:payload AS jsonb), now() + make_interval(secs => :off))"
                ),
                {"id": str(uuid.uuid4()), "key": key, "payload": json.dumps(payload), "off": offset},
            )


async def _state() -> dict[str, tuple[bool, bool, str | None]]:
    """key -> (published, dead_lettered, publish_error)."""
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        rows = await conn.execute(
            text(
                "SELECT kafka_key, published_at IS NOT NULL AS published, "
                "       dead_lettered_at IS NOT NULL AS dead, publish_error FROM outbox"
            )
        )
        return {r.kafka_key: (r.published, r.dead, r.publish_error) for r in rows}


_HUGE = {"blob": "x" * (MAX_PUBLISH_BYTES + 10)}


async def test_oversize_row_is_quarantined_and_the_healthy_rows_around_it_still_publish(db_app, poller):
    p, producer = poller
    await _seed([("healthy-1", {"n": 1}), ("huge", _HUGE), ("healthy-2", {"n": 2})])

    # wait_for: the pre-fix deadlock hung until the 30 s statement_timeout.
    published = await asyncio.wait_for(p._drain_once(), timeout=10)

    assert published == 2
    assert producer.sent == ["healthy-1", "healthy-2"]
    state = await _state()
    assert state["huge"][:2] == (False, True)
    assert f"exceeds the {MAX_PUBLISH_BYTES} byte publish limit" in state["huge"][2]
    assert state["healthy-1"][:2] == (True, False) and state["healthy-2"][:2] == (True, False)


async def test_a_batch_of_only_oversize_rows_is_still_quarantined(db_app, poller):
    p, producer = poller
    await _seed([("huge-1", _HUGE), ("huge-2", _HUGE)])

    assert await asyncio.wait_for(p._drain_once(), timeout=10) == 0

    state = await _state()
    assert state["huge-1"][:2] == (False, True) and state["huge-2"][:2] == (False, True)
    assert producer.sent == []
    # The queue has moved: nothing is left to claim.
    assert await asyncio.wait_for(p._drain_once(), timeout=10) == 0
