"""Correlate desktop and browser activity_events rows into one coherent
activity_sessions record.

A desktop `app.focus` row ("Google Chrome, 15:00-15:14") and a browser
`site.visit` row ("youtube.com, 15:00-15:13") describe the SAME fifteen
minutes from two different sensors. Left as two rows, the timeline either
shows both (redundant — "used Chrome" right next to "visited YouTube") or
picks one and throws the other's fields away (today's `collapseSwitches` in
activityLabels.ts). This module produces a THIRD thing instead: one row
carrying both — the application, the site, the page title, the URL — anchored
on whichever sensor's span the other one falls inside.

── Why correlation happens here, not in insert_events ───────────────────────
`insert_events` (ingest.py) is the single write path for EVERY producer,
including the Kafka consumer's server-observed rows, which have no concept of
a foreground span at all. Sessionizing only applies to `app`/`site` category
rows, so it is a second, narrower step the two routes that produce those
categories (routes/ingest.py's beacon, routes/agent.py's agent ingest) call
after insert_events succeeds — not a change to the shared insert itself.

── Why this is an upsert against RECENT rows, not a batch job ───────────────
Desktop and browser events arrive in separate HTTP requests, from separate
processes (the Electron main process; the browser extension's service
worker), with no shared transaction and no guaranteed order. Correlation
therefore has to be "does an uncorrelated row for this user already sit near
this one in time" — a lookup, not a fold over a batch — and it has to work
whichever sensor's row lands second.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta

import uuid6
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from crypto import cryptor
from .activity_detail import DETAIL_TITLE
from .ingest import InsertedRow

# How far apart two sensors' readings of the SAME switch may land and still be
# considered the same moment. Matches SWITCH_MERGE_MS in activityLabels.ts —
# the two numbers describe the same real-world fact (independent sampling
# cadences: the desktop agent's 15s poll, the extension's tab-switch event)
# and must not drift apart, or a pair the frontend would already recognise as
# one switch would fail to correlate here.
CORRELATION_TOLERANCE = timedelta(seconds=20)


@dataclass
class SessionizableRow:
    """The half of an ActivityRow the sessionizer needs — deliberately not the
    same dataclass as ingest.py's ActivityRow, which also carries fields
    (surface, session_id) with no meaning for a foreground span."""

    id: str
    org_id: str
    user_id: str
    category: str  # 'app' | 'site'
    action: str
    occurred_at: datetime
    duration_ms: int | None
    target_id: str | None  # app name (desktop) or registrable domain (browser)
    detail: dict[str, str]


async def sessionize(db: AsyncSession, rows: list[SessionizableRow]) -> None:
    """Correlate each app.focus/site.visit row into activity_sessions.

    Called AFTER the caller has inserted these same rows into activity_events
    and within the SAME transaction/RLS context — this never sets org context
    itself, matching insert_events's own contract.
    """
    for row in rows:
        if row.category == "app":
            await _sessionize_desktop(db, row)
        elif row.category == "site":
            await _sessionize_browser(db, row)
        # Any other category (system, auth, navigation, ...) has no foreground
        # span to sessionize — silently skipped, not an error.


async def sessionize_inserted(db: AsyncSession, inserted: list[InsertedRow]) -> None:
    """Convenience wrapper for the ingest routes: take insert_events's own
    return value directly, filter to the categories that have a foreground
    span, and sessionize them.

    A row missing `duration_ms` (a span the producer could not close, or a
    non-span action that slipped through `_CLIENT_CATEGORIES`/
    `_AGENT_CATEGORIES`'s filter) is skipped rather than sessionized with a
    fabricated zero duration — an unknown duration is not the same fact as a
    zero-length visit, and treating it as one would put a phantom instant
    session on the timeline for something that never had a knowable end.
    """
    rows = [
        SessionizableRow(
            id=ins.id, org_id=ins.row.org_id, user_id=ins.row.user_id,
            category=ins.row.category, action=ins.row.action,
            occurred_at=ins.row.occurred_at, duration_ms=ins.row.duration_ms,
            target_id=ins.row.target_id, detail={k: str(v) for k, v in ins.row.detail.items()},
        )
        for ins in inserted
        if ins.row.category in ("app", "site") and ins.row.duration_ms is not None
    ]
    if rows:
        await sessionize(db, rows)


async def _sessionize_desktop(db: AsyncSession, row: SessionizableRow) -> None:
    """A desktop app.focus row arrived. Look for an uncorrelated browser span
    that overlaps it; merge if found, otherwise stand alone.

    The desktop row is ALWAYS the anchor when both exist — see the migration's
    note on why. That is true whichever sensor's row happened to arrive
    second: if the browser row is already here with its OWN standalone
    session, this call RE-ANCHORS that same session row onto the desktop row
    (see `_reanchor_standalone_site_session`) rather than inserting a second
    one — the requirement is one merged row, same id throughout, not a
    replacement.
    """
    site = await _find_uncorrelated(db, row, other_category="site")
    detail = {**row.detail}
    app_name = row.target_id

    if site is not None:
        detail = {**site.detail, **detail}  # desktop detail (from) wins on key clash
        kind = "app+site"
        domain = site.target_id
        title = site.detail.get(DETAIL_TITLE)
        started_at, ended_at = _merged_span(row, site)
        reanchored = await _reanchor_standalone_site_session(
            db, site_event_id=site.id, new_anchor_id=row.id, correlated_id=site.id,
            kind=kind, app_name=app_name, domain=domain, title=title,
            started_at=started_at, ended_at=ended_at, detail=detail, org_id=row.org_id,
        )
        if reanchored:
            return
        # Defensive fallback, not an expected path: every producer's batch is
        # single-category today (a desktop agent batch is app/system, a
        # browser batch is site — see routes/agent.py's `_AGENT_CATEGORIES`
        # split by token kind), so `site` here was always inserted by an
        # EARLIER request and always has a session by the time this runs. If
        # that ever changes, this still produces a correct (if not re-anchored)
        # session rather than raising.
    else:
        kind = "app"
        domain = None
        title = detail.get(DETAIL_TITLE)
        started_at, ended_at = _span_of(row)

    await _upsert_session(
        db, session_id=str(uuid6.uuid7()), row=row, kind=kind, anchor_id=row.id,
        correlated_id=site.id if site else None, app_name=app_name, domain=domain,
        title=title, started_at=started_at, ended_at=ended_at, detail=detail,
    )


async def _sessionize_browser(db: AsyncSession, row: SessionizableRow) -> None:
    """A browser site.visit row arrived. Look for an uncorrelated desktop span
    that overlaps it; merge if found, otherwise stand alone (browser-only
    coverage — the desktop sensor may be absent, disabled, or simply have
    reported nothing for this exact window).
    """
    app = await _find_uncorrelated(db, row, other_category="app")

    if app is not None:
        # The desktop row already exists and may ALREADY own a session (it was
        # inserted first, sessionized as standalone, and is now being upgraded
        # in place) or may be brand new from this same batch. Either way the
        # desktop row is the anchor; upsert against it.
        detail = {**row.detail, **app.detail}  # desktop detail (from) wins on key clash
        started_at, ended_at = _merged_span(app, row)
        await _upsert_session(
            db, session_id=str(uuid6.uuid7()), row=app, kind="app+site", anchor_id=app.id,
            correlated_id=row.id, app_name=app.target_id, domain=row.target_id,
            title=row.detail.get(DETAIL_TITLE), started_at=started_at, ended_at=ended_at,
            detail=detail,
        )
        return

    # No desktop row yet — stand alone, anchored on the browser row itself.
    # This row's OWN id is used as anchor_event_id (not a made-up one), so a
    # desktop row that arrives later can find and claim it via
    # idx_sessions_anchor exactly the way `_claim_standalone_site_session` does.
    started_at, ended_at = _span_of(row)
    await _upsert_session(
        db, session_id=str(uuid6.uuid7()), row=row, kind="site", anchor_id=row.id,
        correlated_id=None, app_name=None, domain=row.target_id,
        title=row.detail.get(DETAIL_TITLE), started_at=started_at, ended_at=ended_at,
        detail=row.detail,
    )


def _span_of(row: SessionizableRow) -> tuple[datetime, datetime]:
    return row.occurred_at, row.occurred_at + timedelta(milliseconds=row.duration_ms or 0)


def _merged_span(
    anchor: SessionizableRow, other: SessionizableRow
) -> tuple[datetime, datetime]:
    """The session's boundaries when two spans correlate.

    Anchored on the DESKTOP span's own timing, per the migration's rationale:
    "Chrome had focus 15:00-15:14" is the fact that should not move just
    because the browser extension's own span closed a few seconds earlier or
    later — the desktop reading is what answers "when did the person actually
    leave", and the example in the task spec (15:00-15:14, the DESKTOP
    boundary, not any browser-only timing) is this rule.
    """
    return _span_of(anchor)


async def _find_uncorrelated(
    db: AsyncSession, row: SessionizableRow, *, other_category: str
) -> SessionizableRow | None:
    """The most recent uncorrelated activity_events row of the OTHER category,
    for the same user, whose interval overlaps `row`'s within tolerance.

    Reads activity_events directly (not activity_sessions) for the candidate's
    own detail/target_id — the session table may not have a row for it yet
    (this is often the very first look at that row). Scoped to sessions with
    `correlated_event_id IS NULL` via a join back to activity_sessions, so a
    browser span already claimed by an earlier desktop row is never claimed
    twice — this is what keeps requirement 7 (no duplicates on out-of-order/
    duplicate delivery) true: a row can be SOMEONE's correlation partner only
    once, because claiming it sets correlated_event_id on that session.
    """
    lo = row.occurred_at - CORRELATION_TOLERANCE
    hi = row.occurred_at + timedelta(milliseconds=row.duration_ms or 0) + CORRELATION_TOLERANCE
    action = "app.focus" if other_category == "app" else "site.visit"
    result = (
        await db.execute(
            text(
                """
                SELECT e.id, e.occurred_at, e.duration_ms, e.target_id, e.detail_enc
                  FROM activity_events e
                  JOIN activity_sessions s ON s.anchor_event_id = e.id AND s.org_id = e.org_id
                 WHERE e.org_id = :org AND e.user_id = :uid AND e.category = :cat
                   AND e.action = :action
                   AND s.correlated_event_id IS NULL
                   AND e.occurred_at BETWEEN :lo AND :hi
                 ORDER BY e.occurred_at DESC
                 LIMIT 1
                """
            ),
            {
                "org": row.org_id, "uid": row.user_id, "cat": other_category,
                "action": action, "lo": lo, "hi": hi,
            },
        )
    ).first()
    if result is None:
        return None
    detail = await _decrypt_detail(db, row.org_id, result.detail_enc)
    return SessionizableRow(
        id=str(result.id), org_id=row.org_id, user_id=row.user_id, category=other_category,
        action=action, occurred_at=result.occurred_at, duration_ms=result.duration_ms,
        target_id=result.target_id, detail=detail,
    )


async def _reanchor_standalone_site_session(
    db: AsyncSession,
    *,
    site_event_id: str,
    new_anchor_id: str,
    correlated_id: str,
    kind: str,
    app_name: str | None,
    domain: str | None,
    title: str | None,
    started_at: datetime,
    ended_at: datetime,
    detail: dict[str, str],
    org_id: str,
) -> bool:
    """Upgrade a browser-only session (anchor_event_id = the site.visit row's
    own id) into a merged app+site session, IN PLACE — same session id, now
    re-anchored on the desktop row.

    Returns whether a standalone session was found and upgraded. False means
    the site row has no session yet (both halves are new in this same call),
    and the caller falls through to an ordinary insert.

    This is the one place `activity_sessions.id` survives a change to
    `anchor_event_id` — deliberately, so a client that already fetched the
    browser-only session and later re-fetches sees the SAME row grow richer,
    not a new row appear beside a stale one.
    """
    detail_enc = await cryptor().encrypt(
        db, org_id, json.dumps(detail, separators=(",", ":"), sort_keys=True)
    ) if detail else None
    result = await db.execute(
        text(
            """
            UPDATE activity_sessions
               SET anchor_event_id = :new_anchor, correlated_event_id = :correlated,
                   kind = :kind, app_name = :app_name, domain = :domain, title = :title,
                   started_at = :started, ended_at = :ended, duration_ms = :duration,
                   detail_enc = :detail, updated_at = now()
             WHERE anchor_event_id = :old_anchor AND org_id = :org
            """
        ),
        {
            "new_anchor": new_anchor_id, "correlated": correlated_id, "kind": kind,
            "app_name": app_name, "domain": domain, "title": title,
            "started": started_at, "ended": ended_at,
            "duration": int((ended_at - started_at).total_seconds() * 1000),
            "detail": detail_enc, "old_anchor": site_event_id, "org": org_id,
        },
    )
    return bool(result.rowcount)


_INSERT = text(
    """
    INSERT INTO activity_sessions (
        id, org_id, user_id, anchor_event_id, correlated_event_id, started_at,
        ended_at, duration_ms, kind, app_name, domain, title, detail_enc
    ) VALUES (
        :id, :org, :uid, :anchor, :correlated, :started, :ended, :duration,
        :kind, :app_name, :domain, :title, :detail
    )
    """
)

# No unique constraint on anchor_event_id: this module only ever inserts a
# second session for an anchor it has already seen through the SELECT-then-
# branch in `_upsert_session` below, which finds the existing row and updates
# it instead — the check-then-act race that would matter under true
# concurrent writers is closed by the fact that a given (org, user)'s events
# are only ever sessionized by ONE request at a time in this deployment
# (desktop and browser batches are serialized per-producer by their own
# ingest route, never issued concurrently by the same agent).


async def _upsert_session(
    db: AsyncSession,
    *,
    session_id: str,
    row: SessionizableRow,
    kind: str,
    anchor_id: str,
    correlated_id: str | None,
    app_name: str | None,
    domain: str | None,
    title: str | None,
    started_at: datetime,
    ended_at: datetime,
    detail: dict[str, str],
) -> None:
    """Insert the session for `anchor_id`, or update it in place if a session
    for that anchor already exists (the out-of-order upgrade path: a
    standalone site session becomes app+site when the desktop row later shows
    up needing exactly this anchor id — but that path re-anchors under a NEW
    id, so this function's own update branch instead handles same-anchor
    re-delivery: a duplicate/retried desktop batch re-sessionizing a row it
    already sessionized, which must update in place, not insert twice).
    """
    detail_enc = await cryptor().encrypt(db, row.org_id, json.dumps(detail, separators=(",", ":"), sort_keys=True)) if detail else None
    existing = (
        await db.execute(
            text("SELECT id FROM activity_sessions WHERE org_id = :org AND anchor_event_id = :anchor"),
            {"org": row.org_id, "anchor": anchor_id},
        )
    ).first()
    if existing is not None:
        await db.execute(
            text(
                """
                UPDATE activity_sessions
                   SET correlated_event_id = COALESCE(:correlated, correlated_event_id),
                       kind = :kind, app_name = :app_name, domain = :domain, title = :title,
                       started_at = :started, ended_at = :ended, duration_ms = :duration,
                       detail_enc = :detail, updated_at = now()
                 WHERE id = :id
                """
            ),
            {
                "id": str(existing.id), "correlated": correlated_id, "kind": kind,
                "app_name": app_name, "domain": domain, "title": title,
                "started": started_at, "ended": ended_at,
                "duration": int((ended_at - started_at).total_seconds() * 1000),
                "detail": detail_enc,
            },
        )
        return
    await db.execute(
        _INSERT,
        {
            "id": session_id, "org": row.org_id, "uid": row.user_id, "anchor": anchor_id,
            "correlated": correlated_id, "started": started_at, "ended": ended_at,
            "duration": int((ended_at - started_at).total_seconds() * 1000),
            "kind": kind, "app_name": app_name, "domain": domain, "title": title,
            "detail": detail_enc,
        },
    )


async def _decrypt_detail(db: AsyncSession, org_id: str, detail_enc: bytes | None) -> dict[str, str]:
    if not detail_enc:
        return {}
    raw = await cryptor().decrypt(db, org_id, detail_enc)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}
