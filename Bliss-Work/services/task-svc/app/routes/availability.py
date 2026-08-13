from __future__ import annotations

import uuid as uuidlib

from fastapi import APIRouter, Request, Response, status
from sqlalchemy import text

from ..auth import OrgAdminDep, Principal, PrincipalDep
from ..db import session, set_org_context
from ..rate_limit import limiter
from ..schemas import AvailabilityCount, AvailabilityDTO, HideUserRequest

router = APIRouter()


@router.get("/tasks/availability", response_model=AvailabilityDTO)
async def availability(principal: Principal = PrincipalDep) -> AvailabilityDTO:
    """Per-user open-workload counts for the caller's org + the admin-hidden set.

    Deliberately returns COUNTS ONLY, not a member list: the authoritative org
    directory lives in auth-svc (/auth/directory), while this service's
    user_projection is a partial mirror carrying only name and an `active` flag —
    no roles, no email. The client joins these counts onto the directory it
    already caches and treats an absent user as 0/0 — so a brand-new hire with no
    task history shows up as Available immediately. Suspended and removed members
    drop out on their own, because /auth/directory no longer lists them.

    Available = acknowledged == 0. SENT rows do NOT consume availability (an
    allocation nobody has picked up isn't committed work) but are surfaced as a
    hint so the allocator knows work is already queued for that person.
    """
    async with session() as db:
        # RLS: bind the org context before any statement or the policy fails closed.
        await set_org_context(db, principal.org_id)
        # Pruning to the two open statuses BEFORE aggregating bounds the result
        # at "people with open work" rather than "everyone who ever received a
        # task", and keeps the (org_id, assignee_id, status) index covering — no
        # heap access, no decrypt, no join. Cheap enough for the 30s client poll.
        rows = (
            await db.execute(
                text(
                    "SELECT assignee_id, "
                    "       COUNT(*) FILTER (WHERE status = 'ACKNOWLEDGED') AS acked, "
                    "       COUNT(*) FILTER (WHERE status = 'SENT')         AS pending "
                    "FROM task_assignees "
                    "WHERE org_id = :org AND status IN ('SENT', 'ACKNOWLEDGED') "
                    "GROUP BY assignee_id"
                ),
                {"org": principal.org_id},
            )
        ).all()
        hidden = (
            await db.execute(
                text("SELECT user_id FROM availability_hidden WHERE org_id = :org"),
                {"org": principal.org_id},
            )
        ).all()

    # No pagination anywhere in this handler: the row count is bounded by org
    # headcount, and a PARTIAL counts map would silently mark busy people as
    # available — a wrong answer is worse than a big one here.
    return AvailabilityDTO(
        counts=[
            AvailabilityCount(userId=str(r.assignee_id), acknowledged=r.acked, pending=r.pending)
            for r in rows
        ],
        hiddenUserIds=[str(h.user_id) for h in hidden],
        canManage="org_admin" in principal.roles,
    )


@router.post("/tasks/availability/hidden", status_code=status.HTTP_204_NO_CONTENT)
@limiter.limit("60/minute")
async def hide_user(
    request: Request,
    response: Response,  # required by slowapi (headers_enabled) to inject rate-limit headers
    body: HideUserRequest,
    principal: Principal = OrgAdminDep,
) -> Response:
    """Admin-only: hide a user from the Available roster, org-wide. Idempotent.

    An admin may hide members, other admins, or themselves — deliberately no
    exemptions; this is org curation (hiding a contractor or an exec who isn't
    allocatable through this board), not a permission.

    The target id is NOT checked against a member list: user_projection is
    partial, so rejecting an unknown id would reject legitimate members. A bogus
    id is inert — the client intersects this set with the directory and it never
    renders.
    """
    async with session() as db:
        await set_org_context(db, principal.org_id)
        await db.execute(
            text(
                "INSERT INTO availability_hidden (org_id, user_id, hidden_by) "
                "VALUES (:org, :uid, :by) ON CONFLICT (org_id, user_id) DO NOTHING"
            ),
            {"org": principal.org_id, "uid": body.userId, "by": principal.user_id},
        )
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/tasks/availability/hidden/{user_id}", status_code=status.HTTP_204_NO_CONTENT
)
@limiter.limit("60/minute")
async def unhide_user(
    request: Request,
    response: Response,
    user_id: uuidlib.UUID,  # typed so a junk path value is a clean 422, not a PG cast error
    principal: Principal = OrgAdminDep,
) -> Response:
    """Admin-only: restore a hidden user to the roster. Idempotent — no 404 when
    the user wasn't hidden, so a double-click can't surface a spurious error."""
    async with session() as db:
        await set_org_context(db, principal.org_id)
        await db.execute(
            text("DELETE FROM availability_hidden WHERE org_id = :org AND user_id = :uid"),
            {"org": principal.org_id, "uid": str(user_id)},
        )
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
