"""One undeliverable Kafka event must not wedge the consumer (B-TEL-1).

Runs the real `_process_batch` -> `_flush_isolating` -> `_claim_many` ->
`insert_events` path against a real Postgres, because what is being proved is
how Postgres' own rejections are classified: with the asyncpg driver they are a
bare DBAPIError, not SQLAlchemy's DataError, so a mock could not show it.

    TELEMETRY_DATABASE_URL=postgresql://telemetry_user:pw@host/telemetrydb \\
        python -m pytest tests/integration/test_consumer_poison_isolation.py -q
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="module")]

if not os.getenv("TELEMETRY_DATABASE_URL"):
    pytest.skip("needs a live Postgres (TELEMETRY_DATABASE_URL)", allow_module_level=True)

pytest_asyncio = pytest.importorskip("pytest_asyncio")

from sqlalchemy import text  # noqa: E402

from app import consumer  # noqa: E402
from app.db import session, set_bypass_rls  # noqa: E402
from app.main import app  # noqa: E402


class _Msg:
    def __init__(self, value, offset=0):
        self.value = value
        self.offset = offset
        self.topic = "messaging.events.v1"
        self.headers = ()


def _event(org: str, **kw) -> dict:
    base = {
        "eventId": str(uuid.uuid4()),
        "orgId": org,
        "type": "message.created",
        "senderId": str(uuid.uuid4()),
        "conversationId": str(uuid.uuid4()),
        "occurredAt": datetime.now(timezone.utc).isoformat(),
    }
    base.update(kw)
    return base


@pytest_asyncio.fixture(loop_scope="module", scope="module", autouse=True)
async def _lifespan():
    # The app lifespan initialises the engine, migrations and the cryptor the
    # insert path encrypts `detail` with.
    async with app.router.lifespan_context(app):
        yield


async def _count(org: str) -> int:
    async with session() as db:
        await set_bypass_rls(db)
        return (
            await db.execute(
                text("SELECT count(*) FROM activity_events WHERE org_id = :o"), {"o": org}
            )
        ).scalar_one()


async def _run(*events) -> bool:
    batch = {"tp": [_Msg(e, i) for i, e in enumerate(events)]}
    return await consumer.TelemetryConsumer()._process_batch(batch)


async def test_a_non_uuid_org_id_is_skipped_and_neighbours_are_written():
    org = str(uuid.uuid4())

    ok = await _run(_event(org), _event("not-a-uuid"), _event(org))

    assert ok is True, "the poison event must not block the offsets"
    assert await _count(org) == 2


async def test_a_non_uuid_actor_is_skipped_and_neighbours_are_written():
    org = str(uuid.uuid4())

    ok = await _run(_event(org), _event(org, senderId="user-1"), _event(org))

    assert ok is True
    assert await _count(org) == 2


async def test_a_row_the_database_rejects_is_isolated_not_fatal():
    """A NUL byte in a text column passes every id check and is refused by
    Postgres (22021). The healthy rows around it must still be committed."""
    org = str(uuid.uuid4())

    ok = await _run(_event(org), _event(org, conversationId="bad\x00id"), _event(org))

    assert ok is True, "a permanent DB rejection must not rewind the batch forever"
    assert await _count(org) == 2


async def test_a_redelivered_batch_after_isolation_writes_nothing_twice():
    org = str(uuid.uuid4())
    events = [_event(org), _event(org, conversationId="bad\x00id"), _event(org)]

    assert await _run(*events) is True
    assert await _run(*events) is True

    assert await _count(org) == 2


async def test_org_deleted_with_a_non_uuid_org_is_skipped():
    org = str(uuid.uuid4())
    poison = {"eventId": str(uuid.uuid4()), "orgId": "not-a-uuid", "type": "org.deleted"}

    ok = await _run(poison, _event(org))

    assert ok is True
    assert await _count(org) == 1
