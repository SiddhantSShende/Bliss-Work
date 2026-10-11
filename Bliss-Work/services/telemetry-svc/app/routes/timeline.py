"""Per-member timeline, sessions, and the live roster."""
from __future__ import annotations

import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import text

from ..auth import Principal, require_principal
from ..config import settings
from crypto import CryptoError, cryptor
from ..cursor import decode_cursor, encode_cursor
from ..db import session, set_org_context
from ..ingest import NON_EVENT_ACTIONS, SECURITY_MIRROR_ACTIONS
from ..logging_setup import log
from ..schemas import (
    MemberActivityDTO,
    SessionDTO,
    SessionPage,
    TimelineEntry,
    TimelinePage,
)
from .subject import require_admin, resolve_subject

router = APIRouter(prefix="/telemetry", tags=["telemetry"])

# The timeline's "Outside Activity" filter: what the person's desktop saw them do
# OUTSIDE BlissWork. It is a view over stored rows, not a stored category — no
# row carries it, and ingestion is untouched. A single `category` cannot express
# it: `app.focus` is stored as 'app', but the focus/blur/idle readings are
# stored as 'engagement', the same category as sending a message. So the filter
# is the 'app' category plus these stable action verbs (the ones the client's
# activityLabels names: an application in front, switched away from / came back
# to BlissWork, and the in-window and OS-level idle spans).
OUTSIDE_FILTER = "outside"
OUTSIDE_ACTIONS = frozenset({"app.focus", "blur", "focus", "idle.start", "idle.end", "os.idle"})


