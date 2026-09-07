"""Aggregates: per-member summary, org-wide summary, and the .xlsx export feed.

Reads the daily rollups, then tops up TODAY from the raw stream — today has not
been rolled up yet (the job runs at 01:30 for the previous day), and a dashboard
that showed nothing until tomorrow would be useless on the day anyone actually
looks at it. Every other day inside the retention window is guaranteed to have a
rollup, because the prune job refuses to drop a day that was never rolled up.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import text

from ..auth import Principal, require_principal
from ..db import session, set_org_context
from ..rate_limit import limiter
from ..schemas import DayBucket, ExportRow, NamedCount, OrgSummaryDTO, SummaryDTO
from .subject import require_admin, resolve_subject

router = APIRouter(prefix="/telemetry", tags=["analytics"])

# One call must never be able to scan the whole history. 20k rollup rows is ~2
# years for a 30-person org, which is far past what a spreadsheet is useful for.
MAX_EXPORT_ROWS = 20_000
MAX_RANGE_DAYS = 400


@router.get("/members/{user_id}/summary", response_model=SummaryDTO)
async def member_summary(
    user_id: str,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    principal: Principal = Depends(require_principal),
) -> SummaryDTO:
    subject = resolve_subject(principal, user_id)
    start, end = _range(from_, to)
    async with session() as db:
        await set_org_context(db, principal.org_id)
        return await _summary_for(db, principal.org_id, subject, start, end)


@router.get("/org/summary", response_model=OrgSummaryDTO)
async def org_summary(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    principal: Principal = Depends(require_principal),
) -> OrgSummaryDTO:
    """Every member's totals over the range, for the all-members analytics grid."""
    require_admin(principal)
    start, end = _range(from_, to)
    async with session() as db:
        await set_org_context(db, principal.org_id)
        # activity_daily alone is not the member set.
        #
        # Only the nightly rollup writes that table, so anyone whose activity is
        # entirely from TODAY has no row in it yet and was missing from this
        # grid altogether — a brand-new workspace showed nobody on its first
        # day, and an admin who was idle yesterday could not find themselves.
        # _summary_for already tops up today's live numbers, but it only ran for
        # users this query had already found, so the gap was self-perpetuating.
        #
        # Union today's live sources in, and only when the requested range
        # actually reaches today (the same condition _summary_for uses before
        # bothering with the live top-up).
        today = _today()
        sql = (
            "SELECT DISTINCT user_id FROM activity_daily "
            "WHERE org_id = :org AND day BETWEEN :s AND :e"
        )
        params: dict[str, object] = {"org": principal.org_id, "s": start, "e": end}
        if start <= today <= end:
            sql += (
                " UNION SELECT DISTINCT user_id FROM user_sessions"
                " WHERE org_id = :org AND started_at >= :today_start"
                " UNION SELECT DISTINCT user_id FROM activity_events"
                " WHERE org_id = :org AND occurred_at >= :today_start"
            )
            params["today_start"] = datetime.combine(today, time.min, tzinfo=timezone.utc)
        user_ids = [str(r.user_id) for r in (await db.execute(text(sql), params)).all()]

        # Batched, not one _summary_for call per member: that was up to 3
        # sequential DB round trips (1 rollup fetch + 2 _today_live queries)
        # PER USER, which for a 100-person org meant ~300 queries in one
        # admin-page request. _daily_rows_by_user and _today_live_batch fetch
        # every member's rows in one GROUP BY user_id query each — the same
        # shape roster() (routes/timeline.py) already uses for the identical
        # problem — and _summary_from_rollup then builds each member's DTO
        # from the slice already in memory, with no further queries.
        rows_by_user = await _daily_rows_by_user(db, principal.org_id, user_ids, start, end)
        live_by_user = (
            await _today_live_batch(db, principal.org_id, user_ids, today)
            if start <= today <= end
            else {}
        )
        members = [
            _summary_from_rollup(uid, start, end, rows_by_user.get(uid, []), live_by_user.get(uid))
            for uid in user_ids
        ]
        days = _merge_days(members)
    return OrgSummaryDTO(**{"from": start.isoformat(), "to": end.isoformat()},
                         members=members, days=days)


