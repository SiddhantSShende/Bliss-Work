"""Two replicas must not drain the outbox at the same time (B-AUTH-16).

`FOR UPDATE SKIP LOCKED` hands a second replica a DIFFERENT batch while the
first is still sending. Replica B then publishes the NEWER rows of a key while
replica A is still sending (or retrying) that key's older ones, so a consumer
can see `user.removed` before `user.created`. The drain therefore takes a
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

from app.events import poller as poller_module
from app.events.poller import OutboxPoller

pytestmark = pytest.mark.integration

KEY = "one-key"
TOTAL = 150  # > the 100-row batch, so a second drain has something left to claim


class _Producer:
    """Records the global send order. Each send yields to the event loop, which
    is what lets a second, unserialised drain interleave with the first."""

    def __init__(self, fail_first: bool = False) -> None:
        self.sent: list[int] = []
        self._fail_first = fail_first

    async def send_and_wait(self, topic, *, key, value, headers=None):
        await asyncio.sleep(0.002)
        if self._fail_first:
            self._fail_first = False
            raise RuntimeError("broker refused this message")
        self.sent.append(json.loads(value)["n"])


@pytest.fixture
def make_poller(monkeypatch: pytest.MonkeyPatch, sa_engine):
    # The poller imports the service's module-level engine; point it at the
    # scratch database (least-privilege role) the integration suite provides.
    monkeypatch.setattr(poller_module, "engine", sa_engine)

    def _make(producer: _Producer) -> OutboxPoller:
        p = OutboxPoller()

        async def _ensure() -> _Producer:
            return producer

        monkeypatch.setattr(p, "_ensure_producer", _ensure)
        return p

    return _make


async def _seed(sa_engine, count: int) -> None:
    async with sa_engine.begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(text("DELETE FROM outbox"))
        for n in range(count):
            await conn.execute(
                text(
                    "INSERT INTO outbox (id, topic, kafka_key, payload, created_at) "
                    "VALUES (:id, 'auth.events', :key, CAST(:payload AS jsonb), "
                    "        now() + make_interval(secs => :off))"
                ),
                {"id": str(uuid.uuid4()), "key": KEY, "payload": json.dumps({"n": n}), "off": n},
            )


async def test_concurrent_drains_publish_one_batch_in_order(sa_engine, make_poller):
    await _seed(sa_engine, TOTAL)
    producer = _Producer()
    a, b = make_poller(producer), make_poller(producer)

    await asyncio.gather(a._drain_once(), b._drain_once())  # noqa: SLF001

    assert producer.sent == list(range(100)), (
        "exactly one replica may drain per cycle, and its batch must be in order"
    )

    # The skipped replica loses nothing: the next cycle takes the rest, after it.
    await b._drain_once()  # noqa: SLF001
    assert producer.sent == list(range(TOTAL))


async def test_a_drain_skips_while_another_session_holds_the_lock(sa_engine, make_poller):
    await _seed(sa_engine, 3)
    producer = _Producer()
    p = make_poller(producer)

    async with sa_engine.connect() as holder:
        got = await holder.execute(
            text("SELECT pg_try_advisory_xact_lock(hashtext(:k)::bigint)"),
            {"k": poller_module.DRAIN_LOCK_KEY},
        )
        assert got.scalar_one() is True
        await p._drain_once()  # noqa: SLF001
        assert producer.sent == []
        await holder.rollback()  # transaction end releases the lock

    await p._drain_once()  # noqa: SLF001
    assert producer.sent == [0, 1, 2]


async def test_the_lock_is_released_after_a_failed_publish(sa_engine, make_poller):
    await _seed(sa_engine, 3)
    producer = _Producer(fail_first=True)
    a, b = make_poller(producer), make_poller(producer)

    with pytest.raises(RuntimeError):
        await a._drain_once()  # noqa: SLF001

    # Another replica can drain straight away, and starts at the oldest row.
    await b._drain_once()  # noqa: SLF001
    assert producer.sent == [0, 1, 2]
