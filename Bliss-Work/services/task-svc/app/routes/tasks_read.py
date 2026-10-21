from __future__ import annotations

import asyncio

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
# A sender never sees an assignee who ignored the task (Ignore sets
# sender_dismissed) unless they ask: TasksList, Search and mobile rely on that
# default, while My Tasks opts in so its Ignored filter has rows to show.
IncludeIgnoredQuery = Query(default=False, alias="includeIgnored")


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
                    "SELECT t.id, t.org_id, t.title_enc, t.description_enc, t.project_id, t.sender_id, "
                    "       ta.status, ta.status_version, ta.assigned_at, ta.acknowledged_at, "
                    "       ta.completed_at, ta.ignored_at, ta.left_at, ta.reviewed_at, "
                    "       ta.review_enc, ta.review_rating, ta.missed_at, t.deadline_at, "
                    "       COALESCE(up.username, '') AS sender_username, "
                    "       COALESCE(up.display_name, '') AS sender_display_name, "
                    "       (SELECT tc.channel_id FROM task_channels tc "
                    "          WHERE tc.task_id = t.id AND tc.org_id = t.org_id "
                    "          ORDER BY tc.created_at, tc.channel_id LIMIT 1) AS channel_id, "
                    "       COALESCE((SELECT json_agg(json_build_object("
                    "         'userId', p.assignee_id, 'username', COALESCE(pu.username, ''), "
                    "         'displayName', COALESCE(pu.display_name, ''), 'status', p.status) "
                    "         ORDER BY p.assigned_at, p.assignee_id) "
                    "         FROM task_assignees p LEFT JOIN user_projection pu "
                    "           ON pu.user_id = p.assignee_id AND pu.org_id = p.org_id "
                    "         WHERE p.task_id = ta.task_id AND p.org_id = ta.org_id), '[]'::json) AS participants "
                    "FROM task_assignees ta "
                    "JOIN tasks t ON t.id = ta.task_id "
                    "LEFT JOIN user_projection up "
                    "       ON up.user_id = t.sender_id AND up.org_id = t.org_id "
                    f"WHERE ta.org_id = :org AND ta.assignee_id = :me AND ta.status IN ({placeholders}) "
                    # task_id breaks ties: a bulk assignment shares one assigned_at, and
                    # without a total order OFFSET pages skip or repeat rows.
                    "ORDER BY ta.assigned_at DESC, ta.task_id DESC "
                    "LIMIT :limit OFFSET :offset"
                ),
                params,
            )
        ).all()

        # Collect every ciphertext this response needs (title, description,
        # review per row) and warm the DEK version(s) they reference while the
        # connection is still open — the only DB-touching step of decryption,
        # and a no-op on the (normal) case of an already-warm per-org cache.
        ciphertexts: list[bytes | None] = []
        for r in rows:
            ciphertexts.extend([r.title_enc, r.description_enc, r.review_enc])
        org = principal.org_id  # every row is org-scoped identically by the WHERE clause above
        versions = {v for v in (cryptor().peek_version(b) for b in ciphertexts) if v is not None}
        await cryptor().warm_dek_versions(db, org, versions)
    # Connection released here (exited `async with`) BEFORE the CPU-bound
    # decrypt runs. Previously this loop ran up to 100 sequential
    # `await cryptor().decrypt()` calls inside the connection scope; on a warm
    # cache those never actually suspend, so they blocked this process's
    # single asyncio event loop — and held a scarce DB-pool connection idle —
    # for the whole loop. One bounded `asyncio.to_thread` call replaces both:
    # see crypto.py's decrypt_batch_cached for why this preserves exact
    # decrypt() semantics (format, key selection, AAD, error type, encoding).
    plaintexts = await asyncio.to_thread(cryptor().decrypt_batch_cached, org, ciphertexts)

    out: list[StickyTaskDTO] = []
    for i, r in enumerate(rows):
        title, description, review = plaintexts[3 * i], plaintexts[3 * i + 1], plaintexts[3 * i + 2]
        out.append(
            StickyTaskDTO(
                taskId=str(r.id),
                orgId=str(r.org_id),
                title=title or "",
                description=description or "",
                projectId=str(r.project_id) if r.project_id is not None else None,
                channelId=str(r.channel_id) if r.channel_id is not None else None,
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
                deadlineAt=iso(r.deadline_at),
                missedAt=iso(r.missed_at),
                participants=r.participants or [],
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
                    "SELECT t.id, t.org_id, t.title_enc, t.description_enc, t.project_id, t.sender_id, "
                    "       ta.status, ta.status_version, ta.assigned_at, ta.acknowledged_at, "
                    "       ta.completed_at, ta.ignored_at, ta.left_at, ta.reviewed_at, "
                    "       ta.review_enc, ta.review_rating, ta.missed_at, t.deadline_at, "
                    "       COALESCE(up.username, '') AS sender_username, "
                    "       COALESCE(up.display_name, '') AS sender_display_name, "
                    "       (SELECT tc.channel_id FROM task_channels tc "
                    "          WHERE tc.task_id = t.id AND tc.org_id = t.org_id "
                    "          ORDER BY tc.created_at, tc.channel_id LIMIT 1) AS channel_id, "
                    "       COALESCE((SELECT json_agg(json_build_object("
                    "         'userId', p.assignee_id, 'username', COALESCE(pu.username, ''), "
                    "         'displayName', COALESCE(pu.display_name, ''), 'status', p.status) "
                    "         ORDER BY p.assigned_at, p.assignee_id) "
                    "         FROM task_assignees p LEFT JOIN user_projection pu "
                    "           ON pu.user_id = p.assignee_id AND pu.org_id = p.org_id "
                    "         WHERE p.task_id = ta.task_id AND p.org_id = ta.org_id), '[]'::json) AS participants "
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
            projectId=str(row.project_id) if row.project_id is not None else None,
            channelId=str(row.channel_id) if row.channel_id is not None else None,
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
            deadlineAt=iso(row.deadline_at),
            missedAt=iso(row.missed_at),
            participants=row.participants or [],
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
        ("SENT", "ACKNOWLEDGED", "IGNORED", "COMPLETED", "LEFT", "MISSED"),
        limit=limit,
        offset=offset,
    )


# ── Sent (caller as sender) ─────────────────────────────────────────────────────
@router.get("/tasks/sent", response_model=list[SentTaskDTO])
async def sent(
    principal: Principal = PrincipalDep,
    limit: int = LimitQuery,
    offset: int = OffsetQuery,
    include_ignored: bool = IncludeIgnoredQuery,
) -> list[SentTaskDTO]:
    async with session() as db:
        # RLS: scope this transaction to the caller's org before any read.
        await set_org_context(db, principal.org_id)
        # Paginate by task (the unit a caller sees), not by assignee row, so a
        # single task's assignees never get split across pages. We page the
        # distinct task ids, then hydrate each with all its assignee rows.
        # Ordered by (created_at, id): tasks created in one transaction share a
        # created_at, and without the id tiebreaker OFFSET paging could skip or
        # repeat them between pages.
        task_rows = (
            await db.execute(
                text(
                    "SELECT t.id FROM tasks t "
                    "WHERE t.org_id = :org AND t.sender_id = :me "
                    "      AND EXISTS ("
                    "          SELECT 1 FROM task_assignees ta "
                    "          WHERE ta.task_id = t.id "
                    "                AND (:include_ignored OR ta.sender_dismissed = false)"
                    "      ) "
                    "ORDER BY t.created_at DESC, t.id DESC "
                    "LIMIT :limit OFFSET :offset"
                ),
                {
                    "org": principal.org_id,
                    "me": principal.user_id,
                    "limit": limit,
                    "offset": offset,
                    "include_ignored": include_ignored,
                },
            )
        ).all()
        task_ids = [str(r.id) for r in task_rows]
        if not task_ids:
            return []

        rows = (
            await db.execute(
                text(
                    "SELECT t.id, t.org_id, t.title_enc, t.description_enc, t.project_id, "
                    "t.created_at, t.deadline_at, "
                    "       ta.assignee_id, ta.status, "
                    "       ta.assigned_at, ta.acknowledged_at, ta.completed_at, "
                    "       ta.ignored_at, ta.left_at, ta.missed_at, ta.reviewed_at, "
                    "       ta.review_enc, ta.review_rating, "
                    "       COALESCE(up.username, '') AS assignee_username, "
                    "       COALESCE(up.display_name, '') AS assignee_display_name "
                    "FROM tasks t "
                    "JOIN task_assignees ta ON ta.task_id = t.id "
                    "LEFT JOIN user_projection up "
                    "       ON up.user_id = ta.assignee_id AND up.org_id = ta.org_id "
                    "WHERE t.org_id = :org AND t.sender_id = :me "
                    "      AND (:include_ignored OR ta.sender_dismissed = false) "
                    "      AND t.id = ANY(:tids) "
                    "ORDER BY t.created_at DESC, t.id DESC, ta.assigned_at ASC"
                ),
                {
                    "org": principal.org_id,
                    "me": principal.user_id,
                    "tids": task_ids,
                    "include_ignored": include_ignored,
                },
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
                    projectId=str(r.project_id) if r.project_id is not None else None,
                    deadlineAt=iso(r.deadline_at),
                    assignees=[],
                    participants=[],
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
                    missedAt=iso(r.missed_at),
                    reviewedAt=iso(r.reviewed_at),
                    review=review,
                    reviewRating=r.review_rating,
                )
            )
            by_task[tid].participants.append(
                {
                    "userId": str(r.assignee_id),
                    "username": r.assignee_username,
                    "displayName": r.assignee_display_name,
                    "status": r.status,
                }
            )
    return [by_task[t] for t in order]
