"""Task deadlines — the ONE place that knows how a deadline is worked out and what
happens when it passes.

Two jobs, both here so no other module restates them:

  1. `resolve_deadline` turns a recurring series' deadline RULE into the concrete
     instant for one occurrence (called by the schedule worker as it materializes
     each task).
  2. `miss_assignments` / `sweep_due_deadlines` / `expire_if_due` move an
     assignment whose deadline passed before it was done to MISSED, and tell
     everyone via a `task.missed` outbox event.

── The MISSED rule ───────────────────────────────────────────────────────────
Only an assignment still SENT or ACKNOWLEDGED can be missed. COMPLETED, IGNORED,
LEFT (and an already MISSED row) are terminal for that person and are never
touched — the guard is in the UPDATE itself, so it holds under any race.

A recurring occurrence is its own `tasks` row, so a deadline can only ever miss
THAT occurrence; the schedule is never read or written here, and the next
occurrence is generated exactly as before.

── Safe to run anywhere, any number of times ────────────────────────────────
The status guard makes every transition idempotent. The sweeper claims tasks with
FOR UPDATE SKIP LOCKED, so any number of task-svc replicas split the work without
double-processing, and a crash mid-batch rolls back whole (status change and
outbox row commit together) — the next poll simply picks the tasks up again. The
clock is the database's `now()`, never a replica's, so replicas cannot disagree
about whether a deadline has passed.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import uuid6
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from . import events
from .db import session, set_bypass_rls
from .logging_setup import log

POLL_SECONDS = 2.0
# Tasks claimed per transaction. A task can carry hundreds of assignees (a channel),
# so this bounds one transaction's write volume, not the number of rows it touches.
SWEEP_BATCH = 50
# Batches per poll, so a backlog (the service was down over a deadline) drains
# promptly without one poll monopolising the loop.
MAX_BATCHES_PER_POLL = 20

#: SQL guard appended to every assignee-status UPDATE a person can trigger
#: (acknowledge/ignore/complete/leave): once the deadline has passed the action no
#: longer applies, even in the window before the sweeper has run. `task_assignees`
#: is the UPDATE's target, so the reference needs no alias.
NOT_PAST_DEADLINE = (
    "AND NOT EXISTS (SELECT 1 FROM tasks dl "
    "WHERE dl.id = task_assignees.task_id AND dl.deadline_at <= now())"
)


@dataclass(frozen=True)
class DeadlineRule:
    kind: str  # RELATIVE | FIXED_TIME
    tz: str
    amount: int | None = None
    unit: str | None = None  # MINUTES | HOURS | DAYS
    time_of_day: time | None = None


def rule_from_row(row: Any) -> DeadlineRule | None:
    """The rule stored on a task_schedules row, or None when it has no deadline."""
    if row.deadline_kind is None:
        return None
    return DeadlineRule(
        kind=row.deadline_kind,
        tz=row.deadline_tz,
        amount=row.deadline_amount,
        unit=row.deadline_unit,
        time_of_day=row.deadline_time,
    )


def _wall_clock_to_utc(naive: datetime, zone: ZoneInfo) -> datetime:
    """Read a naive wall-clock time in `zone` and return the UTC instant.

    A time that does not exist (the hour skipped when clocks go forward) resolves
    forward by the length of the gap — 02:30 on a spring-forward night is 03:30 —
    and one that happens twice (clocks go back) resolves to its FIRST occurrence.
    zoneinfo's fold=0 behaviour, relied on here on purpose and covered by tests.
    """
    return naive.replace(tzinfo=zone).astimezone(timezone.utc)


def resolve_deadline(rule: DeadlineRule, occurrence_at: datetime) -> datetime:
    """The concrete deadline of the occurrence that runs at `occurrence_at`.

      RELATIVE MINUTES/HOURS   occurrence_at + that much ELAPSED time.
      RELATIVE DAYS            the same wall-clock time N calendar days later in
                               the rule's zone, so a day is a day across DST.
      FIXED_TIME               that time of day on the occurrence's own date in
                               the rule's zone.
    """
    zone = ZoneInfo(rule.tz)
    if rule.kind == "RELATIVE":
        assert rule.amount is not None and rule.unit is not None
        if rule.unit == "DAYS":
            local = occurrence_at.astimezone(zone).replace(tzinfo=None)
            return _wall_clock_to_utc(local + timedelta(days=rule.amount), zone)
        step = timedelta(minutes=rule.amount) if rule.unit == "MINUTES" else timedelta(hours=rule.amount)
        return occurrence_at.astimezone(timezone.utc) + step
    assert rule.time_of_day is not None
    occurrence_date = occurrence_at.astimezone(zone).date()
    return _wall_clock_to_utc(datetime.combine(occurrence_date, rule.time_of_day), zone)


async def miss_assignments(db: AsyncSession, task_ids: list[str]) -> int:
    """Move every still-open assignment of `task_ids` to MISSED and queue the
    `task.missed` events. Does NOT commit — the status change and its outbox rows
    must land in the caller's one transaction, or a crash between them would leave
    a task missed that nobody was told about (or the reverse).

    The caller decides WHICH tasks are past their deadline; the status guard here
    is what makes calling it twice harmless.
    """
    if not task_ids:
        return 0
    missed = (
        await db.execute(
            text(
                "UPDATE task_assignees ta "
                "SET status = 'MISSED', status_version = ta.status_version + 1, missed_at = now() "
                "FROM tasks t "
                "WHERE t.id = ta.task_id AND ta.task_id = ANY(:ids) "
                "      AND ta.status IN ('SENT', 'ACKNOWLEDGED') "
                "RETURNING ta.task_id, ta.org_id, ta.assignee_id, ta.status_version, t.sender_id"
            ),
            {"ids": task_ids},
        )
    ).all()
    if not missed:
        return 0
    usernames = {
        (str(r.org_id), str(r.user_id)): r.username
        for r in (
            await db.execute(
                text(
                    "SELECT org_id, user_id, username FROM user_projection "
                    "WHERE user_id = ANY(:ids)"
                ),
                {"ids": list({str(m.assignee_id) for m in missed})},
            )
        ).all()
    }
    await db.execute(
        text(
            "INSERT INTO outbox (id, topic, kafka_key, payload) "
            "VALUES (:id, :topic, :key, CAST(:payload AS jsonb))"
        ),
        [
            {
                "id": str(uuid6.uuid7()),
                "topic": events.TASK_TOPIC,
                "key": str(m.task_id),
                "payload": json.dumps(
                    events.task_missed(
                        org_id=str(m.org_id),
                        task_id=str(m.task_id),
                        assignee_id=str(m.assignee_id),
                        sender_id=str(m.sender_id),
                        status_version=m.status_version,
                        assignee_username=usernames.get((str(m.org_id), str(m.assignee_id)), ""),
                    )
                ),
            }
            for m in missed
        ],
    )
    return len(missed)


async def expire_if_due(db: AsyncSession, task_id: str) -> bool:
    """For ONE task, inside the caller's transaction: if its deadline has passed,
    miss its open assignments now and say so.

    This is how a person's action that arrives after the deadline — but before the
    sweeper's next poll — is resolved consistently instead of squeaking through.
    The caller commits. Locking the task row first matches the sweeper's order
    (task, then assignees), so the two cannot deadlock.
    """
    row = (
        await db.execute(
            text("SELECT deadline_at IS NOT NULL AND deadline_at <= now() AS due FROM tasks WHERE id = :t FOR UPDATE"),
            {"t": task_id},
        )
    ).first()
    if row is None or not row.due:
        return False
    await miss_assignments(db, [task_id])
    await db.execute(
        text("UPDATE tasks SET deadline_swept_at = COALESCE(deadline_swept_at, now()) WHERE id = :t"),
        {"t": task_id},
    )
    return True


async def sweep_due_deadlines(limit: int = SWEEP_BATCH) -> int:
    """Claim up to `limit` tasks whose deadline has passed and miss their open
    assignments. Returns how many tasks it claimed (0 = nothing was due).

    A claimed task is marked swept even when nobody was left to miss (everyone had
    already completed, left or ignored it): that is what retires it from the
    sweeper's index, so the work stays proportional to tasks still waiting.
    """
    async with session() as db:
        # Cross-org background worker, like the schedule worker and outbox poller.
        await set_bypass_rls(db)
        due = (
            await db.execute(
                text(
                    "SELECT id FROM tasks "
                    "WHERE deadline_at IS NOT NULL AND deadline_swept_at IS NULL AND deadline_at <= now() "
                    "ORDER BY deadline_at, id LIMIT :n FOR UPDATE SKIP LOCKED"
                ),
                {"n": limit},
            )
        ).all()
        if not due:
            await db.rollback()
            return 0
        task_ids = [str(r.id) for r in due]
        missed = await miss_assignments(db, task_ids)
        await db.execute(
            text("UPDATE tasks SET deadline_swept_at = now() WHERE id = ANY(:ids)"),
            {"ids": task_ids},
        )
        await db.commit()
        if missed:
            log.info("task_deadlines_missed", tasks=len(task_ids), assignments=missed)
        return len(task_ids)


async def sweep_until_idle() -> int:
    total = 0
    for _ in range(MAX_BATCHES_PER_POLL):
        try:
            claimed = await sweep_due_deadlines()
        except Exception:
            # Nothing was persisted (one transaction); the next poll retries.
            log.exception("task_deadline_sweep_failed")
            break
        if claimed == 0:
            break
        total += claimed
    return total


class DeadlineWorker:
    def __init__(self) -> None:
        self._stop = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="task-deadline-worker")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            await self._task
            self._task = None

    async def _run(self) -> None:
        while not self._stop.is_set():
            await sweep_until_idle()
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=POLL_SECONDS)
            except asyncio.TimeoutError:
                pass


worker = DeadlineWorker()
