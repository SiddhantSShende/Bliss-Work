"""billing-svc's first outbox poller (app/outbox_poller.py): a minimal
sanity check that it drains in order and that a failed publish leaves the
row unpublished for retry (at-least-once), mirroring
sticky-svc/tests/integration/test_outbox_single_drainer.py. billing-svc has
no RLS (see app/db.py), so unlike that reference there is no bypass-RLS
config to set before seeding.
"""
from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import text

from app.outbox_poller import OutboxPoller

pytestmark = pytest.mark.integration


class _Producer:
    def __init__(self, fail_first: bool = False) -> None:
        self.sent: list[int] = []
        self._fail_first = fail_first

    async def send_and_wait(self, topic, *, value, key, headers=None):
        if self._fail_first:
            self._fail_first = False
            raise RuntimeError("broker refused this message")
        self.sent.append(value["n"])


def _poller(monkeypatch: pytest.MonkeyPatch, producer: _Producer) -> OutboxPoller:
    p = OutboxPoller()

    async def _ensure():
        return producer

    monkeypatch.setattr(p, "_ensure_producer", _ensure)
    return p


async def _seed(count: int) -> None:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        for n in range(count):
            await conn.execute(
                text(
                    "INSERT INTO outbox (id, topic, kafka_key, payload, created_at) "
                    "VALUES (:id, 'billing.events.v1', :key, CAST(:payload AS jsonb), "
                    "        now() + make_interval(secs => :off))"
                ),
                {"id": str(uuid.uuid4()), "key": "k", "payload": json.dumps({"n": n}), "off": n},
            )


@pytest.mark.asyncio
async def test_drain_publishes_in_order_and_marks_published(db_app, monkeypatch):
    await _seed(3)
    producer = _Producer()
    p = _poller(monkeypatch, producer)

    published = await p._drain_once()

    assert published == 3
    assert producer.sent == [0, 1, 2]

    from app.db import session

    async with session() as db:
        count = (
            await db.execute(text("SELECT count(*) FROM outbox WHERE published_at IS NULL"))
        ).scalar()
    assert count == 0


@pytest.mark.asyncio
async def test_failed_publish_leaves_row_unpublished_for_retry(db_app, monkeypatch):
    await _seed(2)
    producer = _Producer(fail_first=True)
    p = _poller(monkeypatch, producer)

    with pytest.raises(RuntimeError):
        await p._drain_once()

    from app.db import session

    async with session() as db:
        unpublished = (
            await db.execute(text("SELECT count(*) FROM outbox WHERE published_at IS NULL"))
        ).scalar()
    # Nothing was sent (the first row failed, breaking the batch), and nothing
    # was marked published — at-least-once: the next drain retries from the
    # same row.
    assert producer.sent == []
    assert unpublished == 2

    # A second drain, now succeeding, publishes everything that was retried.
    republished = await p._drain_once()
    assert republished == 2
    assert producer.sent == [0, 1]
