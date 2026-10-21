"""`POST /tasks/{id}/reassign` — put a Completed, Left, or Ignored task back in
front of the people it was last with.

A task is sometimes marked Completed while the work is not actually finished, or
someone leaves or ignores a task that still needs doing. The allocator reopens it
without picking anyone: every assignment that is COMPLETED goes back to SENT, for
the same person, on the same row. The same happens when every assignee shares one
of the other terminal outcomes (LEFT, or IGNORED) — the whole task is handed back
to exactly the people who had it. A task where some assignees completed while
others left/ignored/missed only reopens the completed ones; the individual
outcomes of the rest stand (they made, or were handed, that outcome themselves).

What changes, per reopened assignment: status -> SENT, `status_version` + 1 (the
counter only ever goes up, so sticky-svc's version guard keeps working), `assigned_at`
-> now (it is a fresh allocation: it sorts to the top of the assignee's inbox), and
the per-lifecycle stamps `acknowledged_at` / `completed_at` are cleared so the row
describes the commitment that is open now. The earlier outcome is not lost: its
`task.completed`/`task.left`/`task.ignored` event stays in the event log and the
telemetry activity record, and the allocator's review (`review_enc`, `review_rating`,
`reviewed_at`) is left alone.

Everything downstream already knows what to do with a `task.assigned` for an
assignment it has seen before — sticky-svc reopens the closed pin, notification-svc
notifies the assignee, ws-gateway fans it out, telemetry records the allocator's act
— so that is the event emitted; there is no second event type to teach them.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from crypto import cryptor
from .. import events
from ..auth import Principal, PrincipalDep
from ..db import session, set_org_context
from ..logging_setup import log
from ..projects import sync_assignees_to_project_channel
from .helpers import enqueue_outbox, resolve_username
from .participants import _task_context

router = APIRouter()
_ACTIVE = ("SENT", "ACKNOWLEDGED")
# A whole task sharing one of these outcomes, with nobody still active, is handed
# back in full. COMPLETED is handled on its own below because it can coexist with
# other terminal outcomes (that mix is still a "completed" card) without reopening
# them; LEFT/IGNORED only reopen when EVERY row shares that same single outcome.
_WHOLE_TASK_REOPENABLE = ("LEFT", "IGNORED")
# A single member can be reassigned on their own, whatever the rest of the task
# is doing, as long as *their* row is one of these terminal outcomes. MISSED is
# left out on purpose: that is the deadline sweeper's outcome, and (same as the
# whole-task route) the deadline is not reopened from under it.
_MEMBER_REOPENABLE = ("COMPLETED", "LEFT", "IGNORED")


@router.post("/tasks/{task_id}/reassign")
async def reassign_task(task_id: str, principal: Principal = PrincipalDep) -> dict:
    org_id, me = principal.org_id, principal.user_id
    try:
        uuid.UUID(task_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc

    async with session() as db:
        await set_org_context(db, org_id)
        task = await _task_context(db, org_id, task_id)
        # Same rule as withdrawing a participant: this is the allocator's call. A
        # completed task has no active participant who could stand in for them.
        if str(task.sender_id) != me:
            raise HTTPException(status_code=403, detail="only the allocator can reassign a task")

        # Locked so two clicks (or two devices) serialise: the second one finds the
        # rows already SENT and is refused rather than reopening them twice.
        rows = (
            await db.execute(
                text(
                    "SELECT assignee_id, status FROM task_assignees "
                    "WHERE org_id = :org AND task_id = :tid FOR UPDATE"
                ),
                {"org": org_id, "tid": task_id},
            )
        ).all()
        # A task with anyone still on it is open — the same definition
        # add_participants uses — so there is nothing to reopen.
        if any(r.status in _ACTIVE for r in rows):
            raise HTTPException(status_code=409, detail="task is not completed")
        # COMPLETED always wins, however it is mixed with other terminal rows (that
        # mix is still a "completed" card, and only its completed rows come back).
        # Otherwise everyone has to share one of LEFT/IGNORED for the whole task to
        # be handed back; a mix of those (or MISSED, which stands even alone) is
        # not reopenable here. Either way exactly one status is reopened.
        row_statuses = {r.status for r in rows}
        if "COMPLETED" in row_statuses:
            reopen_status = "COMPLETED"
        elif len(row_statuses) == 1 and next(iter(row_statuses)) in _WHOLE_TASK_REOPENABLE:
            reopen_status = next(iter(row_statuses))
        else:
            reopen_status = None
        if reopen_status is None:
            raise HTTPException(status_code=409, detail="task has nothing to reassign")
        # Reopened work would already be late, and the deadline sweeper has run: it
        # would sit SENT with every action refused. The deadline is not ours to move.
        if task.past_deadline:
            raise HTTPException(status_code=409, detail="cannot reassign after the task's deadline")

        # Someone who left, ignored or missed the task made (or was handed) that
        # outcome themselves; reassignment does not override an outcome other than
        # `reopen_status`, and nobody is added or removed.
        reopened = (
            await db.execute(
                text(
                    "UPDATE task_assignees "
                    "SET status = 'SENT', status_version = status_version + 1, "
                    "    assigned_at = now(), acknowledged_at = NULL, completed_at = NULL "
                    "WHERE org_id = :org AND task_id = :tid AND status = :reopen_status "
                    "RETURNING assignee_id, status_version"
                ),
                {"org": org_id, "tid": task_id, "reopen_status": reopen_status},
            )
        ).all()
        # Deterministic event order, whatever order Postgres updated in.
        reopened.sort(key=lambda r: str(r.assignee_id))

        sender_id = str(task.sender_id)
        sender_username = await resolve_username(db, org_id, sender_id) or principal.username
        title = await cryptor().decrypt(db, org_id, task.title_enc) or ""
        description = await cryptor().decrypt(db, org_id, task.description_enc) or ""
        member_ids = list(dict.fromkeys([sender_id, *(str(r.assignee_id) for r in reopened)]))
        for r in reopened:
            await enqueue_outbox(
                db,
                events.TASK_TOPIC,
                task_id,
                events.task_assigned(
                    org_id=org_id,
                    task_id=task_id,
                    assignee_id=str(r.assignee_id),
                    sender_id=sender_id,
                    status_version=int(r.status_version),
                    sender_username=sender_username,
                    title=title,
                    description=description,
                    members=member_ids,
                ),
            )
        await db.commit()
        reassigned_ids = [str(r.assignee_id) for r in reopened]
        sync_failed = False
        if task.project_channel_id is not None and reassigned_ids:
            try:
                await sync_assignees_to_project_channel(
                    org_id, str(task.project_channel_id), me, reassigned_ids
                )
            except HTTPException as exc:
                sync_failed = True
                log.warning(
                    "task_reassign_project_channel_sync_failed",
                    task_id=task_id,
                    channel_id=str(task.project_channel_id),
                    status=exc.status_code,
                    detail=exc.detail,
                )
        response = {"taskId": task_id, "reassignedUserIds": reassigned_ids}
        if sync_failed:
            response["projectChannelSyncFailed"] = True
        return response


@router.post("/tasks/{task_id}/assignees/{assignee_id}/reassign")
async def reassign_member(task_id: str, assignee_id: str, principal: Principal = PrincipalDep) -> dict:
    """Hand just one member's row back to them, leaving every other assignee's
    status untouched and the task lifecycle exactly as active (or not) as it
    already was. For the scenario the whole-task route can't reach: someone
    ignored (or left, or completed) their part while others are still working
    the task, so the task is not eligible for `/reassign` yet — but that one
    person should not have to wait for the rest to finish."""
    org_id, me = principal.org_id, principal.user_id
    try:
        uuid.UUID(task_id)
        uuid.UUID(assignee_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc

    async with session() as db:
        await set_org_context(db, org_id)
        task = await _task_context(db, org_id, task_id)
        if str(task.sender_id) != me:
            raise HTTPException(status_code=403, detail="only the allocator can reassign a task")

        # Locked so two clicks (or two devices) serialise on this one row.
        row = (
            await db.execute(
                text(
                    "SELECT assignee_id, status FROM task_assignees "
                    "WHERE org_id = :org AND task_id = :tid AND assignee_id = :uid FOR UPDATE"
                ),
                {"org": org_id, "tid": task_id, "uid": assignee_id},
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail="assignee not found on this task")
        if row.status not in _MEMBER_REOPENABLE:
            raise HTTPException(status_code=409, detail="member has nothing to reassign")
        if task.past_deadline:
            raise HTTPException(status_code=409, detail="cannot reassign after the task's deadline")

        reopened = (
            await db.execute(
                text(
                    "UPDATE task_assignees "
                    "SET status = 'SENT', status_version = status_version + 1, "
                    "    assigned_at = now(), acknowledged_at = NULL, completed_at = NULL "
                    "WHERE org_id = :org AND task_id = :tid AND assignee_id = :uid "
                    "RETURNING assignee_id, status_version"
                ),
                {"org": org_id, "tid": task_id, "uid": assignee_id},
            )
        ).one()

        sender_id = str(task.sender_id)
        sender_username = await resolve_username(db, org_id, sender_id) or principal.username
        title = await cryptor().decrypt(db, org_id, task.title_enc) or ""
        description = await cryptor().decrypt(db, org_id, task.description_enc) or ""
        all_assignee_ids = (
            await db.execute(
                text("SELECT assignee_id FROM task_assignees WHERE org_id = :org AND task_id = :tid"),
                {"org": org_id, "tid": task_id},
            )
        ).all()
        member_ids = list(dict.fromkeys([sender_id, *(str(r.assignee_id) for r in all_assignee_ids)]))
        await enqueue_outbox(
            db,
            events.TASK_TOPIC,
            task_id,
            events.task_assigned(
                org_id=org_id,
                task_id=task_id,
                assignee_id=str(reopened.assignee_id),
                sender_id=sender_id,
                status_version=int(reopened.status_version),
                sender_username=sender_username,
                title=title,
                description=description,
                members=member_ids,
            ),
        )
        await db.commit()

        sync_failed = False
        if task.project_channel_id is not None:
            try:
                await sync_assignees_to_project_channel(
                    org_id, str(task.project_channel_id), me, [str(reopened.assignee_id)]
                )
            except HTTPException as exc:
                sync_failed = True
                log.warning(
                    "task_reassign_member_project_channel_sync_failed",
                    task_id=task_id,
                    assignee_id=assignee_id,
                    channel_id=str(task.project_channel_id),
                    status=exc.status_code,
                    detail=exc.detail,
                )
        response = {"taskId": task_id, "assigneeId": str(reopened.assignee_id)}
        if sync_failed:
            response["projectChannelSyncFailed"] = True
        return response
