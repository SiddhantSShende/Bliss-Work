from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.schedule_worker import next_occurrence


UTC = timezone.utc


def test_daily_recurrence_uses_interval() -> None:
    current = datetime(2026, 9, 30, 10, 0, tzinfo=UTC)
    assert next_occurrence(
        current,
        start_at=current,
        frequency="DAILY",
        interval=2,
        weekdays=[],
        monthly_rule=None,
        monthly_day=None,
        monthly_ordinal=None,
        monthly_weekday=None,
    ) == current + timedelta(days=2)


def test_weekly_recurrence_skips_to_selected_weekday() -> None:
    current = datetime(2026, 9, 28, 10, 0, tzinfo=UTC)  # Monday
    result = next_occurrence(
        current,
        start_at=current,
        frequency="WEEKLY",
        interval=1,
        weekdays=[2],
        monthly_rule=None,
        monthly_day=None,
        monthly_ordinal=None,
        monthly_weekday=None,
    )
    assert result == datetime(2026, 9, 30, 10, 0, tzinfo=UTC)


def test_monthly_day_rule_advances_month() -> None:
    current = datetime(2026, 9, 30, 10, 0, tzinfo=UTC)
    result = next_occurrence(
        current,
        start_at=current,
        frequency="MONTHLY",
        interval=1,
        weekdays=[],
        monthly_rule="DAY_OF_MONTH",
        monthly_day=30,
        monthly_ordinal=None,
        monthly_weekday=None,
    )
    assert result == datetime(2026, 10, 30, 10, 0, tzinfo=UTC)


def test_monthly_weekday_pattern_advances_to_first_monday() -> None:
    current = datetime(2026, 9, 7, 10, 0, tzinfo=UTC)
    result = next_occurrence(
        current,
        start_at=current,
        frequency="MONTHLY",
        interval=1,
        weekdays=[],
        monthly_rule="WEEKDAY_PATTERN",
        monthly_day=None,
        monthly_ordinal=1,
        monthly_weekday=0,
    )
    assert result == datetime(2026, 10, 5, 10, 0, tzinfo=UTC)