"""The user-facing read path: which task notes belong on my desktop.

Every handler sets the org context FIRST. RLS on sticky_pins is ENABLE + FORCE
and fails closed, so forgetting it returns zero rows rather than another org's —
a visible bug instead of a silent leak.
"""

from __future__ import annotations

from fastapi import APIRouter, Query, Response, status
from sqlalchemy import text

from ..auth import Principal, PrincipalDep
from ..db import session, set_org_context
from ..schemas import StickyPinDTO

router = APIRouter()

# Same bounds as task-svc's read endpoints: a capped LIMIT/OFFSET so an
# unbounded result set can't exhaust memory. The on-screen cap is far lower
# (five notes), so this is a safety rail, not a product limit.
_DEFAULT_LIMIT = 50
_MAX_LIMIT = 100

LimitQuery = Query(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT)
OffsetQuery = Query(default=0, ge=0)


def _iso(v) -> str | None:
    return v.isoformat().replace("+00:00", "Z") if v is not None else None


@router.get("/sticky/pins", response_model=list[StickyPinDTO])
async def list_pins(
    principal: Principal = PrincipalDep,
    limit: int = LimitQuery,
    offset: int = OffsetQuery,
) -> list[StickyPinDTO]:
    """Open pins for the caller — the authoritative "what should be stuck to my
    desktop" list.

    OPEN only. A closed pin is a task that was completed, ignored or left, and
    the whole point of this table is that nothing else takes a note away: there
    is no filter here for "dismissed", because no such state is stored.

    Ordered oldest-first, deliberately: when more commitments are outstanding
    than fit on screen, the ones that have been waiting longest are the ones to
    show.
    """
    async with session() as db:
        await set_org_context(db, principal.org_id)
        rows = (
            await db.execute(
                text(
                    "SELECT task_id, org_id, assignee_id, sender_id, assignee_status, "
                    "       status_version, opened_at, last_delivered_at "
                    "  FROM sticky_pins "
                    " WHERE org_id = :org AND assignee_id = :me AND status = 'OPEN' "
                    " ORDER BY opened_at ASC "
                    " LIMIT :limit OFFSET :offset"
                ),
                {
                    "org": principal.org_id,
                    "me": principal.user_id,
                    "limit": limit,
                    "offset": offset,
                },
            )
        ).all()

    return [
        StickyPinDTO(
            taskId=str(r.task_id),
            orgId=str(r.org_id),
            assigneeId=str(r.assignee_id),
            senderId=str(r.sender_id) if r.sender_id is not None else None,
            assigneeStatus=r.assignee_status,
            statusVersion=r.status_version,
            openedAt=_iso(r.opened_at) or "",
            lastDeliveredAt=_iso(r.last_delivered_at),
        )
        for r in rows
    ]


@router.post("/sticky/pins/{task_id}/ack-delivery", status_code=status.HTTP_204_NO_CONTENT)
async def ack_delivery(task_id: str, principal: Principal = PrincipalDep) -> Response:
    """Confirm this note actually reached the user's screen.

    This is what closes the loop for sticky-relay: an OPEN pin with a NULL
    `last_delivered_at` is one the server has no evidence anyone ever saw, which
    is the only case worth nudging about. Without this the watchdog would keep
    re-nudging a note that has been sitting on the desktop all along.

    Idempotent, and scoped to the caller's own pins — 204 whether or not a row
    matched, because "there is no such pin" and "it is already acknowledged" are
    both fine outcomes for the client and neither is worth an error path.
    """
    async with session() as db:
        await set_org_context(db, principal.org_id)
        await db.execute(
            text(
                "UPDATE sticky_pins SET last_delivered_at = now() "
                " WHERE org_id = :org AND assignee_id = :me AND task_id = :task "
                "   AND status = 'OPEN'"
            ),
            {"org": principal.org_id, "me": principal.user_id, "task": task_id},
        )
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Deliberately absent: DELETE /sticky/pins/{task_id} ───────────────────────
# There is no server-side unpin, and adding one would recreate the bug this
# service exists to prevent. A pin closes when task-svc says the task reached a
# terminal status, and at no other time. Taking a note off screen is a local,
# this-session choice the client makes and forgets on restart.