def iso_z(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


@router.get("/members", response_model=list[MemberActivityDTO])
async def roster(principal: Principal = Depends(require_principal)) -> list[MemberActivityDTO]:
    """Who is here right now, and how much they have worked today.

    Returns user ids only — this service holds no names. The client joins against
    the directory it already caches, which is also what keeps a member who was
    removed from the org out of the roster without this service having to know
    anything about membership.
    """
    require_admin(principal)
    async with session() as db:
        await set_org_context(db, principal.org_id)
        rows = (
            await db.execute(
                text(
                    """
                    SELECT user_id,
                           MAX(last_seen_at)                                    AS last_seen_at,
                           BOOL_OR(ended_at IS NULL)                            AS has_open,
                           SUM(active_ms) FILTER (WHERE started_at >= :today)   AS today_active,
                           SUM(active_ms) FILTER (WHERE started_at >= :week)    AS week_active,
                           COUNT(*)       FILTER (WHERE started_at >= :today)   AS sessions_today
                      FROM user_sessions
                     WHERE org_id = :org AND started_at >= :week
                     GROUP BY user_id
                    """
                ),
                {
                    "org": principal.org_id,
                    "today": _start_of_today(),
                    # Was a hardcoded 7. Same number, but now the SAME number as
                    # every other visibility bound, so changing the policy is
                    # one edit rather than a hunt.
                    "week": _visible_floor(),
                },
            )
        ).all()

        logins = await _last_auth_actions(db, principal.org_id)

    out: list[MemberActivityDTO] = []
    for r in rows:
        last_login, last_logout = logins.get(str(r.user_id), (None, None))
        out.append(
            MemberActivityDTO(
                userId=str(r.user_id),
                state=_state(bool(r.has_open), r.last_seen_at),
                lastSeenAt=iso_z(r.last_seen_at),
                lastLoginAt=iso_z(last_login),
                lastLogoutAt=iso_z(last_logout),
                todayActiveMs=int(r.today_active or 0),
                last7dActiveMs=int(r.week_active or 0),
                sessionsToday=int(r.sessions_today or 0),
            )
        )
    return out


@router.get("/members/{user_id}/timeline", response_model=TimelinePage)
async def timeline(
    user_id: str,
    cursor: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=50, ge=1, le=200),
    category: str | None = Query(default=None, max_length=32),
    principal: Principal = Depends(require_principal),
) -> TimelinePage:
    """One member's activity, newest first.

    `category` is a stored category, or the `outside` view (see OUTSIDE_FILTER).

    Keyset-paginated on (occurred_at DESC, id DESC) — the same tuple the index is
    built on. OFFSET would be wrong here for a reason that shows up immediately
    in use: activity arrives continuously at the head of this list, so every new
    event shifts the page boundary and the reader sees rows twice.
    """
    subject = resolve_subject(principal, user_id)
    before: tuple[datetime, str] | None = None
    if cursor is not None:
        try:
            before = decode_cursor(cursor)
        except ValueError:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "malformed cursor"
            ) from None
    outside = category == OUTSIDE_FILTER
    if outside:
        category = None

    async with session() as db:
        await set_org_context(db, principal.org_id)
        rows = (
            await db.execute(
                text(
                    """
                    SELECT id, occurred_at, source, category, action, surface,
                           target_kind, target_id, duration_ms, detail_enc
                      FROM activity_events
                     WHERE org_id = :org AND user_id = :uid
                       -- Only the visible window is browsable; older events are
                       -- retained but not served here. See _visible_floor.
                       AND occurred_at >= :floor
                       -- Liveness beats are not activity and are no longer
                       -- written (see NON_EVENT_ACTIONS), but rows from before
                       -- that are still inside the visible window and inside
                       -- retention. Excluded here so the timeline reads the
                       -- same before and after the old rows age out.
                       AND NOT (action = ANY(CAST(:hidden AS text[])))
                       -- CAST every nullable parameter: on the first page both
                       -- cursor values are NULL, and asyncpg cannot infer a type
                       -- for a parameter that only ever appears against NULL —
                       -- it raises AmbiguousParameterError rather than guessing.
                       AND (CAST(:cur_at AS timestamptz) IS NULL
                            OR (occurred_at, id) < (CAST(:cur_at AS timestamptz), CAST(:cur_id AS uuid)))
                       AND (CAST(:category AS text) IS NULL OR category = :category)
                       -- The security record of a file open/download is the same
                       -- act as the engagement row already in this list, so only
                       -- the Security view shows it; everywhere else it would read
                       -- as every file opened twice.
                       AND (NOT (action = ANY(CAST(:mirror AS text[])))
                            OR CAST(:category AS text) = 'security')
                       AND (NOT CAST(:outside AS boolean)
                            OR category = 'app'
                            OR action = ANY(CAST(:outside_actions AS text[])))
                       -- BlissWork's own window is reported as an app too, but
                       -- time in it is in-app activity, not outside.
                       AND NOT (CAST(:outside AS boolean)
                                AND action = 'app.focus'
                                AND lower(COALESCE(target_id, '')) = ANY(CAST(:in_app AS text[])))
                     ORDER BY occurred_at DESC, id DESC
                     LIMIT :lim
                    """
                ),
                {
                    "org": principal.org_id, "uid": subject,
                    "cur_at": before[0] if before else None,
                    "cur_id": before[1] if before else None,
                    "category": category, "lim": limit + 1,
                    "outside": outside, "outside_actions": sorted(OUTSIDE_ACTIONS),
                    "in_app": settings.in_app_executable_names,
                    "floor": _visible_floor(),
                    "hidden": sorted(NON_EVENT_ACTIONS),
                    "mirror": sorted(SECURITY_MIRROR_ACTIONS),
                },
            )
        ).all()
        page = rows[:limit]
        entries = [
            TimelineEntry(
                id=str(r.id),
                occurredAt=iso_z(r.occurred_at) or "",
                source=r.source,
                category=r.category,
                action=r.action,
                surface=r.surface,
                targetKind=r.target_kind,
                targetId=r.target_id,
                durationMs=r.duration_ms,
                detail=await _detail(db, principal.org_id, r.detail_enc),
            )
            for r in page
        ]

    return TimelinePage(
        entries=entries,
        nextCursor=(
            encode_cursor(page[-1].occurred_at, str(page[-1].id))
            if len(rows) > limit and page
            else None
        ),
    )


