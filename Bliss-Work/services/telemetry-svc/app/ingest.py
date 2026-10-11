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

import uuid

import uuid6
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from crypto import cryptor
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


# ── The security record of a file being opened or downloaded ─────────────────
#
# A chat or channel file open/download is reported by the client as an
# ENGAGEMENT event (`attachment.opened` / `attachment.downloaded`), which is what
# the activity timeline and analytics read. The Security view needs the same act
# as a record of its own, so the SERVER derives one at ingest — a separate row,
# category 'security', same actor, time, session (so the IP / device / platform
# the session already records), target and detail (file name, chat or channel).
#
# Derived here rather than sent by the client for three reasons: it is exactly
# one per act (a client that "forgets" the second event, or sends it twice,
# cannot make the two records disagree); a retry is a no-op for both rows (the
# derived id is a function of the base id, so the same claim table dedupes it);
# and the client is not allowed to submit these actions at all (see
# `SECURITY_MIRROR_ACTIONS` in routes/ingest.py), so a row carrying one was
# necessarily produced from a real attachment.opened/downloaded report.
FILE_SECURITY_ACTIONS: dict[str, str] = {
    "attachment.opened": "file.opened",
    "attachment.downloaded": "file.downloaded",
}
SECURITY_MIRROR_ACTIONS = frozenset(FILE_SECURITY_ACTIONS.values())
# Any fixed value works; it only has to be stable across processes and releases,
# because retries of a base event must always derive the SAME mirror id.
_MIRROR_NAMESPACE = uuid.UUID("6f1f5a0e-3b1c-4c52-9a55-5f1f0a7c1b01")


def security_mirror_of(row: "ActivityRow") -> "ActivityRow | None":
    """The security row for a file-activity row, or None for any other row."""
    action = FILE_SECURITY_ACTIONS.get(row.action)
    if action is None:
        return None
    return ActivityRow(
        org_id=row.org_id,
        user_id=row.user_id,
        session_id=row.session_id,
        occurred_at=row.occurred_at,
        source=row.source,
        category="security",
        action=action,
        surface=row.surface,
        target_kind=row.target_kind,
        target_id=row.target_id,
        detail=dict(row.detail),
        client_event_id=(
            str(uuid.uuid5(_MIRROR_NAMESPACE, row.client_event_id)) if row.client_event_id else None
        ),
    )


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
    # Client-generated, preserved across a retry (never regenerated when a
    # batch is re-queued after a lost response) — see migration 0006 for why
    # this is what makes a retried event a no-op instead of a duplicate row.
    # None for server-observed rows (the Kafka consumer has its own,
    # independent dedup via consumed_events) and for any client old enough not
    # to send one yet.
    client_event_id: str | None = None


@dataclass
class InsertedRow:
    """One row as it actually landed: the server-generated id, paired with the
    ActivityRow the caller offered. See `insert_events`."""

    id: str
    row: ActivityRow


def clamp_occurred_at(
    raw: datetime | None, now: datetime | None = None, *, source: str | None = None
) -> datetime:
    """Bound a client-supplied timestamp to a plausible window.

    A device with a wrong clock is common and mostly harmless — but unbounded it
    can write into a partition that was dropped last month or does not exist for
    another year, and it can bury today's real activity in 1970. Clamping keeps
    every row landing somewhere real; `received_at` is stored alongside so the
    original discrepancy is still visible during an investigation. Server
    events retain their authoritative event time even when Kafka delivers them
    late; only their future skew is bounded.
    """
    now = now or datetime.now(timezone.utc)
    if raw is None:
        return now
    if raw.tzinfo is None:
        raw = raw.replace(tzinfo=timezone.utc)
    latest = now + timedelta(seconds=settings.max_clock_skew_future_seconds)
    if source == "server":
        return min(raw, latest)
    earliest = now - timedelta(seconds=settings.max_clock_backdate_seconds)
    return min(max(raw, earliest), latest)