@router.get("/export", response_model=list[ExportRow])
@limiter.limit("10/minute")
async def export(
    request: Request,   # noqa: ARG001 — slowapi reads the key off the request
    response: Response,  # required by slowapi (headers_enabled) to inject rate-limit headers
    scope: str = Query(default="member", pattern="^(member|org)$"),
    userId: str | None = Query(default=None),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    principal: Principal = Depends(require_principal),
) -> list[ExportRow]:
    """Flat per-member-per-day rows for the spreadsheet builder.

    Returns rollups, not raw events: a year of raw activity is millions of rows
    and no use in a spreadsheet, while a row per person per day is exactly what
    someone opening this in Excel wants to pivot on.
    """
    start, end = _range(from_, to)
    if scope == "org":
        require_admin(principal)
        subject = None
    else:
        subject = resolve_subject(principal, userId)

    async with session() as db:
        await set_org_context(db, principal.org_id)
        rows = (
            await db.execute(
                text(
                    """
                    SELECT d.user_id, d.day, d.active_ms, d.idle_ms, d.online_ms,
                           d.sessions_count, d.events_count, d.first_seen_at, d.last_seen_at,
                           d.by_surface
                      FROM activity_daily d
                     WHERE d.org_id = :org AND d.day BETWEEN :s AND :e
                       AND (CAST(:uid AS uuid) IS NULL OR d.user_id = CAST(:uid AS uuid))
                     ORDER BY d.day DESC, d.user_id
                     LIMIT :lim
                    """
                ),
                {"org": principal.org_id, "s": start, "e": end, "uid": subject,
                 "lim": MAX_EXPORT_ROWS},
            )
        ).all()
        apps = await _top_per_day(db, principal.org_id, "app_usage_daily", "app_name",
                                  "foreground_ms", start, end, subject)
        sites = await _top_per_day(db, principal.org_id, "site_usage_daily", "domain",
                                   "visit_ms", start, end, subject)

    return [
        ExportRow(
            userId=str(r.user_id),
            day=r.day.isoformat(),
            activeMs=int(r.active_ms or 0),
            idleMs=int(r.idle_ms or 0),
            onlineMs=int(r.online_ms or 0),
            sessions=int(r.sessions_count or 0),
            events=int(r.events_count or 0),
            firstSeenAt=_iso(r.first_seen_at),
            lastSeenAt=_iso(r.last_seen_at),
            topSurface=_top_key(r.by_surface),
            topApp=apps.get((str(r.user_id), r.day)),
            topSite=sites.get((str(r.user_id), r.day)),
        )
        for r in rows
    ]


async def _summary_for(
    db, org_id: str, user_id: str, start: date, end: date, *, with_detail: bool = True
) -> SummaryDTO:
    rows = (
        await db.execute(
            text(
                """
                SELECT day, active_ms, idle_ms, online_ms, sessions_count, events_count,
                       by_surface, by_action, by_hour
                  FROM activity_daily
                 WHERE org_id = :org AND user_id = :uid AND day BETWEEN :s AND :e
                 ORDER BY day
                """
            ),
            {"org": org_id, "uid": user_id, "s": start, "e": end},
        )
    ).all()

    today = _today()
    live = await _today_live(db, org_id, user_id, today) if start <= today <= end else None

    apps: list[NamedCount] = []
    sites: list[NamedCount] = []
    if with_detail:
        apps = await _top_overall(db, org_id, user_id, "app_usage_daily", "app_name",
                                  "foreground_ms", "switches", start, end)
        sites = await _top_overall(db, org_id, user_id, "site_usage_daily", "domain",
                                   "visit_ms", "visits", start, end)
        # Same reasoning as the `days` top-up in _summary_from_rollup: app_usage_daily/
        # site_usage_daily are rollup tables the nightly job (jobs/rollup.py) only ever
        # writes for YESTERDAY and earlier, so without this, using the app today never
        # shows up under "Top Applications"/"Top Sites" until tomorrow — active/idle
        # time already accounts for today, but the per-app breakdown silently did not.
        if start <= today <= end:
            apps = _merge_top(apps, await _live_top_targets(db, org_id, user_id, today, "app"))
            sites = _merge_top(sites, await _live_top_targets(db, org_id, user_id, today, "site"))

    return _summary_from_rollup(user_id, start, end, rows, live, apps=apps, sites=sites)


