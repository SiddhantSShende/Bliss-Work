"""Transactional outbox: build canonical events and enqueue within a tx."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import uuid6
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

# Canonical Kafka topics (must match the event contract EXACTLY).
TOPIC_AUTH = "auth.events"  # key = userId

# Event types whose payload carries a raw single-use secret (password-reset /
# email-verify / invite URL). The outbox poller strips that secret before
# publishing these to Kafka, and the internal outbox-events endpoint uses the
# same allow-list to restrict which rows it will ever hand back — see
# docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 3.
SECRET_EVENT_TYPES = frozenset(
    {"password.reset.requested", "email.verification.requested", "invite.created"}
)


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
