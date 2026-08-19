"""The single write path into activity_events, shared by every producer.

Everything that records activity — the Kafka consumer, the client beacon, the
desktop sampler, the browser extension — funnels through `insert_events`, so the
clock clamp, the encryption of the sensitive detail, and the missing-partition
recovery are written once and cannot drift between callers.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import uuid6
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .crypto import cryptor
from .logging_setup import log

# Actions that are liveness signals, not activity, and are never stored.
#
# A heartbeat says "this client is still open". The beacon carrying it has
# ALREADY advanced the session's last_seen_at and banked its active/idle time,
# which is where "still here" is actually recorded — so the row added nothing a
# reader could use, while arriving once a minute per open client. On the
# timeline that buried the events that do mean something under a wall of
# identical entries, and in the table it was the single largest contributor to
# a 90-day partition set.
#
# Dropped here, in the shared write path, rather than in the beacon handler:
# desktop builds and cached browser bundles keep sending heartbeats for as long
# as they are installed, and this is the one place no producer can bypass.
NON_EVENT_ACTIONS = frozenset({"heartbeat"})


@dataclass
class ActivityRow:
    org_id: str
    user_id: str
    occurred_at: datetime
    source: str
    category: str
    action: str
    session_id: str | None = None
    surface: str | None = None
    target_kind: str | None = None
    target_id: str | None = None
    duration_ms: int | None = None
    # Free-form, encrypted at rest under the org DEK. Holds the parts that are
    # revealing rather than aggregatable: a message preview, a URL path, a window
    # title. Never anything an aggregate needs to GROUP BY.
    detail: dict[str, object] = field(default_factory=dict)


def clamp_occurred_at(raw: datetime | None, now: datetime | None = None) -> datetime:
    """Bound a client-supplied timestamp to a plausible window.

    A device with a wrong clock is common and mostly harmless — but unbounded it
    can write into a partition that was dropped last month or does not exist for
    another year, and it can bury today's real activity in 1970. Clamping keeps
    every row landing somewhere real; `received_at` is stored alongside so the
    original discrepancy is still visible during an investigation.
    """
    now = now or datetime.now(timezone.utc)
    if raw is None:
        return now
    if raw.tzinfo is None:
        raw = raw.replace(tzinfo=timezone.utc)
    earliest = now - timedelta(seconds=settings.max_clock_backdate_seconds)
    latest = now + timedelta(seconds=settings.max_clock_skew_future_seconds)
    return min(max(raw, earliest), latest)


_INSERT = text(
    """
    INSERT INTO activity_events (
        id, org_id, user_id, session_id, occurred_at, source, category, action,
        surface, target_kind, target_id, duration_ms, detail_enc
    ) VALUES (
        :id, :org, :uid, :sid, :at, :source, :category, :action,
        :surface, :target_kind, :target_id, :duration_ms, :detail
    )
    """
)


async def insert_events(db: AsyncSession, rows: list[ActivityRow]) -> int:
    """Insert a batch. Returns the number written, which is not necessarily the
    number offered — see NON_EVENT_ACTIONS.

    The caller owns the transaction and MUST have set the RLS context first —
    `set_org_context` for a request, `set_bypass_rls` for the cross-org consumer.
    """
    rows = [r for r in rows if r.action not in NON_EVENT_ACTIONS]
    if not rows:
        return 0
    params = [await _params(db, r) for r in rows]
    try:
        # SAVEPOINT, not a plain execute. A failed statement poisons the whole
        # transaction, and rolling the transaction back to recover would also
        # discard what the CALLER put there first — the transaction-local RLS
        # GUC, and (for the Kafka consumer) the consumed_events row that is the
        # only thing stopping the event being processed twice. A savepoint undoes
        # the insert and nothing else.
        async with db.begin_nested():
            await db.execute(_INSERT, params)
    except DBAPIError as exc:
        if not _is_missing_partition(exc):
            raise
        # A batch straddling midnight, or a first write after the service has
        # been down longer than the pre-created window, can arrive before a
        # partition exists for that day. Create them and retry ONCE.
        # Deliberately not a loop: a second failure means something other than a
        # missing day, and retrying that forever would spin.
        log.warning("activity_partition_missing", rows=len(rows))
        await db.execute(
            text("SELECT ensure_activity_partitions(:d)"),
            {"d": settings.partition_days_ahead},
        )
        await db.execute(_INSERT, params)
    return len(rows)


async def _params(db: AsyncSession, r: ActivityRow) -> dict[str, object]:
    detail_enc = None
    if r.detail:
        detail_enc = await cryptor().encrypt(
            db, r.org_id, json.dumps(r.detail, separators=(",", ":"), sort_keys=True)
        )
    return {
        "id": str(uuid6.uuid7()),
        "org": r.org_id,
        "uid": r.user_id,
        "sid": r.session_id,
        "at": r.occurred_at,
        "source": r.source,
        "category": r.category,
        "action": r.action,
        "surface": r.surface,
        "target_kind": r.target_kind,
        "target_id": r.target_id,
        "duration_ms": r.duration_ms,
        "detail": detail_enc,
    }


def _is_missing_partition(exc: BaseException) -> bool:
    """Postgres 23514 check_violation, message 'no partition of relation ...'.

    Matched on the message rather than only the SQLSTATE because 23514 is also a
    plain CHECK violation, and blanket-retrying those would hide real bugs.
    """
    return "no partition of relation" in str(getattr(exc, "orig", exc)).lower()
