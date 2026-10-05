"""The user-facing pin API: which task notes belong on my desktop, and letting
me pin / unpin one.

Every handler sets the org context FIRST. RLS on sticky_pins is ENABLE + FORCE
and fails closed, so forgetting it returns zero rows rather than another org's —
a visible bug instead of a silent leak.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status
from sqlalchemy import text

from ..auth import Principal, PrincipalDep
from ..db import session, set_org_context
from ..events import enqueue, pin_changed
from ..schemas import PinStateDTO, StickyPinDTO
from ..transitions import (
    CHANGED,
    CLOSED,
    CLOSED_OUTCOME,
    PINNED,
    UNPINNED,
    plan_user_pin,
)

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
    # Annotated, so calling the handler directly (as the tests do) gets False
    # rather than a FastAPI Query object.
    include_unpinned: Annotated[bool, Query(alias="includeUnpinned")] = False,
) -> list[StickyPinDTO]:
    """Open pins for the caller — the authoritative "what should be stuck to my
    desktop" list.

    OPEN only: a closed pin is a task that was completed, ignored or left, and
    only that closes one.

    By default also PINNED only. That default is what keeps every client that
    predates the pin API correct: it treats every row as "float this", so an
    UNPINNED row must not be in its answer. A client that understands the pin
    state asks with `includeUnpinned=true` and gets those rows too, each
    carrying `pinState`, so it can tell "the user took this off their desktop"
    from "this was never pinned" — and render the right control for either.

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
                    "       status_version, opened_at, last_delivered_at, "
                    "       pin_state, pin_state_updated_at "
                    "  FROM sticky_pins "
                    " WHERE org_id = :org AND assignee_id = :me AND status = 'OPEN' "
                    "   AND (:all OR pin_state = 'PINNED') "
                    # task_id breaks ties so OFFSET pages neither skip nor repeat pins
                    # opened in the same instant.
                    " ORDER BY opened_at ASC, task_id ASC "
                    " LIMIT :limit OFFSET :offset"
                ),
                {
                    "org": principal.org_id,
                    "me": principal.user_id,
                    "all": include_unpinned,
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
            pinState=r.pin_state,
            pinStateUpdatedAt=_iso(r.pin_state_updated_at),
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


async def _set_pin_state(principal: Principal, task_id: uuid.UUID, want: str) -> PinStateDTO:
    """Pin (`PINNED`) or unpin (`UNPINNED`) one of the caller's own tasks.

    Authorization is the row itself. sticky_pins holds a row only for a user the
    task was ASSIGNED to (the consumer creates it from task.assigned), and the
    lookup is keyed on the caller's verified identity — org and user both come
    from the token, never from the request — under RLS. So a task that is not
    the caller's, is in another org, or does not exist all look the same: 404.

    Idempotent by construction: the request names a TARGET state, not a toggle,
    so a retry that lands twice leaves the same state and emits one event. The
    row is locked for the read-modify-write so two racing requests serialise
    instead of both seeing the old state and both emitting.
    """
    task = str(task_id)
    async with session() as db:
        await set_org_context(db, principal.org_id)
        row = (
            await db.execute(
                text(
                    "SELECT status, pin_state, pin_state_updated_at FROM sticky_pins "
                    " WHERE org_id = :org AND assignee_id = :me AND task_id = :task "
                    " FOR UPDATE"
                ),
                {"org": principal.org_id, "me": principal.user_id, "task": task},
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail="task not found")

        outcome = plan_user_pin(row.status, row.pin_state, want)

        if outcome == CLOSED_OUTCOME:
            # A finished commitment. Pinning it would float a note for work that
            # is done; unpinning it is already true, so DELETE stays idempotent.
            if want == PINNED:
                raise HTTPException(status_code=409, detail="task is no longer open")
            return PinStateDTO(
                taskId=task,
                state=CLOSED,
                pinState=row.pin_state,
                status=row.status,
                updatedAt=_iso(row.pin_state_updated_at) or "",
            )

        updated_at = row.pin_state_updated_at
        if outcome == CHANGED:
            updated_at = (
                await db.execute(
                    text(
                        "UPDATE sticky_pins SET "
                        "  pin_state = :want, "
                        "  pin_state_updated_at = now(), "
                        # A re-pinned note has not been delivered in its new
                        # life, so the watchdog must be able to see it again —
                        # the same reset a reassignment gets in the consumer.
                        "  last_delivered_at = CASE WHEN :repin THEN NULL "
                        "                          ELSE last_delivered_at END, "
                        "  delivery_attempts = CASE WHEN :repin THEN 0 "
                        "                          ELSE delivery_attempts END, "
                        "  next_eligible_at = CASE WHEN :repin THEN now() "
                        "                          ELSE next_eligible_at END "
                        " WHERE org_id = :org AND assignee_id = :me AND task_id = :task "
                        "RETURNING pin_state_updated_at"
                    ),
                    {
                        "want": want,
                        "repin": want == PINNED,
                        "org": principal.org_id,
                        "me": principal.user_id,
                        "task": task,
                    },
                )
            ).scalar_one()
            # Same transaction as the state change: it commits together or not
            # at all, so a committed pin can never lose its event.
            await enqueue(
                db,
                pin_changed(
                    org_id=principal.org_id,
                    assignee_id=principal.user_id,
                    task_id=task,
                    pin_state=want,
                ),
                key=principal.user_id,
            )
        await db.commit()

    return PinStateDTO(
        taskId=task,
        state=want,
        pinState=want,
        status=row.status,
        updatedAt=_iso(updated_at) or "",
    )


@router.put("/sticky/pins/{task_id}", response_model=PinStateDTO)
async def pin_task(task_id: uuid.UUID, principal: Principal = PrincipalDep) -> PinStateDTO:
    """Pin — or RE-pin — a task. Repeating it leaves it pinned."""
    return await _set_pin_state(principal, task_id, PINNED)


@router.delete("/sticky/pins/{task_id}", response_model=PinStateDTO)
async def unpin_task(task_id: uuid.UUID, principal: Principal = PrincipalDep) -> PinStateDTO:
    """Unpin a task: its note leaves every one of the caller's devices.

    This records the USER's choice and nothing else. It does not close the
    commitment — the task stays assigned and actionable, and PUT brings the note
    back at any time. Only a terminal task status closes a pin; the two are kept
    apart on purpose (see app/transitions.py). Repeating it leaves it unpinned.
    """
    return await _set_pin_state(principal, task_id, UNPINNED)
