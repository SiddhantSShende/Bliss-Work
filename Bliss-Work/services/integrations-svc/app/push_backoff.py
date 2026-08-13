"""Scheduling arithmetic for the push/reconciliation worker.

Pure functions, no I/O and no clock reads beyond what is passed in, so the
scheduling rules can be tested exhaustively without a database or a provider.
The worker itself (push_worker.py) does the I/O and calls into here.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

#: Normal cadence between reconciliation sweeps for a healthy connection.
#: Push delivers new mail within seconds; this only catches what push dropped,
#: so it can be slow. Too fast and it becomes a poller with a push-shaped
#: preamble, burning the org's API quota for nothing.
BASE_INTERVAL_SECONDS = 15 * 60

#: Ceiling on backoff. A connection broken for hours should still retry
#: occasionally — the fix (an admin re-authorizing) is invisible to us, so
#: never backing off to "effectively never" is what lets it self-heal.
MAX_BACKOFF_SECONDS = 30 * 60

#: Renew a subscription this long before it expires. A lapsed subscription
#: stops delivering SILENTLY — no error, notifications simply cease.
RENEW_MARGIN_SECONDS = 15 * 60


def backoff_delay(failures: int, retry_after: float | None = None) -> float:
    """Seconds to wait before touching this connection again.

    * `failures == 0` → the normal cadence.
    * otherwise → exponential from one minute, capped.
    * `retry_after` (a provider's Retry-After) WINS when it asks for longer.

    The provider-wins rule is the important one. Graph and Gmail both throttle
    aggressively and tell us exactly how long to wait; ignoring that in favour
    of our own shorter backoff is how a rate-limited connection gets itself
    rate-limited harder, which looks identical to an outage.

    A `retry_after` SHORTER than our backoff is deliberately not honored — after
    repeated failures we have better information about this connection's health
    than a single response header does.
    """
    if failures <= 0:
        base = float(BASE_INTERVAL_SECONDS)
    else:
        # 1m, 2m, 4m, 8m, 16m, capped. Shift rather than pow to keep a large
        # failure count from producing an enormous intermediate float.
        base = float(min(MAX_BACKOFF_SECONDS, 60 * (2 ** min(failures - 1, 20))))

    if retry_after is not None and retry_after > 0:
        return max(base, float(retry_after))
    return base


def next_attempt_at(
    failures: int,
    *,
    retry_after: float | None = None,
    now: datetime | None = None,
) -> datetime:
    """Absolute timestamp for the connection's next sweep."""
    base = now or datetime.now(timezone.utc)
    return base + timedelta(seconds=backoff_delay(failures, retry_after))


def needs_renewal(
    expires_at: datetime | None,
    *,
    now: datetime | None = None,
    margin_seconds: int = RENEW_MARGIN_SECONDS,
) -> bool:
    """Is this subscription close enough to expiry to renew now?

    `None` counts as YES: a connected row with no subscription has either never
    been armed or lost its subscription, and both need arming. Fail toward
    renewing — an unnecessary renewal costs one API call, a missed one costs
    every notification until someone notices.
    """
    if expires_at is None:
        return True
    base = now or datetime.now(timezone.utc)
    # Tolerate a naive timestamp from a driver that dropped the tzinfo; treating
    # it as UTC matches how it was stored (timestamptz).
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= base + timedelta(seconds=margin_seconds)
