"""A schedule whose channel can no longer be resolved must not take the rest of
the scheduler down with it.

Behaviour under test (see schedule_worker._resolve_targets / _claim_due_schedule):
  * a channel messaging-svc answers 404 for (deleted, or the sender left it) is
    SKIPPED for that occurrence — no members, not attached to the task — while the
    named people and the other channels still materialize; it stays on the
    schedule, so a later occurrence takes it again if it comes back;
  * any other failure (messaging-svc down) is never skipped, because that would
    silently drop recipients: the whole schedule is parked and retried;
  * a schedule with nobody left to assign, or one that raises, is rolled back
    whole, parked for PARK_SECONDS and left ACTIVE — and never holds up the
    schedules behind it.
"""

# ruff: noqa: F401, F811  -- `channels` is a pytest fixture imported by name, then requested as an argument.
from __future__ import annotations

import pytest
from sqlalchemy import text

from .test_create_task_mixed_targets import (
    ORG,
    _assignees,
    _create,
    _id,
    _make_due,
    _q,
    _schedule,
    _task_channels,
    _task_count,
    channels,
)

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _unpark():
    from app import schedule_worker

    schedule_worker._parked_until.clear()
    yield
    schedule_worker._parked_until.clear()


async def _run() -> int:
    from app.schedule_worker import run_due_schedules_once

    return await run_due_schedules_once()


async def _tasks_of(schedule_id: str) -> list[str]:
    return [str(r.id) for r in await _q("SELECT id FROM tasks WHERE schedule_id = :s", s=schedule_id)]


async def _schedule_row(schedule_id: str):
    return (await _q("SELECT status, occurrence_count, channel_ids FROM task_schedules WHERE id = :s", s=schedule_id))[0]


async def _make_older(schedule_id: str) -> None:
    """Due, and due LONGER ago than anything made due after it."""
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text("UPDATE task_schedules SET next_run_at = now() - interval '1 hour' WHERE id = :i"),
            {"i": schedule_id},
        )


# 1 ──────────────────────────────────────────────────────────────────────────
async def test_person_valid_channel_and_dead_channel_materialize_without_the_dead_one(db_app, seed_members, channels):
    a, ok, dead, member = _id(), _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[ok], channels[dead] = [member], [_id()]
    schedule_id = await _schedule(assigneeIds=[a], channelIds=[ok, dead])
    channels[dead] = "dead"
    await _make_due(schedule_id)

    assert await _run() == 1

    (task_id,) = await _tasks_of(schedule_id)
    assert await _assignees(task_id) == sorted([a, member])
    assert await _task_channels(task_id) == [ok]  # the dead channel is not attached
    row = await _schedule_row(schedule_id)
    assert row.status == "COMPLETED"
    assert [str(c) for c in row.channel_ids] == [ok, dead]  # still on the schedule


# 2 ──────────────────────────────────────────────────────────────────────────
async def test_one_dead_channel_among_valid_ones_does_not_block_them(db_app, channels):
    ch_a, ch_b, ch_c, m_a, m_c = _id(), _id(), _id(), _id(), _id()
    channels[ch_a], channels[ch_b], channels[ch_c] = [m_a], [_id()], [m_c]
    schedule_id = await _schedule(channelIds=[ch_a, ch_b, ch_c])
    channels[ch_b] = "dead"
    await _make_due(schedule_id)

    assert await _run() == 1

    (task_id,) = await _tasks_of(schedule_id)
    assert await _assignees(task_id) == sorted([m_a, m_c])
    assert await _task_channels(task_id) == sorted([ch_a, ch_c])


# 3 ──────────────────────────────────────────────────────────────────────────
async def test_named_people_still_receive_it_when_every_channel_is_dead(db_app, seed_members, channels):
    a, c1, c2 = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c1], channels[c2] = [_id()], [_id()]
    schedule_id = await _schedule(assigneeIds=[a], channelIds=[c1, c2])
    channels[c1] = channels[c2] = "dead"
    await _make_due(schedule_id)

    assert await _run() == 1

    (task_id,) = await _tasks_of(schedule_id)
    assert await _assignees(task_id) == [a]
    assert await _task_channels(task_id) == []


# 4 ──────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("answer", ["dead", []], ids=["all channels dead", "channel has no members"])
async def test_a_schedule_with_nobody_left_is_parked_and_left_active_not_retried_every_poll(
    db_app, channels, monkeypatch, answer
):
    from app import schedule_worker

    c, m = _id(), _id()
    channels[c] = [m]
    schedule_id = await _schedule(channelIds=[c])
    channels[c] = answer
    await _make_due(schedule_id)

    asked = 0
    real = schedule_worker._resolve_channel_members

    async def counting(*args):
        nonlocal asked
        asked += 1
        return await real(*args)

    monkeypatch.setattr(schedule_worker, "_resolve_channel_members", counting)

    assert await _run() == 0
    assert await _task_count() == 0
    row = await _schedule_row(schedule_id)
    assert (row.status, row.occurrence_count) == ("ACTIVE", 0)  # untouched: still listed and cancellable

    # Polling again does not even look at it until the park expires...
    assert await _run() == 0
    assert asked == 1

    # ...and when the channel comes back it is picked up, with nothing lost.
    channels[c] = [m]
    schedule_worker._parked_until.clear()  # the park elapsing
    assert await _run() == 1
    (task_id,) = await _tasks_of(schedule_id)
    assert await _assignees(task_id) == [m]


