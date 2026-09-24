from __future__ import annotations

from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from crypto import cryptor
from ..auth import Principal, PrincipalDep
from ..db import session, set_org_context
from ..schemas import ScheduledAssignee, ScheduledTaskDTO, UpdateScheduleRequest
from .helpers import iso

router = APIRouter()


@router.get("/tasks/schedules", response_model=list[ScheduledTaskDTO])
async def list_schedules(principal: Principal = PrincipalDep) -> list[ScheduledTaskDTO]:
    async with session() as db:
        await set_org_context(db, principal.org_id)
        rows = (
            await db.execute(
                text(
                    "SELECT s.id, s.org_id, s.title_enc, s.description_enc, s.kind, s.scheduled_for, "
                    "s.start_at, s.next_run_at, s.frequency, s.frequency_interval, s.weekdays, s.monthly_rule, "
                    "s.monthly_day, s.monthly_ordinal, s.monthly_weekday, s.end_condition, s.end_at, "
                    "s.occurrence_limit, s.occurrence_count, s.assignee_ids, "
                    "COALESCE((SELECT json_agg(json_build_object('userId', u.user_id, 'username', u.username) "
                    "ORDER BY u.username) FROM user_projection u WHERE u.org_id = s.org_id "
                    "AND u.user_id = ANY(s.assignee_ids)), '[]'::json) AS assignees "
                    "FROM task_schedules s WHERE s.org_id = :org AND s.sender_id = :sender "
                    "AND s.status = 'ACTIVE' ORDER BY s.next_run_at, s.id"
                ),
                {"org": principal.org_id, "sender": principal.user_id},
            )
        ).all()
        out: list[ScheduledTaskDTO] = []
        for row in rows:
            out.append(
                ScheduledTaskDTO(
                    scheduleId=str(row.id),
                    title=await cryptor().decrypt(db, str(row.org_id), row.title_enc) or "",
                    description=await cryptor().decrypt(db, str(row.org_id), row.description_enc) or "",
                    channelId=str(row.channel_id) if row.channel_id else None,
                    kind=row.kind,
                    scheduledFor=iso(row.scheduled_for),
                    startAt=iso(row.start_at) or "",
                    nextRunAt=iso(row.next_run_at) or "",
                    frequency=row.frequency,
                    interval=row.frequency_interval,
                    weekdays=[int(day) for day in (row.weekdays or [])],
                    monthlyRule=row.monthly_rule,
                    monthlyDay=row.monthly_day,
                    monthlyOrdinal=row.monthly_ordinal,
                    monthlyWeekday=row.monthly_weekday,
                    endCondition=row.end_condition,
                    endAt=iso(row.end_at),
                    occurrenceLimit=row.occurrence_limit,
                    occurrenceCount=row.occurrence_count,
                    assignees=[ScheduledAssignee(**assignee) for assignee in (row.assignees or [])],
                )
            )
        return out


@router.delete("/tasks/schedules/{schedule_id}")
async def cancel_schedule(
    schedule_id: str,
    principal: Principal = PrincipalDep,
) -> dict[str, str]:
    async with session() as db:
        await set_org_context(db, principal.org_id)
        result = await db.execute(
            text(
                "UPDATE task_schedules SET status = 'CANCELLED', updated_at = now() "
                "WHERE id = :id AND org_id = :org AND sender_id = :sender AND status = 'ACTIVE'"
            ),
            {"id": schedule_id, "org": principal.org_id, "sender": principal.user_id},
        )
        if result.rowcount != 1:
            raise HTTPException(status_code=404, detail="schedule not found")
        await db.commit()
    return {"scheduleId": schedule_id, "status": "CANCELLED"}


@router.patch("/tasks/schedules/{schedule_id}")
async def update_schedule(
    schedule_id: str,
    body: UpdateScheduleRequest,
    principal: Principal = PrincipalDep,
) -> dict[str, str]:
    async with session() as db:
        await set_org_context(db, principal.org_id)
        result = await db.execute(
            text(
                "UPDATE task_schedules SET next_run_at = :next_run, "
                "scheduled_for = CASE WHEN kind = 'SCHEDULED' THEN :next_run ELSE scheduled_for END, "
                "updated_at = now() WHERE id = :id AND org_id = :org AND sender_id = :sender AND status = 'ACTIVE'"
            ),
            {"id": schedule_id, "org": principal.org_id, "sender": principal.user_id, "next_run": body.nextRunAt},
        )
        if result.rowcount != 1:
            raise HTTPException(status_code=404, detail="schedule not found")
        await db.commit()
    return {"scheduleId": schedule_id, "status": "UPDATED"}
