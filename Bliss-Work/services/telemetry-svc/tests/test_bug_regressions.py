from __future__ import annotations

import base64
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app import cursor, ingest, sessions
from app.routes import analytics
from app.schemas import Beacon, BeaconEvent

NOW = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)


def _raw_cursor(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


def test_server_event_backdate_is_preserved_but_future_skew_is_still_bounded():
    late = NOW - timedelta(days=365)
    assert ingest.clamp_occurred_at(late, NOW, source="server") == late
    assert ingest.clamp_occurred_at(
        NOW + timedelta(days=365), NOW, source="server"
    ) == NOW + timedelta(seconds=ingest.settings.max_clock_skew_future_seconds)


def test_client_event_backdate_remains_bounded():
    late = NOW - timedelta(days=365)
    assert ingest.clamp_occurred_at(late, NOW, source="desktop") == NOW - timedelta(
        seconds=ingest.settings.max_clock_backdate_seconds
    )


def test_compressed_ipv6_prefix_obeys_the_existing_slash_48_policy():
    assert sessions.ip_prefix("2001:db8::1") == "2001:db8::/48"
    assert sessions.ip_prefix("2001:db8:1234:5678::1") == "2001:db8:1234::/48"
    assert sessions.ip_prefix("2001:db8::ffff") == "2001:db8::/48"


@pytest.mark.parametrize("value", [0, 86_400_000])
def test_beacon_duration_inclusive_limits(value: int):
    event = BeaconEvent(action="app.focus", durationMs=value)
    beacon = Beacon(activeMs=value, idleMs=value)
    assert event.durationMs == value
    assert beacon.activeMs == value
    assert beacon.idleMs == value


@pytest.mark.parametrize("value", [-1, 86_400_001])
def test_beacon_duration_outside_limits_is_rejected(value: int):
    with pytest.raises(ValidationError):
        BeaconEvent(action="app.focus", durationMs=value)
    with pytest.raises(ValidationError):
        Beacon(activeMs=value)
    with pytest.raises(ValidationError):
        Beacon(idleMs=value)


def test_session_id_must_be_a_uuid_and_is_canonicalized():
    canonical = str(uuid.uuid4())
    assert Beacon(sessionId=canonical.upper()).sessionId == canonical
    with pytest.raises(ValidationError):
        Beacon(sessionId="not-a-uuid")


def test_cursor_requires_a_zoned_timestamp_and_uuid():
    timestamp = NOW.isoformat()
    expected_id = str(uuid.uuid4())
    encoded = cursor.encode_cursor(NOW, expected_id)
    decoded_at, decoded_id = cursor.decode_cursor(encoded)
    assert decoded_at == NOW
    assert decoded_id == expected_id

    for malformed in (
        "",
        "!!!",
        _raw_cursor(f"{timestamp}|not-a-uuid"),
        _raw_cursor(f"2026-10-08T12:00:00|{expected_id}"),
        _raw_cursor(f"{timestamp}|{expected_id}|extra"),
        "A" * 129,
    ):
        with pytest.raises(ValueError):
            cursor.decode_cursor(malformed)


def test_analytics_day_boundaries_follow_rollup_timezone(monkeypatch):
    monkeypatch.setattr(analytics.settings, "rollup_timezone", "America/Los_Angeles")
    day = datetime(2026, 3, 8).date()
    start, end = analytics._day_bounds(day)
    assert (end - start) == timedelta(hours=23)
    assert start == datetime(2026, 3, 8, 8, tzinfo=timezone.utc)
    assert end == datetime(2026, 3, 9, 7, tzinfo=timezone.utc)


def test_live_session_query_clips_overlapping_sessions_and_events():
    sql = str(analytics._LIVE_SESSION_TOTALS)
    assert "started_at < :end" in sql
    assert "COALESCE(ended_at, now()) >= :start" in sql
    assert "GREATEST(started_at, :start)" in sql
    assert "LEAST(COALESCE(ended_at, now()), :end)" in sql
    assert "active_ms * day_online_ms / total_online_ms" in sql
