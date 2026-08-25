from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import text

from ..auth import Principal, PrincipalDep
from crypto import cryptor
from ..db import session, set_org_context
from ..schemas import SentAssignee, SentTaskDTO, StickyTaskDTO, actions_for
from .helpers import iso

router = APIRouter()

# Pagination bounds shared by every read endpoint so an unbounded result set
# can't exhaust memory. We use a capped LIMIT/OFFSET (offset pagination) — the
# response shape is unchanged (still a bare list); callers that pass nothing
# get the first page at the historical-default ordering.
_DEFAULT_LIMIT = 50
_MAX_LIMIT = 100

LimitQuery = Query(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT)
OffsetQuery = Query(default=0, ge=0)


# ── Inbox / Sticky (caller as assignee) ─────────────────────────────────────────
_ACTIVE = ("SENT", "ACKNOWLEDGED")


async def _sticky_list(
    principal: Principal,
    statuses: tuple[str, ...] = _ACTIVE,
    limit: int = _DEFAULT_LIMIT,
    offset: int = 0,
) -> list[StickyTaskDTO]:
    placeholders = ", ".join(f":s{i}" for i in range(len(statuses)))
    params = {
        "org": principal.org_id,
        "me": principal.user_id,
        "limit": limit,
        "offset": offset,
    }
    params.update({f"s{i}": s for i, s in enumerate(statuses)})
    async with session() as db:
        # RLS: scope this transaction to the caller's org before any read
        # (the JOIN over task_assignees/tasks/user_projection and the per-row
        # decrypt() that reads org_keys are all RLS-protected).
        await set_org_context(db, principal.org_id)
        rows = (
            await db.execute(
                text(
                    "SELECT t.id, t.org_id, t.title_enc, t.description_enc, t.sender_id, "
                    "       ta.status, ta.status_version, ta.assigned_at, ta.acknowledged_at, "
                    "       ta.completed_at, ta.ignored_at, ta.left_at, ta.reviewed_at, "
                    "       ta.review_enc, ta.review_rating, "
                    "       COALESCE(up.username, '') AS sender_username, "
                    "       COALESCE(up.display_name, '') AS sender_display_name "
                    "FROM task_assignees ta "
                    "JOIN tasks t ON t.id = ta.task_id "
                    "LEFT JOIN user_projection up "
                    "       ON up.user_id = t.sender_id AND up.org_id = t.org_id "
                    f"WHERE ta.org_id = :org AND ta.assignee_id = :me AND ta.status IN ({placeholders}) "
                    "ORDER BY ta.assigned_at DESC "
                    "LIMIT :limit OFFSET :offset"
                ),
                params,
            )
        ).all()

        # Decrypt per row under the row's org_id (transparent at-rest encryption).
        out: list[StickyTaskDTO] = []
        for r in rows:
            org = str(r.org_id)
            review = (
                await cryptor().decrypt(db, org, r.review_enc)
                if r.review_enc is not None
                else None
            )
            out.append(
                StickyTaskDTO(
                    taskId=str(r.id),
                    orgId=org,
                    title=await cryptor().decrypt(db, org, r.title_enc) or "",
                    description=await cryptor().decrypt(db, org, r.description_enc) or "",
                    senderId=str(r.sender_id),
                    senderUsername=r.sender_username,
                    senderDisplayName=r.sender_display_name,
                    myStatus=r.status,
                    actions=actions_for(r.status),
                    statusVersion=r.status_version,
                    assignedAt=iso(r.assigned_at),
                    acknowledgedAt=iso(r.acknowledged_at),
                    completedAt=iso(r.completed_at),
                    ignoredAt=iso(r.ignored_at),
                    leftAt=iso(r.left_at),
                    reviewedAt=iso(r.reviewed_at),
                    review=review,
                    reviewRating=r.review_rating,
                )
            )
    return out


@router.get("/tasks/inbox", response_model=list[StickyTaskDTO])
async def inbox(
    principal: Principal = PrincipalDep,
    limit: int = LimitQuery,
    offset: int = OffsetQuery,
) -> list[StickyTaskDTO]:
    return await _sticky_list(principal, limit=limit, offset=offset)


@router.get("/tasks/sticky", response_model=list[StickyTaskDTO])
async def sticky(
    principal: Principal = PrincipalDep,
    limit: int = LimitQuery,
    offset: int = OffsetQuery,
) -> list[StickyTaskDTO]:
    return await _sticky_list(principal, limit=limit, offset=offset)


