"""Deadline rule resolution and request validation (pure logic; no DB / Kafka).

`resolve_deadline` is where "every day at 10:00 + 6 hours" becomes 4:00 PM for ONE
occurrence, and where a DST change could silently move a deadline by an hour, so
the transitions are pinned here against the real tz database rather than
re-derived by hand.

New York in 2026: clocks go FORWARD on Sun 8 Mar (02:00 EST -> 03:00 EDT, UTC-5 ->
UTC-4) and BACK on Sun 1 Nov (02:00 EDT -> 01:00 EST).
"""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.deadlines import DeadlineRule, resolve_deadline
from app.schemas import CreateTaskRequest, DeadlineRuleSpec, RecurrenceSpec

UTC = timezone.utc
NY = "America/New_York"
_UID = "11111111-1111-1111-1111-111111111111"


def _local(dt: datetime, tz: str = NY) -> str:
    from zoneinfo import ZoneInfo

    return dt.astimezone(ZoneInfo(tz)).strftime("%a %Y-%m-%d %H:%M")


def _rel(amount: int, unit: str, tz: str = NY) -> DeadlineRule:
    return DeadlineRule(kind="RELATIVE", tz=tz, amount=amount, unit=unit)


def _fixed(hhmm: str, tz: str = NY) -> DeadlineRule:
    hour, minute = (int(p) for p in hhmm.split(":"))
    return DeadlineRule(kind="FIXED_TIME", tz=tz, time_of_day=time(hour, minute))


# ── The three worked examples from the requirements ─────────────────────────────
def test_daily_10am_plus_six_hours_is_4pm_that_day() -> None:
    occurrence = datetime(2026, 9, 30, 14, 0, tzinfo=UTC)  # 10:00 EDT
    assert _local(resolve_deadline(_rel(6, "HOURS"), occurrence)) == "Wed 2026-09-30 16:00"


def test_monday_10am_plus_24_hours_is_tuesday_10am() -> None:
    occurrence = datetime(2026, 9, 28, 14, 0, tzinfo=UTC)  # Mon 10:00 EDT
    assert _local(resolve_deadline(_rel(24, "HOURS"), occurrence)) == "Tue 2026-09-29 10:00"


def test_monday_10am_fixed_5pm_is_monday_5pm() -> None:
    occurrence = datetime(2026, 9, 28, 14, 0, tzinfo=UTC)
    assert _local(resolve_deadline(_fixed("17:00"), occurrence)) == "Mon 2026-09-28 17:00"


# ── Units ───────────────────────────────────────────────────────────────────────
def test_minutes() -> None:
    occurrence = datetime(2026, 9, 28, 14, 0, tzinfo=UTC)
    assert resolve_deadline(_rel(90, "MINUTES"), occurrence) == occurrence + timedelta(minutes=90)


def test_each_occurrence_gets_its_own_deadline() -> None:
    rule = _rel(6, "HOURS")
    days = [datetime(2026, 9, 28 + i, 14, 0, tzinfo=UTC) for i in range(3)]
    deadlines = [resolve_deadline(rule, d) for d in days]
    assert deadlines == [d + timedelta(hours=6) for d in days]


# ── DST ─────────────────────────────────────────────────────────────────────────
def test_fixed_time_keeps_the_wall_clock_across_spring_forward() -> None:
    # Sat 7 Mar 10:00 EST vs Mon 9 Mar 10:00 EDT: the occurrence's UTC time moves by
    # an hour, the 17:00 local deadline must not.
    before = resolve_deadline(_fixed("17:00"), datetime(2026, 3, 7, 15, 0, tzinfo=UTC))
    after = resolve_deadline(_fixed("17:00"), datetime(2026, 3, 9, 14, 0, tzinfo=UTC))
    assert _local(before) == "Sat 2026-03-07 17:00"
    assert _local(after) == "Mon 2026-03-09 17:00"
    assert before.hour == 22 and after.hour == 21  # UTC differs, wall clock does not