# 5 ──────────────────────────────────────────────────────────────────────────
async def test_an_oldest_schedule_with_a_dead_channel_does_not_starve_the_valid_one_behind_it(db_app, channels):
    bad_ch, good_ch, member = _id(), _id(), _id()
    channels[bad_ch], channels[good_ch] = [_id()], [member]
    bad = await _schedule(channelIds=[bad_ch])
    good = await _schedule(channelIds=[good_ch])
    channels[bad_ch] = "dead"
    await _make_due(good)
    await _make_due(bad)
    await _make_older(bad)  # the first thing the claim query would pick

    assert await _run() == 1

    assert await _tasks_of(bad) == []
    (task_id,) = await _tasks_of(good)
    assert await _assignees(task_id) == [member]


async def test_a_transient_outage_is_never_treated_as_a_dead_channel(db_app, seed_members, channels):
    """Skipping on a 503 would silently drop the channel's members from a task that
    then looks complete. The schedule is parked whole instead, with nothing
    written, and goes out in full once messaging-svc is back."""
    from app import schedule_worker

    a, ok, flaky, m_ok, m_flaky = _id(), _id(), _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[ok], channels[flaky] = [m_ok], [m_flaky]
    schedule_id = await _schedule(assigneeIds=[a], channelIds=[ok, flaky])
    other = await _schedule(assigneeIds=[a])
    channels[flaky] = "down"
    await _make_due(other)
    await _make_due(schedule_id)
    await _make_older(schedule_id)

    assert await _run() == 1  # the unrelated one, behind it, still went out

    assert await _tasks_of(schedule_id) == []  # not even the valid half
    assert (await _schedule_row(schedule_id)).status == "ACTIVE"

    channels[flaky] = [m_flaky]
    schedule_worker._parked_until.clear()
    assert await _run() == 1
    (task_id,) = await _tasks_of(schedule_id)
    assert await _assignees(task_id) == sorted([a, m_ok, m_flaky])
    assert await _task_channels(task_id) == sorted([ok, flaky])


async def test_a_schedule_that_raises_midway_leaves_no_partial_task_and_does_not_starve_the_rest(
    db_app, seed_members, channels, monkeypatch
):
    from app import schedule_worker

    a, bad_ch, good_ch, member = _id(), _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[bad_ch], channels[good_ch] = [_id()], [member]
    bad = await _schedule(assigneeIds=[a], channelIds=[bad_ch])
    good = await _schedule(channelIds=[good_ch])
    await _make_due(good)
    await _make_due(bad)
    await _make_older(bad)

    real = schedule_worker._insert_task_channels

    async def failing(db, *, org_id, task_id, channel_ids):
        if bad_ch in channel_ids:  # AFTER the tasks row and assignees are already written
            raise RuntimeError("boom")
        await real(db, org_id=org_id, task_id=task_id, channel_ids=channel_ids)

    monkeypatch.setattr(schedule_worker, "_insert_task_channels", failing)

    assert await _run() == 1

    assert await _tasks_of(bad) == []  # the half-written occurrence was rolled back
    assert await _assignees_of_schedule(bad) == []
    assert await _tasks_of(good) != []


async def _assignees_of_schedule(schedule_id: str) -> list:
    return await _q(
        "SELECT a.assignee_id FROM task_assignees a JOIN tasks t ON t.id = a.task_id WHERE t.schedule_id = :s",
        s=schedule_id,
    )


# 6 ──────────────────────────────────────────────────────────────────────────
async def test_valid_schedules_are_unchanged_and_all_go_out_in_one_pass(db_app, seed_members, channels):
    a, c, member = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[c] = [member]
    first = await _schedule(assigneeIds=[a], channelIds=[c])
    second = await _schedule(assigneeIds=[a])
    await _make_due(first)
    await _make_due(second)

    assert await _run() == 2

    (t1,), (t2,) = await _tasks_of(first), await _tasks_of(second)
    assert await _assignees(t1) == sorted([a, member])
    assert await _task_channels(t1) == [c]
    assert await _assignees(t2) == [a]
    assert await _task_channels(t2) == []


# 7 ──────────────────────────────────────────────────────────────────────────
async def test_a_dead_channel_does_not_stop_later_occurrences_and_returns_when_it_comes_back(
    db_app, seed_members, channels
):
    from datetime import datetime, timedelta, timezone

    a, ok, flaky, m_ok, m_flaky = _id(), _id(), _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[ok], channels[flaky] = [m_ok], [m_flaky]
    start = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    r = await _create(
        allocation="RECURRING",
        recurrence={"startAt": start, "frequency": "DAILY", "interval": 1, "endCondition": "NO_END"},
        assigneeIds=[a],
        channelIds=[ok, flaky],
    )
    assert r.status_code == 201, r.text
    schedule_id = r.json()["scheduleId"]
    channels[flaky] = "dead"

    for _ in range(2):  # two occurrences while it is dead
        await _make_due(schedule_id)
        assert await _run() == 1
    channels[flaky] = [m_flaky]  # ...then it is resolvable again
    await _make_due(schedule_id)
    assert await _run() == 1

    row = await _schedule_row(schedule_id)
    assert (row.status, row.occurrence_count) == ("ACTIVE", 3)
    by_number = {
        r.occurrence_number: str(r.id)
        for r in await _q("SELECT id, occurrence_number FROM tasks WHERE schedule_id = :s", s=schedule_id)
    }
    for n in (1, 2):
        assert await _assignees(by_number[n]) == sorted([a, m_ok])
        assert await _task_channels(by_number[n]) == [ok]
    assert await _assignees(by_number[3]) == sorted([a, m_ok, m_flaky])
    assert await _task_channels(by_number[3]) == sorted([ok, flaky])