@router.get("/tasks/{task_id}/detail", response_model=StickyTaskDTO)
async def task_detail(
    task_id: str,
    principal: Principal = PrincipalDep,
) -> StickyTaskDTO:
    """Single task assigned to me, at ANY status.

    The list endpoints (/tasks/inbox, /tasks/sticky) only return the ACTIVE
    statuses, so a terminal task (COMPLETED / IGNORED / LEFT) opened from the
    unified inbox would 404 in the client cache. This endpoint resolves one task
    by id for the caller-as-assignee regardless of status, so the inbox detail
    view can always render it. RLS confines the lookup to the caller's org.
    """
    async with session() as db:
        await set_org_context(db, principal.org_id)
        row = (
            await db.execute(
                text(
                    "SELECT t.id, t.org_id, t.title_enc, t.description_enc, t.sender_id, "
                    "       ta.status, ta.status_version, ta.assigned_at, ta.acknowledged_at, "
                    "       ta.completed_at, ta.ignored_at, ta.left_at, ta.reviewed_at, "
                    "       ta.review_enc, ta.review_rating, "
                    "       COALESCE(up.username, '') AS sender_username, "
                    "       COALESCE(up.display_name, '') AS sender_display_name "
                    "FROM task_assignees ta "
                    "JOIN tasks t ON t.id = ta.task_id "
                    "LEFT JOIN user_projection up "
                    "       ON up.user_id = t.sender_id AND up.org_id = t.org_id "
                    "WHERE ta.org_id = :org AND ta.assignee_id = :me AND ta.task_id = :tid"
                ),
                {"org": principal.org_id, "me": principal.user_id, "tid": task_id},
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail="task not found")
        org = str(row.org_id)
        review = (
            await cryptor().decrypt(db, org, row.review_enc)
            if row.review_enc is not None
            else None
        )
        return StickyTaskDTO(
            taskId=str(row.id),
            orgId=org,
            title=await cryptor().decrypt(db, org, row.title_enc) or "",
            description=await cryptor().decrypt(db, org, row.description_enc) or "",
            senderId=str(row.sender_id),
            senderUsername=row.sender_username,
            senderDisplayName=row.sender_display_name,
            myStatus=row.status,
            actions=actions_for(row.status),
            statusVersion=row.status_version,
            assignedAt=iso(row.assigned_at),
            acknowledgedAt=iso(row.acknowledged_at),
            completedAt=iso(row.completed_at),
            ignoredAt=iso(row.ignored_at),
            leftAt=iso(row.left_at),
            reviewedAt=iso(row.reviewed_at),
            review=review,
            reviewRating=row.review_rating,
        )


@router.get("/tasks/assigned", response_model=list[StickyTaskDTO])
async def assigned(
    principal: Principal = PrincipalDep,
    limit: int = LimitQuery,
    offset: int = OffsetQuery,
) -> list[StickyTaskDTO]:
    """All tasks assigned to me, any status (frontend buckets into the views)."""
    return await _sticky_list(
        principal,
        ("SENT", "ACKNOWLEDGED", "IGNORED", "COMPLETED", "LEFT"),
        limit=limit,
        offset=offset,
    )


# ── Sent (caller as sender) ─────────────────────────────────────────────────────
@router.get("/tasks/sent", response_model=list[SentTaskDTO])
async def sent(
    principal: Principal = PrincipalDep,
    limit: int = LimitQuery,
    offset: int = OffsetQuery,
) -> list[SentTaskDTO]:
    async with session() as db:
        # RLS: scope this transaction to the caller's org before any read.
        await set_org_context(db, principal.org_id)
        # Paginate by task (the unit a caller sees), not by assignee row, so a
        # single task's assignees never get split across pages. We page the
        # distinct task ids, then hydrate each with all its assignee rows.
        task_rows = (
            await db.execute(
                text(
                    "SELECT t.id FROM tasks t "
                    "WHERE t.org_id = :org AND t.sender_id = :me "
                    "      AND EXISTS ("
                    "          SELECT 1 FROM task_assignees ta "
                    "          WHERE ta.task_id = t.id AND ta.sender_dismissed = false"
                    "      ) "
                    "ORDER BY t.created_at DESC "
                    "LIMIT :limit OFFSET :offset"
                ),
                {
                    "org": principal.org_id,
                    "me": principal.user_id,
                    "limit": limit,
                    "offset": offset,
                },
            )
        ).all()
        task_ids = [str(r.id) for r in task_rows]
        if not task_ids:
            return []

        rows = (
            await db.execute(
                text(
                    "SELECT t.id, t.org_id, t.title_enc, t.description_enc, t.created_at, "
                    "       ta.assignee_id, ta.status, "
                    "       ta.assigned_at, ta.acknowledged_at, ta.completed_at, "
                    "       ta.ignored_at, ta.left_at, ta.reviewed_at, "
                    "       ta.review_enc, ta.review_rating, "
                    "       COALESCE(up.username, '') AS assignee_username "
                    "FROM tasks t "
                    "JOIN task_assignees ta ON ta.task_id = t.id "
                    "LEFT JOIN user_projection up "
                    "       ON up.user_id = ta.assignee_id AND up.org_id = ta.org_id "
                    "WHERE t.org_id = :org AND t.sender_id = :me "
                    "      AND ta.sender_dismissed = false "
                    "      AND t.id = ANY(:tids) "
                    "ORDER BY t.created_at DESC, ta.assigned_at ASC"
                ),
                {"org": principal.org_id, "me": principal.user_id, "tids": task_ids},
            )
        ).all()

        by_task: dict[str, SentTaskDTO] = {}
        order: list[str] = []
        for r in rows:
            tid = str(r.id)
            org = str(r.org_id)
            if tid not in by_task:
                by_task[tid] = SentTaskDTO(
                    taskId=tid,
                    title=await cryptor().decrypt(db, org, r.title_enc) or "",
                    description=await cryptor().decrypt(db, org, r.description_enc) or "",
                    createdAt=iso(r.created_at),
                    assignees=[],
                )
                order.append(tid)
            review = (
                await cryptor().decrypt(db, org, r.review_enc)
                if r.review_enc is not None
                else None
            )
            by_task[tid].assignees.append(
                SentAssignee(
                    assigneeId=str(r.assignee_id),
                    assigneeUsername=r.assignee_username,
                    status=r.status,
                    assignedAt=iso(r.assigned_at),
                    acknowledgedAt=iso(r.acknowledged_at),
                    completedAt=iso(r.completed_at),
                    ignoredAt=iso(r.ignored_at),
                    leftAt=iso(r.left_at),
                    reviewedAt=iso(r.reviewed_at),
                    review=review,
                    reviewRating=r.review_rating,
                )
            )
    return [by_task[t] for t in order]