def test_fixed_time_keeps_the_wall_clock_across_fall_back() -> None:
    before = resolve_deadline(_fixed("17:00"), datetime(2026, 10, 31, 14, 0, tzinfo=UTC))
    after = resolve_deadline(_fixed("17:00"), datetime(2026, 11, 2, 15, 0, tzinfo=UTC))
    assert _local(before) == "Sat 2026-10-31 17:00"
    assert _local(after) == "Mon 2026-11-02 17:00"


def test_one_day_is_a_calendar_day_across_spring_forward() -> None:
    # Sat 10:00 EST + 1 day = Sun 10:00 EDT (23 elapsed hours).
    occurrence = datetime(2026, 3, 7, 15, 0, tzinfo=UTC)
    result = resolve_deadline(_rel(1, "DAYS"), occurrence)
    assert _local(result) == "Sun 2026-03-08 10:00"
    assert result - occurrence == timedelta(hours=23)


def test_one_day_is_a_calendar_day_across_fall_back() -> None:
    occurrence = datetime(2026, 10, 31, 14, 0, tzinfo=UTC)  # Sat 10:00 EDT
    result = resolve_deadline(_rel(1, "DAYS"), occurrence)
    assert _local(result) == "Sun 2026-11-01 10:00"
    assert result - occurrence == timedelta(hours=25)


def test_24_hours_is_elapsed_time_not_a_calendar_day() -> None:
    occurrence = datetime(2026, 3, 7, 15, 0, tzinfo=UTC)  # Sat 10:00 EST
    result = resolve_deadline(_rel(24, "HOURS"), occurrence)
    assert result - occurrence == timedelta(hours=24)
    assert _local(result) == "Sun 2026-03-08 11:00"  # one wall-clock hour later


def test_a_fixed_time_inside_the_spring_forward_gap_moves_forward() -> None:
    # 02:30 does not exist on 8 Mar in New York; it resolves to 03:30 EDT.
    result = resolve_deadline(_fixed("02:30"), datetime(2026, 3, 8, 6, 0, tzinfo=UTC))  # 01:00 EST
    assert _local(result) == "Sun 2026-03-08 03:30"


def test_a_fixed_time_in_the_fall_back_overlap_takes_the_first_occurrence() -> None:
    # 01:30 happens twice on 1 Nov; the first one is EDT (UTC-4) = 05:30Z.
    result = resolve_deadline(_fixed("01:30"), datetime(2026, 11, 1, 4, 0, tzinfo=UTC))  # 00:00 EDT
    assert result == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)


def test_the_occurrence_date_is_read_in_the_rules_zone_not_utc() -> None:
    # 23:30 EDT Mon is 03:30Z TUESDAY. A 23:45 deadline belongs to Monday.
    occurrence = datetime(2026, 9, 29, 3, 30, tzinfo=UTC)
    assert _local(resolve_deadline(_fixed("23:45"), occurrence)) == "Mon 2026-09-28 23:45"


def test_a_zone_without_dst_is_unaffected() -> None:
    occurrence = datetime(2026, 3, 7, 15, 0, tzinfo=UTC)
    result = resolve_deadline(_fixed("17:00", "Asia/Kolkata"), occurrence)
    assert _local(result, "Asia/Kolkata") == "Sat 2026-03-07 17:00"


# ── Request validation ──────────────────────────────────────────────────────────
def _future(**delta) -> datetime:
    return datetime.now(UTC) + timedelta(**delta)


def test_no_deadline_is_valid_everywhere() -> None:
    assert CreateTaskRequest(taskTitle="t", title="t", assigneeIds=[_UID]).deadlineAt is None
    req = CreateTaskRequest(
        taskTitle="t", title="t", assigneeIds=[_UID], allocation="RECURRING",
        recurrence={"startAt": _future(days=1), "frequency": "DAILY"},
    )
    assert req.recurrence.deadline is None


