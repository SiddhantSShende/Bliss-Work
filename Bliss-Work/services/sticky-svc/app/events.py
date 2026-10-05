"""Events this service PRODUCES.

Everything else here is a consumer; this is the one outbound event. It rides the
topic ws-gateway already fans out from, so no second realtime transport exists.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import uuid6
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

#: ws-gateway consumes this topic and routes by event type. The type string must
#: stay in lockstep with services/ws-gateway/internal/contract/contract.go,
#: packages/shared/src/types/event-routing-spec.ts and
#: packages/shared/src/types/events.ts — a frame whose type any of them does not
#: know is dropped on arrival.
TASK_TOPIC = "task.events.v1"
PIN_CHANGED = "sticky.pin.changed"


def _now_iso_z() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def pin_changed(*, org_id: str, assignee_id: str, task_id: str, pin_state: str) -> dict:
    """`pinState` is the state the pin is in AFTER the change (PINNED | UNPINNED).

    Carries ids and the new state only — no task content (titles are encrypted
    in task-svc and have no business on this channel). `assigneeId` is the user
    whose pin changed, which is also who ws-gateway delivers it to: every
    device of that one user, and nobody else.
    """
    return {
        "type": PIN_CHANGED,
        "eventId": str(uuid6.uuid7()),
        "orgId": org_id,
        "occurredAt": _now_iso_z(),
        "assigneeId": assignee_id,
        "taskId": task_id,
        "pinState": pin_state,
    }


async def enqueue(db: AsyncSession, event: dict, *, key: str) -> None:
    """Write `event` to the outbox inside the caller's transaction.

    Keyed by the assignee so one person's pin changes stay ordered on a single
    partition: a Pin followed by an Unpin can never be delivered the other way
    round.
    """
    await db.execute(
        text(
            "INSERT INTO outbox (id, topic, kafka_key, payload) "
            "VALUES (:id, :topic, :key, CAST(:payload AS jsonb))"
        ),
        {
            "id": str(uuid6.uuid7()),
            "topic": TASK_TOPIC,
            "key": key,
            "payload": json.dumps(event),
        },
    )
