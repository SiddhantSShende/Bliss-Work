from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request, Response
from sqlalchemy import text

from ..auth import Principal, PrincipalDep
from ..crypto import cryptor
from ..db import session, set_org_context
from ..rate_limit import limiter
from ..schemas import TaskExportRow
from .helpers import iso

router = APIRouter()

_SCOPES = ("sent", "received", "all")

# Hard cap on exported rows so a large org/date-range can't stream unbounded
# work (each row decrypts title/description/review). The client picks a date
# range; if it still exceeds this, we return the newest CAP rows and the caller
# should narrow the window. Mirrors the pagination-bounds discipline in
# tasks_read.py.
_MAX_EXPORT_ROWS = 5000

ScopeQuery = Query(default="all")


def _parse_dt(value: str | None, field: str) -> datetime | None:
    """Parse a client-supplied ISO-8601 UTC bound. The CLIENT computes named
    ranges (this week/month/year) in the user's local timezone and sends explicit
    from/to instants, so the server only does a plain range compare."""
    if value is None:
        return None
    try:
        # Accept a trailing 'Z' (fromisoformat handles it on 3.11+, but normalize
        # for older runtimes to be safe).
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=f"{field} must be ISO-8601") from exc


@router.get("/tasks/export", response_model=list[TaskExportRow])
@limiter.limit("15/minute")  # tight per-route cap: each call decrypts up to 5000 rows
async def export_tasks(
    request: Request,
    response: Response,  # required by slowapi (headers_enabled) to inject rate-limit headers
    principal: Principal = PrincipalDep,
    scope: str = ScopeQuery,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None, alias="to"),
) -> list[TaskExportRow]:
    org_id, me = principal.org_id, principal.user_id
    # Validated in-handler (not as a Literal annotation): under
    # `from __future__ import annotations`, slowapi's @limiter.limit wrapper
    # shifts the annotation-resolution namespace so a module-level Literal alias
    # can't be resolved by FastAPI's TypeAdapter.
    if scope not in _SCOPES:
        raise HTTPException(status_code=422, detail="scope must be one of: sent, received, all")
    dt_from = _parse_dt(from_, "from")
    dt_to = _parse_dt(to, "to")

    # scope → which side of the relationship the caller is on. Filtering happens
    # on top of RLS (which already confines everything to the caller's org).
    if scope == "sent":
        scope_sql = "t.sender_id = :me"
    elif scope == "received":
        scope_sql = "ta.assignee_id = :me"
    else:  # all — tasks I allocated OR tasks allocated to me
        scope_sql = "(t.sender_id = :me OR ta.assignee_id = :me)"

    params: dict = {"org": org_id, "me": me, "limit": _MAX_EXPORT_ROWS}
    date_sql = ""
    # Filter on assigned_at — the only milestone present on every assignment.
    if dt_from is not None:
        date_sql += " AND ta.assigned_at >= :from"
        params["from"] = dt_from
    if dt_to is not None:
        date_sql += " AND ta.assigned_at < :to"
        params["to"] = dt_to

    async with session() as db:
        await set_org_context(db, org_id)
        rows = (
            await db.execute(
                text(
                    "SELECT t.id, t.org_id, t.title_enc, t.description_enc, "
                    "       t.sender_id, ta.assignee_id, ta.status, "
                    "       ta.assigned_at, ta.acknowledged_at, ta.ignored_at, "
                    "       ta.completed_at, ta.left_at, ta.reviewed_at, "
                    "       ta.review_enc, ta.review_rating, "
                    "       CASE WHEN ta.completed_at IS NOT NULL "
                    "            THEN EXTRACT(EPOCH FROM (ta.completed_at - ta.assigned_at))::bigint "
                    "       END AS time_taken_seconds, "
                    "       COALESCE(ups.username, '') AS sender_username, "
                    "       COALESCE(upa.username, '') AS assignee_username "
                    "FROM task_assignees ta "
                    "JOIN tasks t ON t.id = ta.task_id "
                    "LEFT JOIN user_projection ups "
                    "       ON ups.user_id = t.sender_id AND ups.org_id = t.org_id "
                    "LEFT JOIN user_projection upa "
                    "       ON upa.user_id = ta.assignee_id AND upa.org_id = ta.org_id "
                    f"WHERE ta.org_id = :org AND {scope_sql}{date_sql} "
                    "ORDER BY ta.assigned_at DESC "
                    "LIMIT :limit"
                ),
                params,
            )
        ).all()

        out: list[TaskExportRow] = []
        for r in rows:
            org = str(r.org_id)
            review = (
                await cryptor().decrypt(db, org, r.review_enc)
                if r.review_enc is not None
                else None
            )
            out.append(
                TaskExportRow(
                    taskId=str(r.id),
                    title=await cryptor().decrypt(db, org, r.title_enc) or "",
                    description=await cryptor().decrypt(db, org, r.description_enc) or "",
                    allocatedById=str(r.sender_id),
                    allocatedByUsername=r.sender_username,
                    allocatedToId=str(r.assignee_id),
                    allocatedToUsername=r.assignee_username,
                    status=r.status,
                    allocatedAt=iso(r.assigned_at),
                    acknowledgedAt=iso(r.acknowledged_at),
                    ignoredAt=iso(r.ignored_at),
                    completedAt=iso(r.completed_at),
                    leftAt=iso(r.left_at),
                    timeTakenSeconds=(
                        int(r.time_taken_seconds)
                        if r.time_taken_seconds is not None
                        else None
                    ),
                    reviewedAt=iso(r.reviewed_at),
                    review=review,
                    reviewRating=r.review_rating,
                )
            )
    return out
