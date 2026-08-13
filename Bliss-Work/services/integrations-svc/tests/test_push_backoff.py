"""Worker scheduling arithmetic.

Pure functions, so every rule can be pinned exactly. Two of them carry real
consequences: honoring a provider's Retry-After (ignoring it is how a
rate-limited connection gets throttled harder), and treating an unknown
subscription expiry as "renew now" (a lapsed subscription stops delivering
silently, with no error to notice).
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.push_backoff import (
    BASE_INTERVAL_SECONDS,
    MAX_BACKOFF_SECONDS,
    RENEW_MARGIN_SECONDS,
    backoff_delay,
    needs_renewal,
    next_attempt_at,
)

NOW = datetime(2026, 7, 26, 12, 0, 0, tzinfo=timezone.utc)


# ── backoff ───────────────────────────────────────────────────────────────────
def test_healthy_connection_uses_the_normal_cadence():
    assert backoff_delay(0) == BASE_INTERVAL_SECONDS


@pytest.mark.parametrize(
    "failures,expected",
    [(1, 60), (2, 120), (3, 240), (4, 480), (5, 960)],
)
def test_backoff_doubles_from_one_minute(failures, expected):
    assert backoff_delay(failures) == expected


@pytest.mark.parametrize("failures", [6, 10, 50, 1000])
def test_backoff_is_capped(failures):
    # A connection broken for hours must still retry occasionally: the fix (an
    # admin re-authorizing) is invisible to us, so backing off to "effectively
    # never" would prevent it from ever self-healing.
    assert backoff_delay(failures) == MAX_BACKOFF_SECONDS


def test_enormous_failure_count_does_not_overflow():
    # Guards the shift: a naive 2**failures with a large count builds a giant
    # intermediate before the min() ever runs.
    assert backoff_delay(10_000) == MAX_BACKOFF_SECONDS


@pytest.mark.parametrize("failures", [-5, -1])
def test_negative_failures_are_treated_as_healthy(failures):
    assert backoff_delay(failures) == BASE_INTERVAL_SECONDS


def test_provider_retry_after_wins_when_it_asks_for_longer():
    # THE important rule. Graph and Gmail both throttle hard and tell us exactly
    # how long to wait; overriding that with our own shorter backoff is how a
    # rate-limited connection gets itself throttled harder — which then looks
    # indistinguishable from an outage.
    assert backoff_delay(1, retry_after=3600) == 3600


def test_a_shorter_retry_after_does_not_shorten_our_backoff():
    # After repeated failures we know more about this connection's health than
    # a single response header does.
    assert backoff_delay(5, retry_after=1) == 960


@pytest.mark.parametrize("retry_after", [None, 0, -30])
def test_absent_or_nonsense_retry_after_falls_back_to_our_own(retry_after):
    assert backoff_delay(2, retry_after=retry_after) == 120


def test_retry_after_applies_to_a_healthy_connection_too():
    # A 429 on the very first attempt still has to be honored.
    assert backoff_delay(0, retry_after=BASE_INTERVAL_SECONDS * 3) == BASE_INTERVAL_SECONDS * 3


# ── next_attempt_at ───────────────────────────────────────────────────────────
def test_next_attempt_adds_the_delay_to_now():
    assert next_attempt_at(0, now=NOW) == NOW + timedelta(seconds=BASE_INTERVAL_SECONDS)


def test_next_attempt_honors_retry_after():
    assert next_attempt_at(3, retry_after=7200, now=NOW) == NOW + timedelta(seconds=7200)


def test_next_attempt_is_always_in_the_future():
    # A non-advancing timestamp would make the worker spin on one connection.
    for failures in range(0, 12):
        assert next_attempt_at(failures, now=NOW) > NOW


# ── renewal ───────────────────────────────────────────────────────────────────
def test_missing_expiry_means_renew_now():
    # A connected row with no subscription has either never been armed or lost
    # its subscription — both need arming. Fail toward renewing: an unnecessary
    # renewal costs one API call, a missed one costs every notification until
    # somebody notices.
    assert needs_renewal(None, now=NOW) is True


def test_expiry_inside_the_margin_means_renew():
    assert needs_renewal(NOW + timedelta(seconds=RENEW_MARGIN_SECONDS - 60), now=NOW) is True


def test_expiry_beyond_the_margin_means_wait():
    assert needs_renewal(NOW + timedelta(seconds=RENEW_MARGIN_SECONDS + 60), now=NOW) is False


def test_already_expired_means_renew():
    assert needs_renewal(NOW - timedelta(hours=2), now=NOW) is True


def test_exactly_at_the_margin_renews():
    # Boundary resolves toward renewing, for the same fail-safe reason.
    assert needs_renewal(NOW + timedelta(seconds=RENEW_MARGIN_SECONDS), now=NOW) is True


def test_naive_timestamp_is_treated_as_utc():
    # A driver that drops tzinfo would otherwise raise on the comparison and
    # take out the whole renewal sweep.
    naive = (NOW + timedelta(hours=5)).replace(tzinfo=None)
    assert needs_renewal(naive, now=NOW) is False


def test_teams_chat_window_is_workable_with_the_default_margin():
    # Graph chat subscriptions live ~60 minutes. With a 15-minute margin, a
    # freshly created one must NOT already be due — that would be a renewal
    # loop burning quota.
    fresh_chat = NOW + timedelta(minutes=55)
    assert needs_renewal(fresh_chat, now=NOW) is False
    assert RENEW_MARGIN_SECONDS < 55 * 60
