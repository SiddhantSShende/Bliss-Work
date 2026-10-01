"""Task deadlines and the MISSED lifecycle, end to end on a real Postgres.

Create (instant / scheduled / recurring) -> persistence -> recurrence generation ->
deadline evaluation -> MISSED transition -> what the read APIs and the outbox say.
Only messaging-svc is stubbed (the `channels` fixture); the schema, RLS, the
schedule worker, the deadline sweeper and the transition routes are the real code.
"""

# ruff: noqa: F401, F811  -- `channels` is a pytest fixture imported by name, then requested as an argument.
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from sqlalchemy import text

from .test_create_task_mixed_targets import (
    ORG,
    SENDER,
    _assignees,
    _create,
    _id,
    _make_due,
    _q,
    _task_count,
    channels,
)

pytestmark = pytest.mark.integration

UTC = timezone.utc
NY = "America/New_York"


@pytest.fixture(autouse=True)
def _unpark():
    from app import schedule_worker

    schedule_worker._parked_until.clear()
    yield
    schedule_worker._parked_until.clear()


def _iso(dt: datetime) -> str:
    return dt.isoformat()


async def _as(user_id: str) -> httpx.AsyncClient:
    from app.auth import Principal, require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: Principal(
        user_id=user_id, org_id=ORG, roles=["member"], username="u"
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _get(user_id: str, path: str):
    async with await _as(user_id) as c:
        r = await c.get(path)
    assert r.status_code == 200, r.text
    return r.json()


async def _act(user_id: str, task_id: str, action: str) -> httpx.Response:
    async with await _as(user_id) as c:
        return await c.post(f"/api/v1/tasks/{task_id}/assignees/me/{action}")


async def _x(sql: str, **params) -> None:
    """A write under bypass-RLS (the shared `_q` only returns rows)."""
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(text(sql), params)


async def _sweep() -> int:
    from app.deadlines import sweep_due_deadlines

    return await sweep_due_deadlines()


async def _expire(task_id: str, ago: str = "1 minute") -> None:
    """Move a task's deadline into the past — the one thing the API refuses to do —
    as the passage of time would."""
    await _x(f"UPDATE tasks SET deadline_at = now() - interval '{ago}' WHERE id = :t", t=task_id)


async def _status(task_id: str, user_id: str):
    return (
        await _q(
            "SELECT status, status_version, missed_at FROM task_assignees WHERE task_id = :t AND assignee_id = :u",
            t=task_id,
            u=user_id,
        )
    )[0]


async def _missed_events(task_id: str) -> list[dict]:
    rows = await _q("SELECT payload FROM outbox WHERE kafka_key = :t ORDER BY created_at, id", t=task_id)
    events = [json.loads(r.payload) if isinstance(r.payload, str) else r.payload for r in rows]
    return [e for e in events if e["type"] == "task.missed"]


async def _instant(assignees: list[str], **body) -> str:
    r = await _create(assigneeIds=assignees, **body)
    assert r.status_code == 201, r.text
    return r.json()["taskId"]


# ── Normal tasks ───────────────────────────────────────────────────────────────
async def test_a_task_without_a_deadline_behaves_exactly_as_before(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _instant([a])

    row = (await _q("SELECT deadline_at, deadline_swept_at FROM tasks WHERE id = :t", t=task_id))[0]
    assert row.deadline_at is None and row.deadline_swept_at is None
    assert await _sweep() == 0  # nothing to claim: it is not in the sweeper's index
    assert (await _status(task_id, a)).status == "SENT"
    [mine] = await _get(a, "/api/v1/tasks/assigned")
    assert mine["deadlineAt"] is None and mine["missedAt"] is None and mine["myStatus"] == "SENT"
    assert mine["actions"] == ["ACKNOWLEDGE", "IGNORE"]


async def test_an_absolute_deadline_is_persisted_and_exposed(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    deadline = datetime.now(UTC).replace(microsecond=0) + timedelta(hours=3)
    task_id = await _instant([a], deadlineAt=_iso(deadline))

    stored = (await _q("SELECT deadline_at FROM tasks WHERE id = :t", t=task_id))[0].deadline_at
    assert stored == deadline
    [mine] = await _get(a, "/api/v1/tasks/assigned")
    assert datetime.fromisoformat(mine["deadlineAt"]) == deadline
    [sent] = await _get(SENDER, "/api/v1/tasks/sent")
    assert datetime.fromisoformat(sent["deadlineAt"]) == deadline
    # Not due yet: nothing happens.
    assert await _sweep() == 0
    assert (await _status(task_id, a)).status == "SENT"


async def test_a_deadline_in_the_past_is_rejected_at_the_api(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    r = await _create(assigneeIds=[a], deadlineAt=_iso(datetime.now(UTC) - timedelta(minutes=5)))
    assert r.status_code == 422
    assert await _task_count() == 0


async def test_scheduled_task_carries_its_deadline_onto_the_task_it_becomes(db_app, seed_members):
    from app.schedule_worker import run_due_schedules_once

    a = _id()
    await seed_members(ORG, a)
    when = datetime.now(UTC).replace(microsecond=0) + timedelta(days=1)
    r = await _create(
        assigneeIds=[a], allocation="SCHEDULED", scheduledFor=_iso(when), deadlineAt=_iso(when + timedelta(hours=5))
    )
    assert r.status_code == 201, r.text
    schedule_id = r.json()["scheduleId"]
    assert await _task_count() == 0

    [listed] = await _get(SENDER, "/api/v1/tasks/schedules")
    assert datetime.fromisoformat(listed["deadlineAt"]) == when + timedelta(hours=5)
    assert listed["deadlineRule"] is None

    await _make_due(schedule_id)
    assert await run_due_schedules_once() == 1
    [task] = await _q("SELECT id, deadline_at FROM tasks WHERE schedule_id = :s", s=schedule_id)
    assert task.deadline_at == when + timedelta(hours=5)


async def test_a_scheduled_task_cannot_be_moved_past_its_deadline(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    when = datetime.now(UTC) + timedelta(days=1)
    r = await _create(
        assigneeIds=[a], allocation="SCHEDULED", scheduledFor=_iso(when), deadlineAt=_iso(when + timedelta(hours=2))
    )
    schedule_id = r.json()["scheduleId"]
    async with await _as(SENDER) as c:
        late = await c.patch(f"/api/v1/tasks/schedules/{schedule_id}", json={"nextRunAt": _iso(when + timedelta(hours=3))})
        ok = await c.patch(f"/api/v1/tasks/schedules/{schedule_id}", json={"nextRunAt": _iso(when + timedelta(hours=1))})
        gone = await c.patch(f"/api/v1/tasks/schedules/{_id()}", json={"nextRunAt": _iso(when)})
    assert (late.status_code, ok.status_code, gone.status_code) == (409, 200, 404)


# ── The MISSED transition ──────────────────────────────────────────────────────
async def test_a_passed_deadline_moves_the_assignment_to_missed_and_says_so(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _instant([a], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    before = await _status(task_id, a)
    await _expire(task_id)

    assert await _sweep() == 1

    after = await _status(task_id, a)
    assert after.status == "MISSED" and after.missed_at is not None
    assert after.status_version == before.status_version + 1
    [event] = await _missed_events(task_id)
    assert (event["assigneeId"], event["senderId"], event["orgId"]) == (a, SENDER, ORG)
    assert event["statusVersion"] == after.status_version
    assert event["assigneeUsername"] == "member-0"
    # What the client then reads: out of the active lists, into Assigned-as-missed.
    assert await _get(a, "/api/v1/tasks/inbox") == []
    assert await _get(a, "/api/v1/tasks/sticky") == []
    [mine] = await _get(a, "/api/v1/tasks/assigned")
    assert mine["myStatus"] == "MISSED" and mine["actions"] == [] and mine["missedAt"] and mine["deadlineAt"]
    assert mine["assignedAt"]  # the original allocation time is kept
    [sent] = await _get(SENDER, "/api/v1/tasks/sent")
    assert sent["assignees"][0]["status"] == "MISSED" and sent["assignees"][0]["missedAt"]


async def test_the_transition_is_idempotent(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _instant([a], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    await _expire(task_id)

    assert await _sweep() == 1
    first = await _status(task_id, a)
    assert await _sweep() == 0  # swept: no longer claimed
    # Even if a task is somehow claimed again, the status guard changes nothing.
    await _x("UPDATE tasks SET deadline_swept_at = NULL WHERE id = :t", t=task_id)
    assert await _sweep() == 1
    again = await _status(task_id, a)
    assert (again.status, again.status_version, again.missed_at) == (first.status, first.status_version, first.missed_at)
    assert len(await _missed_events(task_id)) == 1


async def test_an_acknowledged_assignment_is_missed_too(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _instant([a], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    assert (await _act(a, task_id, "acknowledge")).status_code == 200
    await _expire(task_id)
    await _sweep()
    assert (await _status(task_id, a)).status == "MISSED"


async def test_completed_ignored_and_left_assignments_are_never_missed(db_app, seed_members):
    sent, acked, completed, ignored, left = (_id() for _ in range(5))
    await seed_members(ORG, sent, acked, completed, ignored, left)
    task_id = await _instant(
        [sent, acked, completed, ignored, left], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1))
    )
    assert (await _act(acked, task_id, "acknowledge")).status_code == 200
    assert (await _act(completed, task_id, "acknowledge")).status_code == 200
    assert (await _act(completed, task_id, "complete")).status_code == 200
    assert (await _act(ignored, task_id, "ignore")).status_code == 200
    assert (await _act(left, task_id, "acknowledge")).status_code == 200
    assert (await _act(left, task_id, "leave")).status_code == 200
    terminal = {u: await _status(task_id, u) for u in (completed, ignored, left)}

    await _expire(task_id)
    await _sweep()

    assert (await _status(task_id, sent)).status == "MISSED"
    assert (await _status(task_id, acked)).status == "MISSED"
    for user, expected in ((completed, "COMPLETED"), (ignored, "IGNORED"), (left, "LEFT")):
        now = await _status(task_id, user)
        assert now.status == expected and now.missed_at is None
        assert now.status_version == terminal[user].status_version
    assert {e["assigneeId"] for e in await _missed_events(task_id)} == {sent, acked}


async def test_a_swept_task_with_nobody_left_to_miss_is_retired_without_events(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _instant([a], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    await _act(a, task_id, "acknowledge")
    await _act(a, task_id, "complete")
    await _expire(task_id)
    assert await _sweep() == 1
    assert await _missed_events(task_id) == []
    assert (await _q("SELECT deadline_swept_at FROM tasks WHERE id = :t", t=task_id))[0].deadline_swept_at is not None
    assert await _sweep() == 0


async def test_an_action_after_the_deadline_is_refused_and_resolves_to_missed(db_app, seed_members):
    """The window between the deadline and the sweeper's next poll must not let an
    action through — nor leave the task looking open."""
    a, b = _id(), _id()
    await seed_members(ORG, a, b)
    task_id = await _instant([a, b], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    assert (await _act(b, task_id, "acknowledge")).status_code == 200
    await _expire(task_id)

    ack = await _act(a, task_id, "acknowledge")
    assert ack.status_code == 409 and "deadline" in ack.text
    assert (await _status(task_id, a)).status == "MISSED"
    done = await _act(b, task_id, "complete")
    assert done.status_code == 409
    assert (await _status(task_id, b)).status == "MISSED"
    assert {e["assigneeId"] for e in await _missed_events(task_id)} == {a, b}
    # and the sweeper has nothing left to do for it
    assert await _sweep() == 0


async def test_actions_before_the_deadline_still_work(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _instant([a], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    assert (await _act(a, task_id, "acknowledge")).status_code == 200
    assert (await _act(a, task_id, "complete")).status_code == 200
    await _expire(task_id)
    await _sweep()
    assert (await _status(task_id, a)).status == "COMPLETED"


async def test_a_missed_task_cannot_be_acted_on_again(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _instant([a], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    await _expire(task_id)
    await _sweep()
    for action in ("acknowledge", "ignore", "complete", "leave"):
        assert (await _act(a, task_id, action)).status_code == 409
    assert (await _status(task_id, a)).status == "MISSED"


async def test_missed_state_survives_a_fresh_session(db_app, seed_members):
    """Persisted server-side: a new engine / new client sees the same thing."""
    from app.db import dispose_engine, init_engine

    a = _id()
    await seed_members(ORG, a)
    task_id = await _instant([a], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    await _expire(task_id)
    await _sweep()
    await dispose_engine()
    init_engine()
    [mine] = await _get(a, "/api/v1/tasks/assigned")
    assert mine["taskId"] == task_id and mine["myStatus"] == "MISSED"
    assert await _get(a, "/api/v1/tasks/inbox") == []


async def test_concurrent_sweepers_miss_each_assignment_exactly_once(db_app, seed_members):
    users = [_id() for _ in range(6)]
    await seed_members(ORG, *users)
    task_ids = [await _instant(users[i : i + 2], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1))) for i in (0, 2, 4)]
    task_ids += [await _instant(users, deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1))) for _ in range(5)]
    for task_id in task_ids:
        await _expire(task_id)

    results = await asyncio.gather(*(_sweep() for _ in range(4)))

    assert sum(results) == len(task_ids)  # every task claimed by exactly one sweeper
    rows = await _q("SELECT status, status_version FROM task_assignees")
    assert {r.status for r in rows} == {"MISSED"}
    assert {r.status_version for r in rows} == {1}
    events = [e for t in task_ids for e in await _missed_events(t)]
    assert len(events) == len(rows)
    assert len({(e["taskId"], e["assigneeId"]) for e in events}) == len(rows)


async def test_only_tasks_past_their_deadline_are_touched(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    later = await _instant([a], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    plain = await _instant([a])
    due = await _instant([a], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    await _expire(due)
    assert await _sweep() == 1
    assert (await _status(due, a)).status == "MISSED"
    assert (await _status(later, a)).status == "SENT"
    assert (await _status(plain, a)).status == "SENT"


async def test_people_cannot_be_added_to_a_task_whose_deadline_has_passed(db_app, seed_members, channels):
    a, late = _id(), _id()
    await seed_members(ORG, a, late)
    task_id = await _instant([a], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    await _expire(task_id)
    async with await _as(SENDER) as c:
        r = await c.post(f"/api/v1/tasks/{task_id}/assignees", json={"userIds": [late]})
    assert r.status_code == 409


async def test_a_channel_joiner_is_not_handed_a_task_past_its_deadline(db_app, seed_members, channels):
    from app.consumer import consumer

    a, ch, joiner = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[ch] = [a]
    r = await _create(channelIds=[ch], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    task_id = r.json()["taskId"]
    await _expire(task_id)
    await consumer._handle_channel_member_joined(
        {"eventId": _id(), "orgId": ORG, "channelId": ch, "userId": joiner}
    )
    assert await _assignees(task_id) == [a]


# ── Recurring series ───────────────────────────────────────────────────────────
async def _series(rule: dict | None, assignee: str) -> str:
    start = datetime.now(UTC) + timedelta(days=1)
    recurrence = {"startAt": _iso(start), "frequency": "DAILY", "interval": 1, "endCondition": "NO_END"}
    if rule is not None:
        recurrence["deadline"] = rule
    r = await _create(assigneeIds=[assignee], allocation="RECURRING", recurrence=recurrence)
    assert r.status_code == 201, r.text
    return r.json()["scheduleId"]


async def _run_next_occurrence(schedule_id: str) -> tuple[str, datetime]:
    """Materialize the next occurrence of a schedule. Returns (task id, the time it
    was due)."""
    from app.schedule_worker import _claim_due_schedule

    await _make_due(schedule_id)
    due_at = (await _q("SELECT next_run_at FROM task_schedules WHERE id = :s", s=schedule_id))[0].next_run_at
    assert str(await _claim_due_schedule()) == schedule_id  # the id, once materialized
    rows = await _q(
        "SELECT id FROM tasks WHERE schedule_id = :s ORDER BY occurrence_number DESC LIMIT 1", s=schedule_id
    )
    return str(rows[0].id), due_at


async def test_recurring_without_a_deadline_makes_occurrences_without_one(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    schedule_id = await _series(None, a)
    row = (await _q("SELECT deadline_kind, deadline_at FROM task_schedules WHERE id = :s", s=schedule_id))[0]
    assert row.deadline_kind is None and row.deadline_at is None
    task_id, _ = await _run_next_occurrence(schedule_id)
    assert (await _q("SELECT deadline_at FROM tasks WHERE id = :t", t=task_id))[0].deadline_at is None
    assert await _sweep() == 0
    [listed] = await _get(SENDER, "/api/v1/tasks/schedules")
    assert listed["deadlineRule"] is None


async def test_recurring_relative_deadline_is_resolved_per_occurrence(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    rule = {"kind": "RELATIVE", "amount": 6, "unit": "HOURS", "timeZone": NY}
    schedule_id = await _series(rule, a)
    # The RULE lives on the template, never a timestamp.
    tpl = (
        await _q(
            "SELECT deadline_kind, deadline_amount, deadline_unit, deadline_tz, deadline_at "
            "FROM task_schedules WHERE id = :s",
            s=schedule_id,
        )
    )[0]
    assert (tpl.deadline_kind, tpl.deadline_amount, tpl.deadline_unit, tpl.deadline_tz) == ("RELATIVE", 6, "HOURS", NY)
    assert tpl.deadline_at is None
    [listed] = await _get(SENDER, "/api/v1/tasks/schedules")
    assert listed["deadlineRule"] == {"kind": "RELATIVE", "amount": 6, "unit": "HOURS", "time": None, "timeZone": NY}

    first, first_at = await _run_next_occurrence(schedule_id)
    second, second_at = await _run_next_occurrence(schedule_id)
    assert first != second and first_at != second_at
    for task_id, at in ((first, first_at), (second, second_at)):
        assert (await _q("SELECT deadline_at FROM tasks WHERE id = :t", t=task_id))[0].deadline_at == at + timedelta(hours=6)


async def test_recurring_fixed_time_deadline_is_that_time_on_each_occurrence_date(db_app, seed_members):
    from app.schedule_worker import _claim_due_schedule

    a = _id()
    await seed_members(ORG, a)
    rule = {"kind": "FIXED_TIME", "time": "17:00", "timeZone": NY}
    start = datetime.now(UTC) + timedelta(days=1)
    # Start at 10:00 New York time so a 17:00 deadline is legal.
    from zoneinfo import ZoneInfo

    start = start.astimezone(ZoneInfo(NY)).replace(hour=10, minute=0, second=0, microsecond=0)
    r = await _create(
        assigneeIds=[a], allocation="RECURRING",
        recurrence={"startAt": _iso(start), "frequency": "DAILY", "interval": 1, "endCondition": "NO_END", "deadline": rule},
    )
    assert r.status_code == 201, r.text
    schedule_id = r.json()["scheduleId"]

    # Two consecutive occurrences straddling the 8 March 2026 spring-forward. The
    # series steps in UTC (unchanged), so the second occurrence is 11:00 local; the
    # deadline must still be 17:00 local on each occurrence's own date.
    got = []
    for occurrence in (datetime(2026, 3, 7, 15, 0, tzinfo=UTC), datetime(2026, 3, 8, 15, 0, tzinfo=UTC)):
        await _x(
            "UPDATE task_schedules SET start_at = :s, next_run_at = :n WHERE id = :i",
            s=datetime(2026, 3, 7, 15, 0, tzinfo=UTC), n=occurrence, i=schedule_id,
        )
        assert str(await _claim_due_schedule()) == schedule_id
        row = (await _q("SELECT deadline_at FROM tasks WHERE schedule_id = :s ORDER BY occurrence_number DESC LIMIT 1", s=schedule_id))[0]
        got.append(row.deadline_at.astimezone(ZoneInfo(NY)).strftime("%Y-%m-%d %H:%M"))
    assert got == ["2026-03-07 17:00", "2026-03-08 17:00"]


async def test_one_occurrence_becomes_missed_and_the_series_carries_on(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    schedule_id = await _series({"kind": "RELATIVE", "amount": 6, "unit": "HOURS", "timeZone": NY}, a)
    first, _ = await _run_next_occurrence(schedule_id)
    before = (await _q("SELECT status, next_run_at, occurrence_count FROM task_schedules WHERE id = :s", s=schedule_id))[0]

    await _expire(first)
    assert await _sweep() == 1

    assert (await _status(first, a)).status == "MISSED"
    # The SERIES is untouched: still active, same cadence, nothing cancelled.
    after = (await _q("SELECT status, next_run_at, occurrence_count FROM task_schedules WHERE id = :s", s=schedule_id))[0]
    assert (after.status, after.next_run_at, after.occurrence_count) == (before.status, before.next_run_at, before.occurrence_count)
    assert after.status == "ACTIVE"

    # Future occurrences keep being generated, with their own deadline, and are NOT missed.
    second, second_at = await _run_next_occurrence(schedule_id)
    assert (await _status(second, a)).status == "SENT"
    assert (await _q("SELECT deadline_at FROM tasks WHERE id = :t", t=second))[0].deadline_at == second_at + timedelta(hours=6)
    assert await _sweep() == 0
    assert (await _status(first, a)).status == "MISSED"
    assert (await _status(second, a)).status == "SENT"
    assert (await _q("SELECT occurrence_count FROM task_schedules WHERE id = :s", s=schedule_id))[0].occurrence_count == 2


async def test_an_occurrence_born_past_its_deadline_is_missed_by_the_next_sweep(db_app, seed_members):
    """A worker that was down over a deadline still resolves it against the time the
    occurrence was DUE, and the sweeper then records the miss."""
    from app.schedule_worker import _claim_due_schedule

    a = _id()
    await seed_members(ORG, a)
    schedule_id = await _series({"kind": "RELATIVE", "amount": 1, "unit": "HOURS", "timeZone": NY}, a)
    long_ago = datetime.now(UTC) - timedelta(hours=5)
    await _x("UPDATE task_schedules SET start_at = :t, next_run_at = :t WHERE id = :i", t=long_ago, i=schedule_id)
    assert str(await _claim_due_schedule()) == schedule_id
    [task] = await _q("SELECT id, deadline_at FROM tasks WHERE schedule_id = :s", s=schedule_id)
    assert task.deadline_at == long_ago + timedelta(hours=1)
    assert await _sweep() == 1
    assert (await _status(str(task.id), a)).status == "MISSED"


# ── Schema ─────────────────────────────────────────────────────────────────────
async def test_the_database_refuses_an_inconsistent_deadline_rule(db_app, seed_members):
    from sqlalchemy.exc import IntegrityError

    a = _id()
    await seed_members(ORG, a)
    schedule_id = await _series({"kind": "RELATIVE", "amount": 6, "unit": "HOURS", "timeZone": NY}, a)
    for bad in (
        "deadline_unit = 'WEEKS'",
        "deadline_amount = 0",
        "deadline_kind = 'FIXED_TIME'",  # keeps amount/unit, has no time
        "deadline_tz = NULL",
        "deadline_at = now()",  # an absolute deadline on a recurring series
    ):
        with pytest.raises(IntegrityError):
            await _x(f"UPDATE task_schedules SET {bad} WHERE id = :s", s=schedule_id)


async def test_migrations_apply_twice_cleanly(db_app, database_url):
    """Re-running the whole chain (every boot does) is a no-op. Migrations are
    applied as the OWNER, like the service does; the app role cannot run DDL."""
    from app.config import settings
    from app.db import dispose_engine, init_engine, run_migrations

    app_url = settings.task_database_url
    await dispose_engine()
    settings.task_database_url = database_url
    try:
        init_engine()
        await run_migrations()
        await run_migrations()
    finally:
        await dispose_engine()
        settings.task_database_url = app_url
        init_engine()
    cols = {
        r.column_name
        for r in await _q(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name IN ('tasks', 'task_assignees', 'task_schedules')"
        )
    }
    assert {"deadline_at", "deadline_swept_at", "missed_at", "deadline_kind", "deadline_tz"} <= cols


# ── The background worker itself ───────────────────────────────────────────────
async def _wait_until(predicate, timeout: float = 10.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if await predicate():
            return True
        await asyncio.sleep(0.05)
    return False


async def test_the_worker_misses_a_due_task_on_its_own_with_nobody_online(db_app, seed_members, monkeypatch):
    """No request, no websocket, no user: the loop alone moves the assignment to
    MISSED once the deadline has passed — and does nothing before."""
    from app import deadlines

    monkeypatch.setattr(deadlines, "POLL_SECONDS", 0.05)
    a = _id()
    await seed_members(ORG, a)
    due = await _instant([a], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    later = await _instant([a], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))
    await _expire(due)

    worker = deadlines.DeadlineWorker()
    await worker.start()
    try:
        assert await _wait_until(lambda: _is(due, a, "MISSED"))
        await asyncio.sleep(0.3)
        assert (await _status(later, a)).status == "SENT"
        assert len(await _missed_events(due)) == 1
    finally:
        await worker.stop()


async def test_a_restarted_worker_picks_up_what_a_stopped_one_left(db_app, seed_members, monkeypatch):
    """A deadline that passed while the service was down is recorded as soon as a
    worker runs again; nothing about the missed state lives in a worker's memory."""
    from app import deadlines

    monkeypatch.setattr(deadlines, "POLL_SECONDS", 0.05)
    a = _id()
    await seed_members(ORG, a)
    task_id = await _instant([a], deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1)))

    first = deadlines.DeadlineWorker()
    await first.start()
    await first.stop()  # the service goes down...
    await _expire(task_id)  # ...the deadline passes meanwhile...
    assert (await _status(task_id, a)).status == "SENT"

    second = deadlines.DeadlineWorker()  # ...and it comes back
    await second.start()
    try:
        assert await _wait_until(lambda: _is(task_id, a, "MISSED"))
    finally:
        await second.stop()
    assert len(await _missed_events(task_id)) == 1


async def test_two_workers_running_together_miss_each_assignment_once(db_app, seed_members, monkeypatch):
    from app import deadlines

    monkeypatch.setattr(deadlines, "POLL_SECONDS", 0.02)
    users = [_id() for _ in range(4)]
    await seed_members(ORG, *users)
    task_ids = [await _instant(users, deadlineAt=_iso(datetime.now(UTC) + timedelta(hours=1))) for _ in range(10)]
    for task_id in task_ids:
        await _expire(task_id)

    workers = [deadlines.DeadlineWorker(), deadlines.DeadlineWorker()]
    for w in workers:
        await w.start()
    try:
        async def all_missed() -> bool:
            rows = await _q("SELECT status FROM task_assignees")
            return all(r.status == "MISSED" for r in rows)

        assert await _wait_until(all_missed)
        await asyncio.sleep(0.3)  # long enough for a duplicate to show up, if there were one
    finally:
        for w in workers:
            await w.stop()
    events = [e for t in task_ids for e in await _missed_events(t)]
    assert len(events) == len(users) * len(task_ids)
    assert {r.status_version for r in await _q("SELECT status_version FROM task_assignees")} == {1}


async def _is(task_id: str, user_id: str, status: str) -> bool:
    return (await _status(task_id, user_id)).status == status