def _summary_from_rollup(
    user_id: str, start: date, end: date, rows, live: DayBucket | None,
    *, apps: list[NamedCount] | None = None, sites: list[NamedCount] | None = None,
) -> SummaryDTO:
    """Builds a member's SummaryDTO from already-fetched activity_daily rows
    plus an already-fetched `live` (today's) bucket.

    Shared by _summary_for (one user, its own two queries above) and
    org_summary (every member's rows/live buckets fetched once each, in bulk,
    by _daily_rows_by_user/_today_live_batch) so the two call sites can never
    compute a member's totals differently.
    """
    days = [
        DayBucket(
            day=r.day.isoformat(), activeMs=int(r.active_ms or 0), idleMs=int(r.idle_ms or 0),
            onlineMs=int(r.online_ms or 0), sessions=int(r.sessions_count or 0),
            events=int(r.events_count or 0),
        )
        for r in rows
    ]
    by_surface: dict[str, int] = {}
    by_action: dict[str, int] = {}
    hourly = [[0] * 24 for _ in range(7)]
    for r in rows:
        _accumulate(by_surface, r.by_surface)
        _accumulate(by_action, r.by_action)
        weekday = r.day.weekday()  # Monday = 0, matching the grid's first row
        for hour, ms in (r.by_hour or {}).items():
            if str(hour).isdigit() and 0 <= int(hour) < 24:
                hourly[weekday][int(hour)] += int(ms or 0)

    if live is not None:
        days = [d for d in days if d.day != live.day] + [live]
        days.sort(key=lambda d: d.day)

    return SummaryDTO(
        **{"from": start.isoformat(), "to": end.isoformat()},
        userId=user_id,
        totalActiveMs=sum(d.activeMs for d in days),
        totalIdleMs=sum(d.idleMs for d in days),
        totalOnlineMs=sum(d.onlineMs for d in days),
        sessions=sum(d.sessions for d in days),
        events=sum(d.events for d in days),
        days=days,
        bySurface=_named(by_surface),
        byAction=_named(by_action),
        topApps=apps or [],
        topSites=sites or [],
        hourly=hourly,
    )


async def _daily_rows_by_user(
    db, org_id: str, user_ids: list[str], start: date, end: date
) -> dict[str, list]:
    """Every activity_daily row for ALL given users, in ONE query, grouped in
    Python by user_id — the org_summary equivalent of _summary_for's per-user
    fetch above. Same shape as roster()'s single GROUP BY query
    (routes/timeline.py): one round trip regardless of member count, instead
    of one per member.
    """
    if not user_ids:
        return {}
    rows = (
        await db.execute(
            text(
                """
                SELECT user_id, day, active_ms, idle_ms, online_ms, sessions_count,
                       events_count, by_surface, by_action, by_hour
                  FROM activity_daily
                 WHERE org_id = :org AND user_id = ANY(:uids) AND day BETWEEN :s AND :e
                 ORDER BY user_id, day
                """
            ),
            {"org": org_id, "uids": user_ids, "s": start, "e": end},
        )
    ).all()
    by_user: dict[str, list] = {}
    for r in rows:
        by_user.setdefault(str(r.user_id), []).append(r)
    return by_user


