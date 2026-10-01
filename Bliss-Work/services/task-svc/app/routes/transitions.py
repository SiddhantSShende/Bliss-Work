from __future__ import annotations

from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from .. import events
from ..auth import Principal, PrincipalDep
from ..db import session, set_org_context
from ..deadlines import NOT_PAST_DEADLINE, expire_if_due
from ..schemas import TransitionResponse
from .helpers import current_assignee, enqueue_outbox, resolve_username, task_sender

router = APIRouter()


async def _missed_by_deadline(db, task_id: str, current) -> bool:
    """Tail of a failed transition: was it refused because the deadline passed?

    The UPDATEs below carry NOT_PAST_DEADLINE, so an action that arrives after the
    deadline matches nothing — even in the window before the sweeper's next poll.
    When that is why, resolve it the way the sweeper would (the assignment becomes
    MISSED, with its event) and commit, so the caller can answer 409 and the
    client's refetch shows the task in Missed. Runs BEFORE the caller's rollback,
    which would clear the transaction-scoped org context RLS depends on.
    """
    if current is None or current.status not in ("SENT", "ACKNOWLEDGED"):
        return False
    if not await expire_if_due(db, task_id):
        return False
    await db.commit()
    return True


@router.post("/tasks/{task_id}/assignees/me/acknowledge", response_model=TransitionResponse)
async def acknowledge(task_id: str, principal: Principal = PrincipalDep) -> TransitionResponse:
    org_id, me = principal.org_id, principal.user_id
    async with session() as db:
        # RLS: bind the org context first so the assignee lookup, the status
        # UPDATE (... WITH CHECK), task_sender and resolve_username all stay
        # scoped to this org.
        await set_org_context(db, org_id)
        current = await current_assignee(db, org_id, task_id, me)
        if current is None:
            raise HTTPException(status_code=404, detail="assignment not found")

        res = await db.execute(
            text(
                "UPDATE task_assignees "
                "SET status = 'ACKNOWLEDGED', status_version = status_version + 1, "
                "    acknowledged_at = now() "
                "WHERE org_id = :org AND task_id = :tid AND assignee_id = :me AND status = 'SENT' "
                f"{NOT_PAST_DEADLINE} "
                "RETURNING status, status_version"
            ),
            {"org": org_id, "tid": task_id, "me": me},
        )
        updated = res.first()
        if updated is None:
            # Re-fetch rather than trust `current` above, which was read
            # BEFORE this UPDATE was attempted: under a duplicate concurrent
            # request (double-click, or a client retry after a dropped
            # response) the other request's UPDATE can commit in the gap
            # between our pre-read and this CAS attempt. Deciding
            # idempotent-success vs. conflict from the stale pre-read would
            # then report a spurious 409 for a request that actually
            # succeeded.
            #
            # Must run BEFORE db.rollback(): app.org_id is bound with
            # set_config(..., is_local=true) — transaction-scoped — so rolling
            # back first clears the RLS context and this query would silently
            # see no rows (404) instead of the real, current status. READ
            # COMMITTED (Postgres's default, unchanged here) re-takes its
            # snapshot per statement, so this still-open transaction sees the
            # other request's commit without needing to roll back first.
            current = await current_assignee(db, org_id, task_id, me)
            if await _missed_by_deadline(db, task_id, current):
                raise HTTPException(status_code=409, detail="the task's deadline has passed")
            await db.rollback()
            if current is None:
                raise HTTPException(status_code=404, detail="assignment not found")
            if current.status == "ACKNOWLEDGED":
                # Idempotent: already acknowledged, emit nothing.
                return TransitionResponse(status=current.status, statusVersion=current.status_version)
            raise HTTPException(status_code=409, detail=f"cannot acknowledge from {current.status}")

        sender_id = await task_sender(db, org_id, task_id) or me
        assignee_username = await resolve_username(db, org_id, me) or principal.username
        evt = events.task_acknowledged(
            org_id=org_id, task_id=task_id, assignee_id=me, sender_id=sender_id,
            status_version=updated.status_version, assignee_username=assignee_username,
        )
        await enqueue_outbox(db, events.TASK_TOPIC, task_id, evt)
        await db.commit()
        return TransitionResponse(status=updated.status, statusVersion=updated.status_version)


@router.post("/tasks/{task_id}/assignees/me/complete", response_model=TransitionResponse)
async def complete(task_id: str, principal: Principal = PrincipalDep) -> TransitionResponse:
    org_id, me = principal.org_id, principal.user_id
    async with session() as db:
        # RLS: bind the org context first so the assignee lookup, the status
        # UPDATE (... WITH CHECK), task_sender and resolve_username all stay
        # scoped to this org.
        await set_org_context(db, org_id)
        current = await current_assignee(db, org_id, task_id, me)
        if current is None:
            raise HTTPException(status_code=404, detail="assignment not found")

        res = await db.execute(
            text(
                "UPDATE task_assignees "
                "SET status = 'COMPLETED', status_version = status_version + 1, "
                "    completed_at = now() "
                "WHERE org_id = :org AND task_id = :tid AND assignee_id = :me "
                "      AND status = 'ACKNOWLEDGED' "
                f"{NOT_PAST_DEADLINE} "
                "RETURNING status, status_version"
            ),
            {"org": org_id, "tid": task_id, "me": me},
        )
        updated = res.first()
        if updated is None:
            # See acknowledge()'s comment on this same pattern: re-fetch
            # BEFORE rollback (which clears the transaction-scoped app.org_id
            # RLS context), or this would silently see no rows instead of the
            # real status.
            current = await current_assignee(db, org_id, task_id, me)
            if await _missed_by_deadline(db, task_id, current):
                raise HTTPException(status_code=409, detail="the task's deadline has passed")
            await db.rollback()
            if current is None:
                raise HTTPException(status_code=404, detail="assignment not found")
            if current.status == "COMPLETED":
                return TransitionResponse(status=current.status, statusVersion=current.status_version)
            raise HTTPException(status_code=409, detail=f"cannot complete from {current.status}")

        sender_id = await task_sender(db, org_id, task_id) or me
        assignee_username = await resolve_username(db, org_id, me) or principal.username
        evt = events.task_completed(
            org_id=org_id, task_id=task_id, assignee_id=me, sender_id=sender_id,
            status_version=updated.status_version, assignee_username=assignee_username,
        )
        await enqueue_outbox(db, events.TASK_TOPIC, task_id, evt)
        await db.commit()
        return TransitionResponse(status=updated.status, statusVersion=updated.status_version)


