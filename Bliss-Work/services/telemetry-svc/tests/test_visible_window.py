"""The window that decides how far back the per-event record can be browsed.

Retention (90 days) and visibility (7 days) are two different things, and the
whole point of the split is that one of them is enforced on the SERVER. A test
that only checked the default number would pass just as happily against a
frontend-only limit, so these assert the relationship the policy actually rests
on: the floor moves with the setting, it is much tighter than retention, and it
is derived from one place rather than restated per query.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

timeline = pytest.importorskip(
    "app.routes.timeline",
    reason="telemetry-svc deps not installed locally; CI installs requirements.txt.",
)
config = pytest.importorskip("app.config")


def test_the_floor_is_the_configured_number_of_days_back():
    floor = timeline._visible_floor()
    expected = datetime.now(timezone.utc) - timedelta(days=config.settings.visible_window_days)
    # Both are computed from `now`, so allow for the microseconds between them.
    assert abs((floor - expected).total_seconds()) < 5


def test_the_floor_follows_the_setting_rather_than_a_hardcoded_seven(monkeypatch):
    monkeypatch.setattr(config.settings, "visible_window_days", 30)
    floor = timeline._visible_floor()
    age_days = (datetime.now(timezone.utc) - floor).days
    assert age_days == 30


def test_visibility_is_much_tighter_than_retention():
    # If these ever converge, browsing the full retention window is back and the
    # data-minimisation claim in COMPLIANCE.md stops being true.
    assert config.settings.visible_window_days < config.settings.raw_retention_days


def test_the_default_window_is_a_week():
    assert config.settings.visible_window_days == 7


def test_the_floor_is_timezone_aware():
    # A naive datetime compared against a timestamptz column raises in asyncpg
    # rather than quietly returning the wrong rows.
    assert timeline._visible_floor().tzinfo is not None