async def _today_live_batch(
    db, org_id: str, user_ids: list[str], today: date
) -> dict[str, DayBucket]:
    """Batched _today_live: today's totals for ALL given users from the live
    tables, in the two GROUP BY queries this needs (sessions, events) instead
    of up to 2*N single-user queries.

    A user only gets an entry when GROUP BY actually emits a row for them,
    which — same as _today_live's own `not s.n and not (e and e.n)` check —
    only happens when they have at least one matching session or event today.
    """
    if not user_ids:
        return {}
    start = datetime.combine(today, datetime.min.time(), tzinfo=timezone.utc)
    session_rows = (
        await db.execute(
            text(
                "SELECT user_id, COALESCE(SUM(active_ms),0) a, COALESCE(SUM(idle_ms),0) i, "
                "COUNT(*) n, "
                "COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)) * 1000), 0) o "
                "FROM user_sessions "
                "WHERE org_id = :org AND user_id = ANY(:uids) AND started_at >= :s "
                "GROUP BY user_id"
            ),
            {"org": org_id, "uids": user_ids, "s": start},
        )
    ).all()
    event_rows = (
        await db.execute(
            text(
                "SELECT user_id, COUNT(*) n FROM activity_events "
                "WHERE org_id = :org AND user_id = ANY(:uids) AND occurred_at >= :s "
                "GROUP BY user_id"
            ),
            {"org": org_id, "uids": user_ids, "s": start},
        )
    ).all()

    events_by_user = {str(r.user_id): int(r.n or 0) for r in event_rows}
    live: dict[str, DayBucket] = {}
    for r in session_rows:
        uid = str(r.user_id)
        live[uid] = DayBucket(
            day=today.isoformat(), activeMs=int(r.a or 0), idleMs=int(r.i or 0),
            onlineMs=int(r.o or 0), sessions=int(r.n or 0), events=events_by_user.get(uid, 0),
        )
    for uid, n in events_by_user.items():
        if uid not in live:
            live[uid] = DayBucket(day=today.isoformat(), events=n)
    return live


async def _today_live(db, org_id: str, user_id: str, today: date) -> DayBucket | None:
    """Today's totals straight from the live tables (no rollup exists yet)."""
    start = datetime.combine(today, datetime.min.time(), tzinfo=timezone.utc)
    s = (
        await db.execute(
            text(
                "SELECT COALESCE(SUM(active_ms),0) a, COALESCE(SUM(idle_ms),0) i, COUNT(*) n, "
                "COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)) * 1000), 0) o "
                "FROM user_sessions WHERE org_id = :org AND user_id = :uid AND started_at >= :s"
            ),
            {"org": org_id, "uid": user_id, "s": start},
        )
    ).first()
    e = (
        await db.execute(
            text(
                "SELECT COUNT(*) n FROM activity_events "
                "WHERE org_id = :org AND user_id = :uid AND occurred_at >= :s"
            ),
            {"org": org_id, "uid": user_id, "s": start},
        )
    ).first()
    if s is None or (not s.n and not (e and e.n)):
        return None
    return DayBucket(
        day=today.isoformat(), activeMs=int(s.a or 0), idleMs=int(s.i or 0),
        onlineMs=int(s.o or 0), sessions=int(s.n or 0), events=int(e.n if e else 0),
    )


async def _live_top_targets(
    db, org_id: str, user_id: str, today: date, target_kind: str
) -> dict[str, tuple[str, int, int]]:
    """Today's {app,site} usage straight from activity_events — the raw rows
    jobs/rollup.py's _APP_ROLLUP/_SITE_ROLLUP has not processed yet (it only
    ever rolls up the PREVIOUS day). Mirrors that job's own GROUP BY, restricted
    to today. target_id is plaintext (unlike detail_enc), so no decrypt is
    needed here — same reason the rollup job itself can group by it.

    Keyed by lower(target_id), same as app_usage_daily/site_usage_daily's own
    dedup key, so a live row merges onto the right rolled-up row regardless of
    casing differences between how two different days reported the same app.
    """
    start = datetime.combine(today, time.min, tzinfo=timezone.utc)
    rows = (
        await db.execute(
            text(
                "SELECT lower(target_id) k, MAX(target_id) label, "
                "COALESCE(SUM(duration_ms), 0) ms, COUNT(*) n "
                "FROM activity_events "
                "WHERE org_id = :org AND user_id = :uid AND occurred_at >= :s "
                "AND target_kind = :kind AND target_id IS NOT NULL "
                "GROUP BY lower(target_id)"
            ),
            {"org": org_id, "uid": user_id, "s": start, "kind": target_kind},
        )
    ).all()
    return {r.k: (r.label, int(r.ms or 0), int(r.n or 0)) for r in rows}


