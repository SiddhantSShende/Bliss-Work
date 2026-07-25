"""Outbox event emission for the live hub.

integration.activity.created is a signal-only event (no PII) written to the same
`outbox` the poller drains → Kafka `integration.events.v1` → ws-gateway routes it
to the recipient's live socket → the client refetches the hub feed.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import uuid6
from sqlalchemy import text

TOPIC = "integration.events.v1"


def _now_iso() -> str:
    # zod .datetime() wants a trailing Z, not a +00:00 offset.
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


async def emit_activity_created(
    db,
    *,
    org_id: str,
    recipient_id: str | None,
    activity_id: str,
    connection_id: str,
    provider: str,
    kind: str,
    direction: str,
) -> None:
    """Enqueue an integration.activity.created event in the outbox (same tx as the
    provider_activity write). No-op when there is no user to notify."""
    if not recipient_id:
        return
    evt = {
        "type": "integration.activity.created",
        "eventId": str(uuid6.uuid7()),
        "orgId": org_id,
        "occurredAt": _now_iso(),
        "recipientId": str(recipient_id),
        "activityId": activity_id,
        "connectionId": connection_id,
        "provider": provider,
        "kind": kind,
        "direction": direction,
    }
    await db.execute(
        text(
            "INSERT INTO outbox (id, topic, kafka_key, payload) "
            "VALUES (:id, :t, :k, CAST(:p AS jsonb))"
        ),
        {"id": str(uuid6.uuid7()), "t": TOPIC, "k": str(recipient_id), "p": json.dumps(evt)},
    )
