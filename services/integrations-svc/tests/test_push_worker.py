"""Push worker — the timestamp parsing that decides renewal.

These two functions look like plumbing but each has a failure mode that turns
the renewal loop pathological rather than broken, which is much harder to spot:
a misread Gmail expiry re-arms the watch on every sweep, and an unparsed Graph
expiry makes every subscription look permanently due.
"""

from datetime import datetime, timezone

import pytest

from app.push_worker import _epoch_ms_to_dt, _parse_graph_datetime


# ── Gmail watch expiration ────────────────────────────────────────────────────
def test_gmail_expiration_is_milliseconds_not_seconds():
    """THE bug this guards.

    Gmail returns `expiration` as epoch MILLISECONDS in a string. Reading it as
    seconds puts expiry in 1970, so needs_renewal() is true forever and the
    worker re-arms the watch on every single sweep — burning quota while looking
    like it is working.
    """
    # 2026-08-02T12:00:00Z in ms
    ms_value = "1785585600000"
    out = _epoch_ms_to_dt(ms_value)
    assert out is not None
    assert out.year == 2026 and out.month == 8
    assert out.tzinfo is timezone.utc


def test_gmail_expiration_accepts_an_int():
    assert _epoch_ms_to_dt(1785585600000).year == 2026


@pytest.mark.parametrize("value", [None, "", "not-a-number", {}, [], "12.5.6"])
def test_unparseable_gmail_expiration_is_none(value):
    # None means "unknown", which needs_renewal() treats as renew-now. Safe: an
    # unnecessary renewal costs one call, a missed one costs every notification.
    assert _epoch_ms_to_dt(value) is None


# ── Graph expirationDateTime ──────────────────────────────────────────────────
def test_parses_graphs_trailing_z():
    out = _parse_graph_datetime("2026-07-26T12:00:00Z")
    assert out == datetime(2026, 7, 26, 12, 0, tzinfo=timezone.utc)


def test_parses_graphs_seven_digit_fractional_seconds():
    # Graph emits 7 fractional digits; datetime accepts at most 6, so the raw
    # string raises ValueError. Unparsed -> None -> renew-now, which would make
    # every Graph subscription look permanently due.
    out = _parse_graph_datetime("2026-07-26T12:00:00.1234567Z")
    assert out is not None
    assert out.year == 2026 and out.hour == 12
    assert out.tzinfo is not None


def test_parses_six_digit_fractional_seconds():
    out = _parse_graph_datetime("2026-07-26T12:00:00.123456Z")
    assert out is not None and out.microsecond == 123456


def test_parses_an_explicit_offset():
    out = _parse_graph_datetime("2026-07-26T12:00:00+02:00")
    assert out is not None and out.utcoffset().total_seconds() == 7200


@pytest.mark.parametrize("value", [None, "", "not a date", "2026-13-45T99:99:99Z"])
def test_unparseable_graph_datetime_is_none(value):
    assert _parse_graph_datetime(value) is None


def test_parsed_expiry_is_comparable_to_now():
    # The whole point is feeding needs_renewal(); a naive/aware mismatch would
    # raise there and take out the renewal sweep.
    from app.push_backoff import needs_renewal

    out = _parse_graph_datetime("2036-07-26T12:00:00.1234567Z")
    assert needs_renewal(out) is False  # far future -> not due