def _merge_top(rolled: list[NamedCount], live: dict[str, tuple[str, int, int]]) -> list[NamedCount]:
    """Adds today's live counts onto the rolled-up ones sharing a key, appends
    any key the rollup has not seen yet, then re-sorts/caps exactly as
    _top_overall's own `ORDER BY ms DESC LIMIT 10` does."""
    merged: dict[str, NamedCount] = {r.key.lower(): r.model_copy() for r in rolled}
    for key, (label, ms, n) in live.items():
        existing = merged.get(key)
        if existing is not None:
            existing.valueMs += ms
            existing.count += n
        else:
            merged[key] = NamedCount(key=label, label=label, valueMs=ms, count=n)
    return sorted(merged.values(), key=lambda r: -r.valueMs)[:10]


async def _top_overall(db, org_id, user_id, table, key_col, ms_col, count_col, start, end):
    rows = (
        await db.execute(
            text(
                f"SELECT {key_col} k, SUM({ms_col}) ms, SUM({count_col}) n "  # noqa: S608 — fixed identifiers
                f"FROM {table} WHERE org_id = :org AND user_id = :uid AND day BETWEEN :s AND :e "
                f"GROUP BY {key_col} ORDER BY ms DESC LIMIT 10"
            ),
            {"org": org_id, "uid": user_id, "s": start, "e": end},
        )
    ).all()
    return [NamedCount(key=r.k, label=r.k, valueMs=int(r.ms or 0), count=int(r.n or 0)) for r in rows]


async def _top_per_day(db, org_id, table, key_col, ms_col, start, end, user_id):
    """The single biggest {app,site} per member per day, for the export column."""
    rows = (
        await db.execute(
            text(
                f"SELECT DISTINCT ON (user_id, day) user_id, day, {key_col} k "  # noqa: S608
                f"FROM {table} WHERE org_id = :org AND day BETWEEN :s AND :e "
                f"AND (CAST(:uid AS uuid) IS NULL OR user_id = CAST(:uid AS uuid)) "
                f"ORDER BY user_id, day, {ms_col} DESC"
            ),
            {"org": org_id, "s": start, "e": end, "uid": user_id},
        )
    ).all()
    return {(str(r.user_id), r.day): r.k for r in rows}


def _accumulate(into: dict[str, int], src) -> None:
    for k, v in (src or {}).items():
        into[str(k)] = into.get(str(k), 0) + int(v or 0)


def _named(counts: dict[str, int]) -> list[NamedCount]:
    return [
        NamedCount(key=k, label=k, valueMs=v, count=v)
        for k, v in sorted(counts.items(), key=lambda kv: -kv[1])[:12]
    ]


def _merge_days(members: list[SummaryDTO]) -> list[DayBucket]:
    merged: dict[str, DayBucket] = {}
    for m in members:
        for d in m.days:
            cur = merged.setdefault(d.day, DayBucket(day=d.day))
            cur.activeMs += d.activeMs
            cur.idleMs += d.idleMs
            cur.onlineMs += d.onlineMs
            cur.sessions += d.sessions
            cur.events += d.events
    return [merged[k] for k in sorted(merged)]


def _top_key(blob) -> str | None:
    if not blob:
        return None
    top = max(blob.items(), key=lambda kv: int(kv[1] or 0), default=None)
    return str(top[0]) if top else None


def _iso(dt: datetime | None) -> str | None:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" if dt else None


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _range(from_: str | None, to: str | None) -> tuple[date, date]:
    """Parse the range, defaulting to the last 30 days and bounding its width.

    The client sends absolute dates it computed in the VIEWER's timezone (the
    same thing the tasks export does) — the server never interprets "last week",
    because only the client knows where the user is.
    """
    end = _parse_day(to) or _today()
    start = _parse_day(from_) or (end - timedelta(days=29))
    if start > end:
        start, end = end, start
    if (end - start).days > MAX_RANGE_DAYS:
        start = end - timedelta(days=MAX_RANGE_DAYS)
    return start, end


def _parse_day(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        return None

