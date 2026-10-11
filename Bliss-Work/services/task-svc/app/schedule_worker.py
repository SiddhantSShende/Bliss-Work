from __future__ import annotations

import asyncio
import calendar
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import uuid6
from fastapi import HTTPException
from sqlalchemy import text

from .db import set_bypass_rls, session
from .logging_setup import log
from .deadlines import resolve_deadline, rule_from_row
from .routes.tasks_write import (
    ChannelOrigin,
    _insert_task_assignees,
    _insert_task_channels,
    _resolve_channel_members,
)
from .routes.helpers import resolve_username
from crypto import cryptor


POLL_SECONDS = 1.0
BATCH_SIZE = 50

# A schedule that cannot run RIGHT NOW (its channel members cannot be fetched, it
# has nobody left to assign, or materializing it raised) is parked for this long
# and skipped by the claim query. Without that, it stays the oldest due row, is
# claimed first on every poll and ends the batch — so one stuck schedule starves
# every schedule behind it. Parking changes nothing persistent: the schedule stays
# ACTIVE (still listed, still cancellable) and is simply retried after the delay.
# In memory on purpose: a restart or another replica retries sooner, which is
# harmless.
PARK_SECONDS = 60.0
RECURRENCE_GRACE = timedelta(hours=1)
_parked_until: dict[str, float] = {}
_PARKED = object()  # _claim_due_schedule's "this one was parked; carry on" result


def _park(schedule_id: object) -> None:
    _parked_until[str(schedule_id)] = time.monotonic() + PARK_SECONDS


def _parked_ids() -> list[str]:
    now = time.monotonic()
    for schedule_id in [i for i, until in _parked_until.items() if until <= now]:
        del _parked_until[schedule_id]
    return list(_parked_until)


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


def _latest_due_occurrence(
    current: datetime,
    *,
    now: datetime,
    start_at: datetime,
    frequency: str,
    interval: int,
    weekdays: list[int],
    monthly_rule: str | None,
    monthly_day: int | None,
    monthly_ordinal: int | None,
    monthly_weekday: int | None,
) -> tuple[datetime, datetime | None]:
    """Return the latest due occurrence and its successor, skipping backlog."""
    latest = current
    following = next_occurrence(
        latest,
        start_at=start_at,
        frequency=frequency,
        interval=interval,
        weekdays=weekdays,
        monthly_rule=monthly_rule,
        monthly_day=monthly_day,
        monthly_ordinal=monthly_ordinal,
        monthly_weekday=monthly_weekday,
    )
    while following is not None and following <= now:
        latest = following
        following = next_occurrence(
            latest,
            start_at=start_at,
            frequency=frequency,
            interval=interval,
            weekdays=weekdays,
            monthly_rule=monthly_rule,
            monthly_day=monthly_day,
            monthly_ordinal=monthly_ordinal,
            monthly_weekday=monthly_weekday,
        )
    return latest, following


async def _resolve_targets(row: Any) -> tuple[list[str], list[str], ChannelOrigin]:
    """Who this occurrence goes to, and which of its channels still exist.

    The named people plus the CURRENT members of every channel that can still be
    resolved, each person once. A channel messaging-svc answers 404 for — deleted,
    or the sender is no longer in it — is skipped and logged: it contributes no
    members and is not attached to the occurrence, but stays on the schedule, so
    a later occurrence picks it up again if it becomes resolvable. Any other
    failure (messaging-svc down) is raised, never skipped: dropping recipients
    because of an outage would be silent data loss, so the schedule is parked and
    retried whole instead.

    A schedule written before 012 has only the legacy single channel_id.

    Also returns a channel-origin map (see tasks_write.ChannelOrigin), same
    named-intent-wins / first-channel-wins rules as _resolve_recipients, so the
    materialized occurrence's task.assigned events can carry the same
    channel attribution a freshly-created task's would.
    """
    org_id, sender_id = str(row.org_id), str(row.sender_id)
    declared = [str(value) for value in (row.channel_ids or [])] or (
        [str(row.channel_id)] if row.channel_id is not None else []
    )
    recipients = [str(value) for value in (row.assignee_ids or [])]
    # row.assignee_ids elements come back from asyncpg as its own UUID type
    # (not str) for a native uuid[] column — str() them first, same as
    # `recipients` above, before handing them to uuid.UUID().
    named_canonical = {str(uuid.UUID(r)) for r in recipients}
    live: list[str] = []
    channel_origin: ChannelOrigin = {}
    for channel_id in declared:
        try:
            members, channel_name = await _resolve_channel_members(channel_id, org_id, sender_id)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            log.warning(
                "task_schedule_channel_unresolvable",
                schedule_id=str(row.id),
                channel_id=channel_id,
            )
            continue
        live.append(channel_id)
        for member_id in members:
            canonical = str(uuid.UUID(member_id))
            if canonical not in named_canonical and canonical not in channel_origin:
                channel_origin[canonical] = (channel_id, channel_name)
        recipients.extend(members)
    # Canonical UUIDs: the two sources spell them differently, and task_assignees
    # is keyed (task_id, assignee_id) — see tasks_write._resolve_recipients.
    deduped = list(dict.fromkeys(str(uuid.UUID(r)) for r in recipients))
    return deduped, live, channel_origin