def test_an_absolute_deadline_on_an_instant_task() -> None:
    deadline = _future(hours=2)
    assert CreateTaskRequest(taskTitle="t", title="t", assigneeIds=[_UID], deadlineAt=deadline).deadlineAt == deadline


def test_a_deadline_in_the_past_is_refused() -> None:
    with pytest.raises(ValidationError):
        CreateTaskRequest(taskTitle="t", title="t", assigneeIds=[_UID], deadlineAt=_future(minutes=-1))


def test_a_deadline_must_include_a_timezone() -> None:
    with pytest.raises(ValidationError):
        CreateTaskRequest(taskTitle="t", title="t", assigneeIds=[_UID], deadlineAt=datetime.now() + timedelta(days=1))


def test_a_scheduled_deadline_must_be_after_the_scheduled_time() -> None:
    when = _future(days=2)
    with pytest.raises(ValidationError):
        CreateTaskRequest(taskTitle="t", title="t", assigneeIds=[_UID], allocation="SCHEDULED", scheduledFor=when, deadlineAt=when)
    ok = CreateTaskRequest(
        taskTitle="t", title="t", assigneeIds=[_UID], allocation="SCHEDULED", scheduledFor=when, deadlineAt=when + timedelta(hours=1)
    )
    assert ok.deadlineAt == when + timedelta(hours=1)


def test_a_recurring_task_cannot_take_an_absolute_deadline() -> None:
    with pytest.raises(ValidationError):
        CreateTaskRequest(
            taskTitle="t", title="t", assigneeIds=[_UID], allocation="RECURRING", deadlineAt=_future(days=3),
            recurrence={"startAt": _future(days=1), "frequency": "DAILY"},
        )


@pytest.mark.parametrize(
    "rule",
    [
        {"kind": "RELATIVE", "timeZone": NY},  # no amount/unit
        {"kind": "RELATIVE", "amount": 6, "timeZone": NY},  # no unit
        {"kind": "RELATIVE", "amount": 0, "unit": "HOURS", "timeZone": NY},
        {"kind": "RELATIVE", "amount": 367, "unit": "DAYS", "timeZone": NY},  # > 366 days
        {"kind": "RELATIVE", "amount": 6, "unit": "HOURS", "time": "17:00", "timeZone": NY},
        {"kind": "FIXED_TIME", "timeZone": NY},  # no time
        {"kind": "FIXED_TIME", "time": "25:00", "timeZone": NY},
        {"kind": "FIXED_TIME", "time": "5pm", "timeZone": NY},
        {"kind": "FIXED_TIME", "time": "17:00", "amount": 1, "unit": "HOURS", "timeZone": NY},
        {"kind": "FIXED_TIME", "time": "17:00", "timeZone": "Mars/Olympus"},
        {"kind": "FIXED_TIME", "time": "17:00", "timeZone": ""},
    ],
)
def test_malformed_rules_are_refused(rule: dict) -> None:
    with pytest.raises(ValidationError):
        DeadlineRuleSpec(**rule)


def test_a_fixed_time_not_after_the_start_time_is_refused() -> None:
    from zoneinfo import ZoneInfo

    start = _future(days=2).astimezone(ZoneInfo(NY)).replace(hour=10, minute=0, second=0, microsecond=0)
    base = {"startAt": start, "frequency": "DAILY"}
    for bad in ("10:00", "09:59", "00:00"):
        with pytest.raises(ValidationError):
            RecurrenceSpec(**base, deadline={"kind": "FIXED_TIME", "time": bad, "timeZone": NY})
    assert RecurrenceSpec(**base, deadline={"kind": "FIXED_TIME", "time": "10:01", "timeZone": NY}).deadline


def test_a_relative_rule_is_valid_for_every_unit() -> None:
    for unit in ("MINUTES", "HOURS", "DAYS"):
        rule = DeadlineRuleSpec(kind="RELATIVE", amount=1, unit=unit, timeZone=NY)
        assert rule.amount == 1 and rule.unit == unit
