from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, HTTPException, Header
from sqlalchemy import text

from crypto import cryptor
from .. import events
from ..auth import Principal, PrincipalDep
from ..db import session, set_org_context
from ..logging_setup import log
from ..projects import sync_assignees_to_project_channel
from ..schemas import MAX_ASSIGNEES, AddTaskAssigneesRequest
from .helpers import enqueue_outbox, resolve_username
from .tasks_write import _insert_task_channels, _resolve_channel_members

router = APIRouter()
_ACTIVE = ("SENT", "ACKNOWLEDGED")


async def _task_context(db, org_id: str, task_id: str):
    row = (
        await db.execute(
            text(
                "SELECT t.sender_id, t.title_enc, t.description_enc, "
                "       COALESCE(t.deadline_at <= now(), false) AS past_deadline, "
                "       t.project_id, p.channel_id AS project_channel_id "
                "FROM tasks t LEFT JOIN projects p ON p.id = t.project_id AND p.org_id = t.org_id "
                "WHERE t.id = :tid AND t.org_id = :org"
            ),
            {"tid": task_id, "org": org_id},
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    return row


async def _require_membership_permission(db, org_id: str, task_id: str, user_id: str, sender_id: str) -> None:
    if user_id == sender_id:
        return
    row = (
        await db.execute(
            text(
                "SELECT 1 FROM task_assignees "
                "WHERE org_id = :org AND task_id = :tid AND assignee_id = :uid "
                "AND status IN ('SENT', 'ACKNOWLEDGED')"
            ),
            {"org": org_id, "tid": task_id, "uid": user_id},
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=403, detail="only a task participant can modify membership")


@router.post("/tasks/{task_id}/assignees")
async def add_participants(
    task_id: str,
    body: AddTaskAssigneesRequest,
    principal: Principal = PrincipalDep,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    del idempotency_key  # The unique assignment key makes retries idempotent.
    org_id, me = principal.org_id, principal.user_id
    if not body.userIds and not body.channelIds:
        raise HTTPException(status_code=400, detail="at least one person or channel required")
    # Each channel's current members, resolved server-side (and only for a channel
    # the caller is in — messaging-svc answers 404 otherwise) exactly as on create,
    # so the client cannot name a recipient list of its own. Done before the
    # transaction opens: it is a network call.
    channel_member_ids: list[str] = []
    named_ids = {str(uuid.UUID(user_id)) for user_id in body.userIds}
    channel_origin: dict[str, tuple[str, str]] = {}
    for channel_id in body.channelIds:
        members, channel_name = await _resolve_channel_members(channel_id, org_id, me)
        for member_id in members:
            canonical_id = str(uuid.UUID(member_id))
            if canonical_id not in named_ids and canonical_id not in channel_origin:
                channel_origin[canonical_id] = (channel_id, channel_name)
        channel_member_ids.extend(members)
    async with session() as db:
        await set_org_context(db, org_id)
        task = await _task_context(db, org_id, task_id)
        await _require_membership_permission(db, org_id, task_id, me, str(task.sender_id))

        active_members = (
            await db.execute(
                text(
                    "SELECT user_id FROM user_projection "
                    "WHERE org_id = :org AND active AND user_id = ANY(:ids)"
                ),
                {"org": org_id, "ids": body.userIds},
            )
        ).all()
        if len(active_members) != len(set(body.userIds)):
            raise HTTPException(status_code=400, detail="every participant must be an active member of your organisation")
        # Named people and channel members, each person once (canonical UUIDs: the
        # request accepts any casing, messaging-svc returns lowercase).
        valid_ids = list(dict.fromkeys(str(uuid.UUID(u)) for u in [*body.userIds, *channel_member_ids]))
        if len(valid_ids) > MAX_ASSIGNEES:
            raise HTTPException(
                status_code=400,
                detail=f"too many participants ({len(valid_ids)}); maximum is {MAX_ASSIGNEES} per add",
            )

        existing = (
            await db.execute(
                text(
                    "SELECT assignee_id FROM task_assignees "
                    "WHERE org_id = :org AND task_id = :tid AND assignee_id = ANY(:ids)"
                ),
                {"org": org_id, "tid": task_id, "ids": valid_ids},
            )
        ).all()
        existing_ids = {str(row.assignee_id) for row in existing}
        current_members = (
            await db.execute(
                text(
                    "SELECT assignee_id FROM task_assignees "
                    "WHERE org_id = :org AND task_id = :tid AND status IN ('SENT', 'ACKNOWLEDGED')"
                ),
                {"org": org_id, "tid": task_id},
            )
        ).all()
        member_ids = [str(row.assignee_id) for row in current_members]
        add_ids = [user_id for user_id in valid_ids if user_id not in existing_ids]
        if not add_ids and not body.channelIds:
            await db.rollback()
            return {"addedUserIds": [], "addedChannelIds": []}

        # A completed task has no active assignment to extend. A task with at
        # least one active participant remains open even if another participant
        # has already completed or left.
        open_task = (
            await db.execute(
                text(
                    "SELECT 1 FROM task_assignees WHERE org_id = :org AND task_id = :tid "
                    "AND status IN ('SENT', 'ACKNOWLEDGED') LIMIT 1"
                ),
                {"org": org_id, "tid": task_id},
            )
        ).first()
        if open_task is None:
            raise HTTPException(status_code=409, detail="cannot add participants to a completed task")
        # Someone added now would receive a task that is already missed.
        if task.past_deadline:
            raise HTTPException(status_code=409, detail="cannot add participants after the task's deadline")

        # Attach the channels so a member who joins one later is added as well
        # (the ChannelMemberJoined consumer). Re-attaching one is a no-op.
        await _insert_task_channels(db, org_id=org_id, task_id=task_id, channel_ids=body.channelIds)

        sender_username = await resolve_username(db, org_id, str(task.sender_id)) or principal.username
        title = await cryptor().decrypt(db, org_id, task.title_enc) or ""
        description = await cryptor().decrypt(db, org_id, task.description_enc) or ""
        added_ids: list[str] = []
        for user_id in add_ids:
            origin = channel_origin.get(user_id)
            inserted = await db.execute(
                text(
                    "INSERT INTO task_assignees (task_id, org_id, assignee_id, status, status_version) "
                    "VALUES (:tid, :org, :uid, 'SENT', 0) "
                    "ON CONFLICT (task_id, assignee_id) DO NOTHING "
                    "RETURNING assignee_id"
                ),
                {"tid": task_id, "org": org_id, "uid": user_id},
            )
            if inserted.first() is None:
                continue
            added_ids.append(user_id)
            await enqueue_outbox(
                db,
                events.TASK_TOPIC,
                task_id,
                events.task_assigned(
                    org_id=org_id,
                    task_id=task_id,
                    assignee_id=user_id,
                    sender_id=str(task.sender_id),
                    status_version=0,
                    sender_username=sender_username,
                    title=title,
                    description=description,
                    members=list(dict.fromkeys([str(task.sender_id), *member_ids, *add_ids])),
                    channel_id=origin[0] if origin else None,
                    channel_name=origin[1] if origin else None,
                ),
            )
        await db.commit()
        sync_failed = False
        if task.project_channel_id is not None and added_ids:
            try:
                await sync_assignees_to_project_channel(
                    org_id, str(task.project_channel_id), me, added_ids
                )
            except HTTPException as exc:
                sync_failed = True
                log.warning(
                    "task_participant_project_channel_sync_failed",
                    task_id=task_id,
                    channel_id=str(task.project_channel_id),
                    status=exc.status_code,
                    detail=exc.detail,
                )
        response = {"addedUserIds": added_ids, "addedChannelIds": body.channelIds}
        if sync_failed:
            response["projectChannelSyncFailed"] = True
        return response


@router.delete("/tasks/{task_id}/assignees/{assignee_id}")
async def withdraw_participant(
    task_id: str,
    assignee_id: str,
    principal: Principal = PrincipalDep,
) -> dict:
    org_id, me = principal.org_id, principal.user_id
    if me == assignee_id:
        raise HTTPException(status_code=400, detail="use Leave to remove your own assignment")
    async with session() as db:
        await set_org_context(db, org_id)
        task = await _task_context(db, org_id, task_id)
        if str(task.sender_id) != me:
            raise HTTPException(status_code=403, detail="only the allocator can withdraw a participant")
        try:
            uuid.UUID(assignee_id)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="invalid assignee id") from exc
        row = (
            await db.execute(
                text(
                    "DELETE FROM task_assignees "
                    "WHERE org_id = :org AND task_id = :tid AND assignee_id = :uid "
                    "AND status IN ('SENT', 'ACKNOWLEDGED') "
                    "RETURNING status_version"
                ),
                {"org": org_id, "tid": task_id, "uid": assignee_id},
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=409, detail="participant is no longer active on this task")
        current_members = (
            await db.execute(
                text(
                    "SELECT assignee_id FROM task_assignees "
                    "WHERE org_id = :org AND task_id = :tid AND status IN ('SENT', 'ACKNOWLEDGED')"
                ),
                {"org": org_id, "tid": task_id},
            )
        ).all()
        username = await resolve_username(db, org_id, assignee_id)
        await enqueue_outbox(
            db,
            events.TASK_TOPIC,
            task_id,
            events.task_withdrawn(
                org_id=org_id,
                task_id=task_id,
                assignee_id=assignee_id,
                sender_id=me,
                status_version=int(row.status_version) + 1,
                assignee_username=username,
                members=list(dict.fromkeys([me, assignee_id, *(str(r.assignee_id) for r in current_members)])),
            ),
        )
        await db.commit()
        return {"withdrawnUserId": assignee_id, "statusVersion": int(row.status_version) + 1}
