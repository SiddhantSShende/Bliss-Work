from __future__ import annotations

import asyncio
import calendar
from datetime import datetime, timedelta

import uuid6
from sqlalchemy import text

from .db import set_bypass_rls, session
from .logging_setup import log
from .routes.tasks_write import _insert_task_assignees, _resolve_channel_members
from .routes.helpers import resolve_username
from crypto import cryptor


POLL_SECONDS = 1.0
BATCH_SIZE = 50


def _month_add(value: datetime, months: int) -> tuple[int, int]:
    month_index = value.year * 12 + value.month - 1 + months
    return month_index // 12, month_index % 12 + 1


def _monthly_day(value: datetime, day: int, months: int) -> datetime | None:
    year, month = _month_add(value, months)
    if day > calendar.monthrange(year, month)[1]:
        return None
    return value.replace(year=year, month=month, day=day)


def _monthly_weekday(value: datetime, ordinal: int, weekday: int, months: int) -> datetime | None:
    year, month = _month_add(value, months)
    first = value.replace(year=year, month=month, day=1)
    delta = (weekday - first.weekday()) % 7
    day = 1 + delta + (ordinal - 1) * 7
    if day > calendar.monthrange(year, month)[1]:
        return None
    return first.replace(day=day)


def next_occurrence(
    current: datetime,
    *,
    start_at: datetime,
    frequency: str,
    interval: int,
    weekdays: list[int],
    monthly_rule: str | None,
    monthly_day: int | None,
    monthly_ordinal: int | None,
    monthly_weekday: int | None,
) -> datetime | None:
    if frequency == "DAILY":
        return current + timedelta(days=interval)
    if frequency == "MONTHLY":
        months = interval
        while months <= interval * 1200:
            candidate = (
                _monthly_day(current, monthly_day, months)
                if monthly_rule == "DAY_OF_MONTH" and monthly_day is not None
                else _monthly_weekday(current, monthly_ordinal, monthly_weekday, months)
                if monthly_rule == "WEEKDAY_PATTERN" and monthly_ordinal is not None and monthly_weekday is not None
                else None
            )
            if candidate is not None and candidate > current:
                return candidate
            months += interval
        return None

    # Weekly rules are anchored to the week containing the original start.
    anchor_monday = (start_at - timedelta(days=start_at.weekday())).date()
    for day_offset in range(1, 7 * (interval * 1200 + 1)):
        candidate = current + timedelta(days=day_offset)
        week_delta = ((candidate.date() - anchor_monday).days // 7)
        if week_delta >= 0 and week_delta % interval == 0 and candidate.weekday() in weekdays:
            return candidate
    return None


def first_occurrence(
    start_at: datetime,
    *,
    frequency: str,
    weekdays: list[int],
    monthly_rule: str | None,
    monthly_day: int | None,
    monthly_ordinal: int | None,
    monthly_weekday: int | None,
) -> datetime | None:
    if frequency == "WEEKLY":
        for offset in range(7):
            candidate = start_at + timedelta(days=offset)
            if candidate.weekday() in weekdays:
                return candidate
        return None
    if frequency == "MONTHLY":
        if monthly_rule == "DAY_OF_MONTH" and monthly_day == start_at.day:
            return start_at
        if monthly_rule == "WEEKDAY_PATTERN":
            month_candidate = _monthly_weekday(start_at, int(monthly_ordinal), int(monthly_weekday), 0)
            if month_candidate is not None and month_candidate >= start_at:
                return month_candidate
        month_candidate = (
            _monthly_day(start_at, int(monthly_day), 1)
            if monthly_rule == "DAY_OF_MONTH" and monthly_day is not None
            else _monthly_weekday(start_at, int(monthly_ordinal), int(monthly_weekday), 1)
            if monthly_rule == "WEEKDAY_PATTERN" and monthly_ordinal is not None and monthly_weekday is not None
            else None
        )
        return month_candidate
    return start_at


async def _claim_due_schedule() -> object | None:
    async with session() as db:
        await set_bypass_rls(db)
        row = (
            await db.execute(
                text(
                    "SELECT id, org_id, sender_id, title_enc, description_enc, channel_id, assignee_ids, "
                    "kind, scheduled_for, start_at, frequency, frequency_interval, weekdays, monthly_rule, "
                    "monthly_day, monthly_ordinal, monthly_weekday, end_condition, end_at, occurrence_limit, "
                    "occurrence_count, next_run_at "
                    "FROM task_schedules "
                    "WHERE status = 'ACTIVE' AND next_run_at <= now() "
                    "ORDER BY next_run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED"
                )
            )
        ).first()
        if row is None:
            await db.rollback()
            return None

        assignee_ids = [str(value) for value in (row.assignee_ids or [])]
        if row.channel_id is not None:
            assignee_ids = await _resolve_channel_members(str(row.channel_id), str(row.org_id), str(row.sender_id))
        assignee_ids = list(dict.fromkeys(assignee_ids))
        if not assignee_ids:
            await db.rollback()
            return None

        run_at = row.next_run_at
        if row.kind == "RECURRING" and row.occurrence_count == 0:
            run_at = first_occurrence(
                row.start_at,
                frequency=row.frequency,
                weekdays=[int(day) for day in (row.weekdays or [])],
                monthly_rule=row.monthly_rule,
                monthly_day=row.monthly_day,
                monthly_ordinal=row.monthly_ordinal,
                monthly_weekday=row.monthly_weekday,
            )
            if run_at is None or run_at > row.next_run_at:
                await db.execute(
                    text("UPDATE task_schedules SET next_run_at = :next_run, updated_at = now() WHERE id = :id"),
                    {"next_run": run_at or row.next_run_at, "id": row.id},
                )
                await db.commit()
                return None

        title = await cryptor().decrypt(db, str(row.org_id), row.title_enc) or ""
        description = await cryptor().decrypt(db, str(row.org_id), row.description_enc) or ""
        sender_username = await resolve_username(db, str(row.org_id), str(row.sender_id)) or ""
        occurrence_number = int(row.occurrence_count) + 1
        task_id = str(uuid6.uuid7())
        await db.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, title_enc, description_enc, channel_id, schedule_id, occurrence_number) "
                "VALUES (:id, :org, :sender, :title, :description, :channel, :schedule, :occurrence)"
            ),
            {
                "id": task_id,
                "org": row.org_id,
                "sender": row.sender_id,
                "title": row.title_enc,
                "description": row.description_enc,
                "channel": row.channel_id,
                "schedule": row.id,
                "occurrence": occurrence_number,
            },
        )
        await _insert_task_assignees(
            db,
            org_id=str(row.org_id),
            task_id=task_id,
            assignee_ids=assignee_ids,
            sender_id=str(row.sender_id),
            sender_username=sender_username,
            title=title,
            description=description,
        )

        if row.kind == "SCHEDULED":
            await db.execute(
                text("UPDATE task_schedules SET occurrence_count = :count, status = 'COMPLETED', updated_at = now() WHERE id = :id"),
                {"count": occurrence_number, "id": row.id},
            )
        else:
            next_run = next_occurrence(
                run_at,
                start_at=row.start_at,
                frequency=row.frequency,
                interval=int(row.frequency_interval),
                weekdays=[int(day) for day in (row.weekdays or [])],
                monthly_rule=row.monthly_rule,
                monthly_day=row.monthly_day,
                monthly_ordinal=row.monthly_ordinal,
                monthly_weekday=row.monthly_weekday,
            )
            should_end = (
                next_run is None
                or row.end_condition == "AFTER_OCCURRENCES" and occurrence_number >= int(row.occurrence_limit)
                or row.end_condition == "ON_DATE" and next_run > row.end_at
            )
            await db.execute(
                text(
                    "UPDATE task_schedules SET occurrence_count = :count, next_run_at = :next_run, "
                    "status = CASE WHEN :ended THEN 'COMPLETED' ELSE 'ACTIVE' END, updated_at = now() WHERE id = :id"
                ),
                {
                    "count": occurrence_number,
                    "next_run": next_run or row.next_run_at,
                    "ended": should_end,
                    "id": row.id,
                },
            )
        await db.commit()
        return row.id


async def run_due_schedules_once() -> int:
    processed = 0
    for _ in range(BATCH_SIZE):
        try:
            schedule_id = await _claim_due_schedule()
        except Exception:
            log.exception("task_schedule_materialization_failed")
            break
        if schedule_id is None:
            break
        processed += 1
        log.info("task_schedule_materialized", schedule_id=str(schedule_id))
    return processed


class ScheduleWorker:
    def __init__(self) -> None:
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="task-schedule-worker")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            await self._task
            self._task = None

    async def _run(self) -> None:
        while not self._stop.is_set():
            await run_due_schedules_once()
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=POLL_SECONDS)
            except asyncio.TimeoutError:
                pass


worker = ScheduleWorker()