@router.post("/tasks/{task_id}/assignees/me/ignore", response_model=TransitionResponse)
async def ignore(task_id: str, principal: Principal = PrincipalDep) -> TransitionResponse:
    org_id, me = principal.org_id, principal.user_id
    async with session() as db:
        # RLS: bind the org context first so the assignee lookup, the status
        # UPDATE (... WITH CHECK), task_sender and resolve_username all stay
        # scoped to this org.
        await set_org_context(db, org_id)
        current = await current_assignee(db, org_id, task_id, me)
        if current is None:
            raise HTTPException(status_code=404, detail="assignment not found")

        res = await db.execute(
            text(
                "UPDATE task_assignees "
                "SET status = 'IGNORED', status_version = status_version + 1, "
                "    sender_dismissed = true, ignored_at = now() "
                "WHERE org_id = :org AND task_id = :tid AND assignee_id = :me AND status = 'SENT' "
                f"{NOT_PAST_DEADLINE} "
                "RETURNING status, status_version"
            ),
            {"org": org_id, "tid": task_id, "me": me},
        )
        updated = res.first()
        if updated is None:
            # See acknowledge()'s comment on this same pattern: re-fetch
            # BEFORE rollback (which clears the transaction-scoped app.org_id
            # RLS context), or this would silently see no rows instead of the
            # real status.
            current = await current_assignee(db, org_id, task_id, me)
            if await _missed_by_deadline(db, task_id, current):
                raise HTTPException(status_code=409, detail="the task's deadline has passed")
            await db.rollback()
            if current is None:
                raise HTTPException(status_code=404, detail="assignment not found")
            if current.status == "IGNORED":
                return TransitionResponse(status=current.status, statusVersion=current.status_version)
            raise HTTPException(status_code=409, detail=f"cannot ignore from {current.status}")

        sender_id = await task_sender(db, org_id, task_id) or me
        assignee_username = await resolve_username(db, org_id, me) or principal.username
        evt = events.task_ignored(
            org_id=org_id, task_id=task_id, assignee_id=me, sender_id=sender_id,
            status_version=updated.status_version, assignee_username=assignee_username,
        )
        await enqueue_outbox(db, events.TASK_TOPIC, task_id, evt)
        await db.commit()
        return TransitionResponse(status=updated.status, statusVersion=updated.status_version)


@router.post("/tasks/{task_id}/assignees/me/leave", response_model=TransitionResponse)
async def leave(task_id: str, principal: Principal = PrincipalDep) -> TransitionResponse:
    org_id, me = principal.org_id, principal.user_id
    async with session() as db:
        # RLS: bind the org context first so the assignee lookup, the status
        # UPDATE (... WITH CHECK), task_sender and resolve_username all stay
        # scoped to this org.
        await set_org_context(db, org_id)
        current = await current_assignee(db, org_id, task_id, me)
        if current is None:
            raise HTTPException(status_code=404, detail="assignment not found")

        res = await db.execute(
            text(
                "UPDATE task_assignees "
                "SET status = 'LEFT', status_version = status_version + 1, left_at = now() "
                "WHERE org_id = :org AND task_id = :tid AND assignee_id = :me "
                "      AND status = 'ACKNOWLEDGED' "
                f"{NOT_PAST_DEADLINE} "
                "RETURNING status, status_version"
            ),
            {"org": org_id, "tid": task_id, "me": me},
        )
        updated = res.first()
        if updated is None:
            # See acknowledge()'s comment on this same pattern: re-fetch
            # BEFORE rollback (which clears the transaction-scoped app.org_id
            # RLS context), or this would silently see no rows instead of the
            # real status.
            current = await current_assignee(db, org_id, task_id, me)
            if await _missed_by_deadline(db, task_id, current):
                raise HTTPException(status_code=409, detail="the task's deadline has passed")
            await db.rollback()
            if current is None:
                raise HTTPException(status_code=404, detail="assignment not found")
            if current.status == "LEFT":
                return TransitionResponse(status=current.status, statusVersion=current.status_version)
            raise HTTPException(status_code=409, detail=f"cannot leave from {current.status}")

        sender_id = await task_sender(db, org_id, task_id) or me
        assignee_username = await resolve_username(db, org_id, me) or principal.username
        evt = events.task_left(
            org_id=org_id, task_id=task_id, assignee_id=me, sender_id=sender_id,
            status_version=updated.status_version, assignee_username=assignee_username,
        )
        await enqueue_outbox(db, events.TASK_TOPIC, task_id, evt)
        await db.commit()
        return TransitionResponse(status=updated.status, statusVersion=updated.status_version)
