"""`POST /tasks/{id}/reassign` — put a COMPLETED task back in front of the people
who completed it.

A task is sometimes marked Completed while the work is not actually finished. The
allocator reopens it without picking anyone: every assignment that is COMPLETED goes
back to SENT, for the same person, on the same row.

What changes, per reopened assignment: status -> SENT, `status_version` + 1 (the
counter only ever goes up, so sticky-svc's version guard keeps working), `assigned_at`
-> now (it is a fresh allocation: it sorts to the top of the assignee's inbox), and
the per-lifecycle stamps `acknowledged_at` / `completed_at` are cleared so the row
describes the commitment that is open now. The earlier completion is not lost: its
`task.completed` event stays in the event log and the telemetry activity record, and
the allocator's review (`review_enc`, `review_rating`, `reviewed_at`) is left alone.

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
from .helpers import enqueue_outbox, resolve_username
from .participants import _task_context

router = APIRouter()
_ACTIVE = ("SENT", "ACKNOWLEDGED")


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
        if not any(r.status == "COMPLETED" for r in rows):
            raise HTTPException(status_code=409, detail="task has no completed assignment to reassign")
        # Reopened work would already be late, and the deadline sweeper has run: it
        # would sit SENT with every action refused. The deadline is not ours to move.
        if task.past_deadline:
            raise HTTPException(status_code=409, detail="cannot reassign after the task's deadline")

        # Only COMPLETED rows. Someone who left, ignored or missed the task made (or
        # was handed) that outcome themselves; reassignment does not override it, and
        # nobody is added or removed.
        reopened = (
            await db.execute(
                text(
                    "UPDATE task_assignees "
                    "SET status = 'SENT', status_version = status_version + 1, "
                    "    assigned_at = now(), acknowledged_at = NULL, completed_at = NULL "
                    "WHERE org_id = :org AND task_id = :tid AND status = 'COMPLETED' "
                    "RETURNING assignee_id, status_version"
                ),
                {"org": org_id, "tid": task_id},
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
        return {"taskId": task_id, "reassignedUserIds": [str(r.assignee_id) for r in reopened]}