async def _claim_due_schedule() -> object | None:
    async with session() as db:
        await set_bypass_rls(db)
        row = (
            await db.execute(
                text(
                    "SELECT id, org_id, sender_id, title_enc, description_enc, channel_id, channel_ids, assignee_ids, "
                    "kind, scheduled_for, start_at, frequency, frequency_interval, weekdays, monthly_rule, "
                    "monthly_day, monthly_ordinal, monthly_weekday, end_condition, end_at, occurrence_limit, "
                    "occurrence_count, next_run_at, "
                    "deadline_at, deadline_kind, deadline_amount, deadline_unit, deadline_time, deadline_tz "
                    "FROM task_schedules "
                    "WHERE status = 'ACTIVE' AND next_run_at <= now() "
                    "AND id <> ALL(CAST(:parked AS uuid[])) "
                    "ORDER BY next_run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED"
                ),
                {"parked": _parked_ids()},
            )
        ).first()
        if row is None:
            await db.rollback()
            return None
        try:
            return await _materialize(db, row)
        except Exception:
            # Nothing of this occurrence is persisted (one transaction), and the
            # schedule must not block the ones behind it.
            await db.rollback()
            _park(row.id)
            log.exception("task_schedule_materialization_failed", schedule_id=str(row.id))
            return _PARKED


async def _materialize(db: Any, row: Any) -> object | None:
    """Turn one claimed, due schedule into a task occurrence (the transaction is
    the caller's). Returns the schedule id once materialized, None when the run
    only moved a recurring schedule to its real first occurrence, or _PARKED."""
    run_at = row.next_run_at
    next_run: datetime | None = None
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

    if row.kind == "RECURRING":
        now = datetime.now(timezone.utc)
        run_at, next_run = _latest_due_occurrence(
            run_at,
            now=now,
            start_at=row.start_at,
            frequency=row.frequency,
            interval=int(row.frequency_interval),
            weekdays=[int(day) for day in (row.weekdays or [])],
            monthly_rule=row.monthly_rule,
            monthly_day=row.monthly_day,
            monthly_ordinal=row.monthly_ordinal,
            monthly_weekday=row.monthly_weekday,
        )
        if run_at < now - RECURRENCE_GRACE:
            should_end = (
                next_run is None
                or row.end_condition == "ON_DATE" and next_run > row.end_at
            )
            await db.execute(
                text(
                    "UPDATE task_schedules SET next_run_at = :next_run, "
                    "status = CASE WHEN :ended THEN 'COMPLETED' ELSE 'ACTIVE' END, "
                    "updated_at = now() WHERE id = :id"
                ),
                {
                    "next_run": next_run or row.next_run_at,
                    "ended": should_end,
                    "id": row.id,
                },
            )
            await db.commit()
            log.info(
                "task_schedule_missed_occurrences_skipped",
                schedule_id=str(row.id),
                next_run_at=next_run,
            )
            return None

    # Resolve targets only for an occurrence that will actually be created.
    assignee_ids, channel_ids, channel_origin = await _resolve_targets(row)
    if not assignee_ids:
        # Nobody left to assign (every channel unresolvable or empty, and no named
        # people). The schedule is left exactly as it was — ACTIVE, listed, and
        # cancellable by its sender — and retried after PARK_SECONDS in case a
        # channel or its members come back. It is just no longer allowed to hold
        # up the queue while it waits.
        await db.rollback()
        log.warning("task_schedule_unassignable", schedule_id=str(row.id))
        _park(row.id)
        return _PARKED

    # The concrete deadline of THIS occurrence, resolved against the moment it was
    # due (`run_at`), not the moment a busy or restarted worker got to it. A
    # one-off schedule carries it as an absolute instant; a series as a rule.
    rule = rule_from_row(row)
    deadline_at = resolve_deadline(rule, run_at) if rule is not None else row.deadline_at

    title = await cryptor().decrypt(db, str(row.org_id), row.title_enc) or ""
    description = await cryptor().decrypt(db, str(row.org_id), row.description_enc) or ""
    sender_username = await resolve_username(db, str(row.org_id), str(row.sender_id)) or ""
    occurrence_number = int(row.occurrence_count) + 1
    task_id = str(uuid6.uuid7())
    await db.execute(
        text(
            "INSERT INTO tasks (id, org_id, sender_id, title_enc, description_enc, channel_id, schedule_id, "
            "occurrence_number, deadline_at) "
            "VALUES (:id, :org, :sender, :title, :description, :channel, :schedule, :occurrence, :deadline)"
        ),
        {
            "deadline": deadline_at,
            "id": task_id,
            "org": row.org_id,
            "sender": row.sender_id,
            "title": row.title_enc,
            "description": row.description_enc,
            # Legacy single-channel column (see 012): the first channel.
            "channel": channel_ids[0] if channel_ids else None,
            "schedule": row.id,
            "occurrence": occurrence_number,
        },
    )
    await _insert_task_channels(db, org_id=str(row.org_id), task_id=task_id, channel_ids=channel_ids)
    await _insert_task_assignees(
        db,
        org_id=str(row.org_id),
        task_id=task_id,
        assignee_ids=assignee_ids,
        sender_id=str(row.sender_id),
        sender_username=sender_username,
        title=title,
        description=description,
        channel_origin=channel_origin,
    )

    if row.kind == "SCHEDULED":
        await db.execute(
            text("UPDATE task_schedules SET occurrence_count = :count, status = 'COMPLETED', updated_at = now() WHERE id = :id"),
            {"count": occurrence_number, "id": row.id},
        )
    else:
        if next_run is None:
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
        if schedule_id is _PARKED:
            continue  # it cannot run now; the ones behind it still can
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
