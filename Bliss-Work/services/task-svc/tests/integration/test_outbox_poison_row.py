"""A poison outbox row must not cost the healthy rows behind it their delivery.

The poller claims a batch ordered by created_at and stops at the first row the
broker refuses (to keep per-key ordering). It then charged the failed attempt to
that row AND every row behind it in the batch — rows it never tried to send. So one
poison row at the head made the whole batch's attempt counters climb together, and
after MAX_PUBLISH_ATTEMPTS ticks every row in it was dead-lettered at once: healthy
events set aside, undelivered, along with the bad one.

Real Postgres; only the Kafka producer (an external system) is a stand-in.
"""

from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import text

from app.outbox import OutboxPoller
from app.outbox_dlq import MAX_PUBLISH_ATTEMPTS

pytestmark = pytest.mark.integration

POISON_KEY = "poison"


class _Producer:
    """Refuses the poison key, accepts everything else, records what it accepted."""

    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_and_wait(self, topic, *, value, key, headers=None):
        if key == POISON_KEY:
            raise RuntimeError("broker refused this message")
        self.sent.append(key)


@pytest.fixture
def poller(monkeypatch: pytest.MonkeyPatch) -> tuple[OutboxPoller, _Producer]:
    producer = _Producer()
    p = OutboxPoller()

    async def _ensure() -> _Producer:
        return producer

    monkeypatch.setattr(p, "_ensure_producer", _ensure)
    return p, producer


async def _seed_batch(keys: list[str]) -> list[str]:
    """Insert one outbox row per key, oldest first. Returns the row ids in order."""
    from app.db import get_engine

    ids = [str(uuid.uuid4()) for _ in keys]
    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(text("DELETE FROM outbox"))  # the table is not reset between tests
        for offset, (row_id, key) in enumerate(zip(ids, keys)):
            await conn.execute(
                text(
                    "INSERT INTO outbox (id, topic, kafka_key, payload, created_at) "
                    "VALUES (:id, 'tasks', :key, CAST(:payload AS jsonb), now() + make_interval(secs => :off))"
                ),
                {"id": row_id, "key": key, "payload": json.dumps({"n": offset}), "off": offset},
            )
    return ids


async def _state() -> dict[str, tuple[int, bool, bool]]:
    """key -> (publish_attempts, published, dead_lettered)."""
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        rows = await conn.execute(
            text(
                "SELECT kafka_key, publish_attempts, published_at IS NOT NULL AS published, "
                "       dead_lettered_at IS NOT NULL AS dead FROM outbox"
            )
        )
        return {r.kafka_key: (r.publish_attempts, r.published, r.dead) for r in rows}


async def test_a_failed_send_is_charged_to_the_row_that_failed_and_no_other(db_app, poller):
    p, _ = poller
    await _seed_batch([POISON_KEY, "healthy-1", "healthy-2", "healthy-3"])

    with pytest.raises(RuntimeError):
        await p._drain_once()

    state = await _state()
    assert state[POISON_KEY][0] == 1
    for key in ("healthy-1", "healthy-2", "healthy-3"):
        assert state[key] == (0, False, False), f"{key} was never offered to the broker yet was charged an attempt"


async def test_dead_lettering_the_poison_row_leaves_the_rows_behind_it_deliverable(db_app, poller):
    p, producer = poller
    await _seed_batch([POISON_KEY, "healthy-1", "healthy-2"])
    from app.db import get_engine

    async with get_engine().begin() as conn:  # one failure away from being set aside
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text("UPDATE outbox SET publish_attempts = :n WHERE kafka_key = :k"),
            {"n": MAX_PUBLISH_ATTEMPTS - 1, "k": POISON_KEY},
        )

    with pytest.raises(RuntimeError):
        await p._drain_once()  # sets the poison row aside
    await p._drain_once()  # the queue now moves

    state = await _state()
    assert state[POISON_KEY][2] is True
    assert producer.sent == ["healthy-1", "healthy-2"]
    assert state["healthy-1"] == (0, True, False) and state["healthy-2"] == (0, True, False)
