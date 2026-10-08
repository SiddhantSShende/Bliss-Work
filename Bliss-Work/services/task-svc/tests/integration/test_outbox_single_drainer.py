"""Two replicas must not drain the outbox at the same time (B-AUTH-16).

`FOR UPDATE SKIP LOCKED` hands a second replica a DIFFERENT batch while the
first is still sending. Replica B then publishes the NEWER rows of a key while
replica A is still sending (or retrying) that key's older ones, so a consumer
can see an event before the one it depends on. The drain therefore takes a
transaction-level advisory lock: one replica drains per cycle, the other skips
it and polls again.

Real Postgres; only the Kafka producer (an external system) is a stand-in.
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from sqlalchemy import text

from app import outbox as outbox_module
from app.outbox import OutboxPoller

pytestmark = pytest.mark.integration

KEY = "one-key"
TOTAL = 150  # > the 100-row batch, so a second drain has something left to claim


class _Producer:
    """Records the global send order. Each send yields to the event loop, which
    is what lets a second, unserialised drain interleave with the first."""

    def __init__(self, fail_first: bool = False) -> None:
        self.sent: list[int] = []
        self._fail_first = fail_first

    async def send_and_wait(self, topic, *, value, key, headers=None):
        await asyncio.sleep(0.002)
        if self._fail_first:
            self._fail_first = False
            raise RuntimeError("broker refused this message")
        self.sent.append(value["n"])


def _poller(monkeypatch: pytest.MonkeyPatch, producer: _Producer) -> OutboxPoller:
    p = OutboxPoller()

    async def _ensure() -> _Producer:
        return producer

    monkeypatch.setattr(p, "_ensure_producer", _ensure)
    return p


async def _seed(count: int) -> None:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(text("DELETE FROM outbox"))  # the table is not reset between tests
        for n in range(count):
            await conn.execute(
                text(
                    "INSERT INTO outbox (id, topic, kafka_key, payload, created_at) "
                    "VALUES (:id, 'tasks', :key, CAST(:payload AS jsonb), "
                    "        now() + make_interval(secs => :off))"
                ),
                {"id": str(uuid.uuid4()), "key": KEY, "payload": json.dumps({"n": n}), "off": n},
            )


async def test_concurrent_drains_publish_one_batch_in_order(db_app, monkeypatch):
    await _seed(TOTAL)
    producer = _Producer()
    a, b = _poller(monkeypatch, producer), _poller(monkeypatch, producer)

    results = await asyncio.gather(a._drain_once(), b._drain_once())

    assert sorted(results) == [0, 100], "exactly one replica may drain per cycle"
    assert producer.sent == list(range(100)), "the batch must be published in order"

    # The skipped replica loses nothing: the next cycle takes the rest, after it.
    assert await b._drain_once() == TOTAL - 100
    assert producer.sent == list(range(TOTAL))


async def test_a_drain_skips_while_another_session_holds_the_lock(db_app, monkeypatch):
    await _seed(3)
    producer = _Producer()
    p = _poller(monkeypatch, producer)
    from app.db import get_engine

    async with get_engine().connect() as holder:
        got = await holder.execute(
            text("SELECT pg_try_advisory_xact_lock(hashtext(:k)::bigint)"),
            {"k": outbox_module._DRAIN_LOCK_KEY},
        )
        assert got.scalar_one() is True
        assert await p._drain_once() == 0
        assert producer.sent == []
        await holder.rollback()  # transaction end releases the lock

    assert await p._drain_once() == 3
    assert producer.sent == [0, 1, 2]


async def test_the_lock_is_released_after_a_failed_publish(db_app, monkeypatch):
    await _seed(3)
    producer = _Producer(fail_first=True)
    a, b = _poller(monkeypatch, producer), _poller(monkeypatch, producer)

    with pytest.raises(RuntimeError):
        await a._drain_once()

    # Another replica can drain straight away, and starts at the oldest row.
    assert await b._drain_once() == 3
    assert producer.sent == [0, 1, 2]
