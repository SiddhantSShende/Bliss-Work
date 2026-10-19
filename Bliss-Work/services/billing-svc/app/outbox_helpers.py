"""Transactional-outbox write helper — mirrors task-svc/app/routes/helpers.py.
No poller/Kafka producer exists yet in billing-svc (phase 2 has nothing to
publish to that any consumer reads), so rows just accumulate in `outbox` as
an audit trail until a later phase adds the poller."""
from __future__ import annotations

import json

import uuid6
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def enqueue_outbox(db: AsyncSession, topic: str, key: str, payload: dict) -> None:
    await db.execute(
        text(
            "INSERT INTO outbox (id, topic, kafka_key, payload) "
            "VALUES (:id, :topic, :key, CAST(:payload AS jsonb))"
        ),
        {"id": str(uuid6.uuid7()), "topic": topic, "key": key, "payload": json.dumps(payload)},
    )
