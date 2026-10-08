"""An oversized outbox row is quarantined on a real database (B-SH-1).

`quarantine_oversize` bound a Python int to a Postgres-inferred TEXT parameter,
which asyncpg rejects, so the UPDATE raised on every tick and the oversized row
blocked the whole outbox. The shared helper's unit tests mock the connection and
could not see it.

Real Postgres; only the Kafka producer (an external system) is a stand-in.
"""
from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import text

from app.events import poller as poller_module
from app.events.poller import OutboxPoller
from app.events.outbox_dlq import MAX_PUBLISH_BYTES

pytestmark = pytest.mark.integration


class _Producer:
    def __init__(self) -> None:
        self.sent: list[bytes] = []

    async def send_and_wait(self, topic, *, key, value, headers=None):
        self.sent.append(key)


async def test_oversize_row_is_quarantined_and_the_healthy_row_publishes(sa_engine, monkeypatch):
    monkeypatch.setattr(poller_module, "engine", sa_engine)
    producer = _Producer()
    p = OutboxPoller()

    async def _ensure() -> _Producer:
        return producer

    monkeypatch.setattr(p, "_ensure_producer", _ensure)

    payloads = {"healthy": {"n": 1}, "huge": {"blob": "x" * (MAX_PUBLISH_BYTES + 10)}}
    async with sa_engine.begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(text("DELETE FROM outbox"))
        for off, (key, payload) in enumerate(payloads.items()):
            await conn.execute(
                text(
                    "INSERT INTO outbox (id, topic, kafka_key, payload, created_at) "
                    "VALUES (:id, 'auth.events', :key, CAST(:payload AS jsonb), "
                    "        now() + make_interval(secs => :off))"
                ),
                {"id": str(uuid.uuid4()), "key": key, "payload": json.dumps(payload), "off": off},
            )

    await p._drain_once()  # noqa: SLF001

    assert producer.sent == [b"healthy"]
    async with sa_engine.begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        rows = {
            r.kafka_key: r
            for r in await conn.execute(
                text(
                    "SELECT kafka_key, published_at IS NOT NULL AS published, "
                    "       dead_lettered_at IS NOT NULL AS dead, publish_error FROM outbox"
                )
            )
        }
    assert (rows["huge"].published, rows["huge"].dead) == (False, True)
    assert f"exceeds the {MAX_PUBLISH_BYTES} byte publish limit" in rows["huge"].publish_error
    assert (rows["healthy"].published, rows["healthy"].dead) == (True, False)