@router.get("/members/{user_id}/sessions", response_model=SessionPage)
async def sessions_for(
    user_id: str,
    cursor: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=25, ge=1, le=100),
    principal: Principal = Depends(require_principal),
) -> SessionPage:
    subject = resolve_subject(principal, user_id)
    before: tuple[datetime, str] | None = None
    if cursor is not None:
        try:
            before = decode_cursor(cursor)
        except ValueError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "malformed cursor")

    async with session() as db:
        await set_org_context(db, principal.org_id)
        rows = (
            await db.execute(
                text(
                    """
                    SELECT id, source, device_label, started_at, last_seen_at,
                           ended_at, end_reason, active_ms, idle_ms, ip_prefix
                      FROM user_sessions
                     WHERE org_id = :org AND user_id = :uid
                       -- Same visibility window as the timeline. See _visible_floor.
                       AND started_at >= :floor
                       AND (CAST(:cur_at AS timestamptz) IS NULL
                            OR (started_at, id) < (CAST(:cur_at AS timestamptz), CAST(:cur_id AS uuid)))
                     ORDER BY started_at DESC, id DESC
                     LIMIT :lim
                    """
                ),
                {
                    "org": principal.org_id, "uid": subject,
                    "cur_at": before[0] if before else None,
                    "cur_id": before[1] if before else None,
                    "lim": limit + 1,
                    "floor": _visible_floor(),
                },
            )
        ).all()
    page = rows[:limit]
    return SessionPage(
        sessions=[
            SessionDTO(
                id=str(r.id), source=r.source, deviceLabel=r.device_label,
                startedAt=iso_z(r.started_at) or "", lastSeenAt=iso_z(r.last_seen_at) or "",
                endedAt=iso_z(r.ended_at), endReason=r.end_reason,
                activeMs=int(r.active_ms or 0), idleMs=int(r.idle_ms or 0),
                ipPrefix=r.ip_prefix,
            )
            for r in page
        ],
        nextCursor=(
            encode_cursor(page[-1].started_at, str(page[-1].id))
            if len(rows) > limit and page
            else None
        ),
    )


async def _detail(db, org_id: str, blob) -> dict[str, str] | None:
    """Decrypt the per-row detail, or return None.

    A row whose detail cannot be decrypted is NOT an error worth failing the
    whole page for: after a crypto-shred (right-to-erasure deletes the org's
    DEK) every historical blob becomes permanently unreadable BY DESIGN, and the
    timeline should still render the surrounding metadata rather than 500.
    """
    if blob is None:
        return None
    try:
        raw = await cryptor().decrypt(db, org_id, blob)
    except CryptoError:
        log.info("detail_undecryptable", org_id=org_id)
        return None
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except ValueError:
        return None
    return {k: str(v) for k, v in parsed.items()} if isinstance(parsed, dict) else None


async def _last_auth_actions(db, org_id: str) -> dict[str, tuple[datetime | None, datetime | None]]:
    """Most recent login and logout per member, from the server-observed rows.

    Bounded to the VISIBLE window (not the 90-day retention window) and to
    `category = 'auth'`, which the (org_id, user_id, occurred_at DESC) index
    serves directly.

    The window matters for consistency, not just for policy: this feeds the
    roster's last-login column, which sits beside a timeline that now stops at
    seven days. Reading the retention window here would report an 89-day-old
    sign-in next to a list that claims to hold everything.
    """
    rows = (
        await db.execute(
            text(
                """
                SELECT user_id,
                       MAX(occurred_at) FILTER (WHERE action = 'login')  AS last_login,
                       MAX(occurred_at) FILTER (WHERE action = 'logout') AS last_logout
                  FROM activity_events
                 WHERE org_id = :org AND category = 'auth'
                   AND occurred_at >= now() - make_interval(days => :days)
                 GROUP BY user_id
                """
            ),
            {"org": org_id, "days": settings.visible_window_days},
        )
    ).all()
    return {str(r.user_id): (r.last_login, r.last_logout) for r in rows}


def _now() -> datetime:
    from datetime import timezone

    return datetime.now(timezone.utc)


def _start_of_today() -> datetime:
    return _now().replace(hour=0, minute=0, second=0, microsecond=0)


def _visible_floor() -> datetime:
    """The oldest moment the per-event detail views may show.

    The timeline and the session list are the intrusive surfaces — a
    minute-by-minute record of one named person — and they were the only
    endpoints here with NO time bound at all: cursor and limit only, so "Load
    older" walked back through the full 90-day retention horizon.

    Clamping here rather than in the client is the point. A frontend-only limit
    is a suggestion, and it would have left the same data one curl away.

    Note the pagination falls out for free: once the query is floored, the
    keyset walk simply runs out of rows and `next_cursor` goes null at the
    boundary, so the "Load older" buttons disappear on their own.
    """
    return _now() - timedelta(days=settings.visible_window_days)


def _state(has_open_session: bool, last_seen: datetime | None) -> str:
    """Three states, where presence today has only two.

    A session stays open while a tab is open but the person is away from the
    keyboard; the sweeper is what eventually turns that into offline. Reporting
    'idle' in between is the difference between "their laptop is on" and "they
    are working" — which is the whole point of the distinction.
    """
    if not has_open_session or last_seen is None:
        return "offline"
    age = (_now() - last_seen).total_seconds()
    if age > settings.session_timeout_seconds:
        return "offline"  # sweeper has not caught it yet, but it is gone
    return "online" if age <= 120 else "idle"