_INSERT = text(
    """
    INSERT INTO activity_events (
        id, org_id, user_id, session_id, occurred_at, source, category, action,
        surface, target_kind, target_id, duration_ms, detail_enc, client_event_id
    ) VALUES (
        :id, :org, :uid, :sid, :at, :source, :category, :action,
        :surface, :target_kind, :target_id, :duration_ms, :detail, :client_event_id
    )
    -- See migration 0006: a retried batch resends the same client_event_id
    -- (never regenerated on re-queue), so this makes a retry a no-op instead
    -- of a second row. RETURNING says exactly which ids actually landed, the
    -- same pattern consumer.py's _claim_many already uses for the same reason
    -- — a client_event_id-less row (NULL, e.g. every server-observed row) is
    -- never deduped against another, since the index this targets is scoped
    -- to `WHERE client_event_id IS NOT NULL`.
    ON CONFLICT (org_id, user_id, occurred_at, client_event_id)
    WHERE client_event_id IS NOT NULL
    DO NOTHING
    RETURNING id
    """
)


async def insert_events(db: AsyncSession, rows: list[ActivityRow]) -> list[InsertedRow]:
    """Insert a batch. Returns one entry per row actually written — which is
    not necessarily one per row offered (see NON_EVENT_ACTIONS, and now a
    retried row whose client_event_id was already written) — pairing each with
    the server-generated id it was written under and the ActivityRow it came
    from. A caller that only wanted a count still gets one — `len(result)`.

    The ids exist for sessionizer.py: correlating a desktop app.focus row with
    a browser site.visit row needs to know which activity_events row is which,
    and the id is generated HERE (see `_params`), so a caller cannot know it in
    advance.

    The caller owns the transaction and MUST have set the RLS context first —
    `set_org_context` for a request, `set_bypass_rls` for the cross-org consumer.
    """
    rows = [r for r in rows if r.action not in NON_EVENT_ACTIONS]
    if not rows:
        return []
    rows = await _claim_client_events(db, rows)
    if not rows:
        return []
    params = [await _params(db, r) for r in rows]
    try:
        # SAVEPOINT, not a plain execute. A failed statement poisons the whole
        # transaction, and rolling the transaction back to recover would also
        # discard what the CALLER put there first — the transaction-local RLS
        # GUC, and (for the Kafka consumer) the consumed_events row that is the
        # only thing stopping the event being processed twice. A savepoint undoes
        # the insert and nothing else.
        async with db.begin_nested():
            written_ids = await _execute_insert(db, params)
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
        written_ids = await _execute_insert(db, params)
    return [
        InsertedRow(id=p["id"], row=r)
        for p, r in zip(params, rows)
        if p["id"] in written_ids
    ]


async def _claim_client_events(db: AsyncSession, rows: list[ActivityRow]) -> list[ActivityRow]:
    """Atomically claim client event IDs before writing partitioned event rows.

    The separate claim table makes identity independent of occurred_at, which
    can change between retries when a missing or implausible client timestamp
    is replaced/clamped. The unique key also serializes concurrent replays.
    """
    claimed_rows: list[ActivityRow] = []
    for row in rows:
        if not row.client_event_id:
            claimed_rows.append(row)
            continue
        result = await db.execute(
            text(
                "INSERT INTO client_event_claims (org_id, user_id, client_event_id) "
                "VALUES (:org, :uid, :event_id) "
                "ON CONFLICT DO NOTHING RETURNING client_event_id"
            ),
            {"org": row.org_id, "uid": row.user_id, "event_id": row.client_event_id},
        )
        if result.scalar_one_or_none() is not None:
            claimed_rows.append(row)
    return claimed_rows


async def _execute_insert(db: AsyncSession, params: list[dict[str, object]]) -> set[str]:
    """Run `_INSERT` once per row and collect which ids actually landed.

    Not a single `executemany`-style call with the full params list: SQLAlchemy
    sends a multi-row raw `text()` INSERT as a bare DBAPI `executemany`, which
    — unlike SQLAlchemy Core's `insert()` construct — does not support
    `RETURNING` (asyncpg silently returns a cursor with no row metadata,
    surfacing as `ResourceClosedError` the moment it's read). Confirmed against
    a real Postgres instance before writing this: a 1-row list returns rows
    fine, a 2+-row list does not. Batches are capped at 100 (Beacon.events), so
    a per-row round trip is not a scale concern.
    """
    written: set[str] = set()
    for p in params:
        result = await db.execute(_INSERT, p)
        written.update(str(row[0]) for row in result)
    return written


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
        "client_event_id": r.client_event_id,
    }


def _is_missing_partition(exc: BaseException) -> bool:
    """Postgres 23514 check_violation, message 'no partition of relation ...'.

    Matched on the message rather than only the SQLSTATE because 23514 is also a
    plain CHECK violation, and blanket-retrying those would hide real bugs.
    """
    return "no partition of relation" in str(getattr(exc, "orig", exc)).lower()
