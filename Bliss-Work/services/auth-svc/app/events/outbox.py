"""Transactional outbox: build canonical events and enqueue within a tx."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import uuid6
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

# Canonical Kafka topics (must match the event contract EXACTLY).
TOPIC_AUTH = "auth.events"  # key = userId


def _now_iso_z() -> str:
    """ISO-8601 UTC with explicit 'Z' suffix."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def build_event(event_type: str, org_id: str, **payload: Any) -> dict[str, Any]:
    """Compute the FULL canonical event JSON (envelope + payload)."""
    event: dict[str, Any] = {
        "eventId": str(uuid6.uuid7()),
        "orgId": org_id,
        "occurredAt": _now_iso_z(),
        "type": event_type,
    }
    for k, v in payload.items():
        if v is not None:
            event[k] = v
    return event


async def enqueue_event(
    conn: AsyncConnection,
    *,
    topic: str,
    kafka_key: str,
    event: dict[str, Any],
) -> None:
    """Insert an outbox row in the SAME transaction as the state change."""
    import json

    await conn.execute(
        text(
            """
            INSERT INTO outbox (id, topic, kafka_key, payload)
            VALUES (:id, :topic, :kafka_key, CAST(:payload AS jsonb))
            """
        ),
        {
            "id": str(uuid6.uuid7()),
            "topic": topic,
            "kafka_key": kafka_key,
            "payload": json.dumps(event),
        },
    )
