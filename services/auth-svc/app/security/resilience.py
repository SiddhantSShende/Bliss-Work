"""Tiny resilience helpers for cross-service HTTP calls.

Hand-rolled (no new deps — httpx + asyncio only) so a slow/down dependency
degrades gracefully instead of cascading:

  * ``retry_async`` — up to N attempts with exponential backoff + jitter, but
    ONLY on transient failures (connect/read timeouts, connection errors, 5xx).
    A 4xx / business error is returned/raised immediately — retrying it is
    pointless and just adds latency.
  * ``CircuitBreaker`` — a minimal in-process breaker. After ``fail_max``
    consecutive failures it OPENS and fails fast (raising ``CircuitOpenError``)
    for ``reset_timeout`` seconds instead of letting every caller block on the
    full per-attempt timeout (the actual cascade). After the cooldown it goes
    HALF-OPEN and lets a single probe through; success closes it, failure
    re-opens it for another cooldown.

This is intentionally small and behavior-preserving on the happy path: the
first attempt runs exactly as before, and a healthy dependency never sees the
breaker open or any retry.
"""
from __future__ import annotations

import asyncio
import random
import time
from typing import Awaitable, Callable, TypeVar

import httpx

T = TypeVar("T")

# Exceptions that are worth retrying — a transient network/timeout condition or
# a server-side 5xx. Everything else (4xx, decode errors, ...) is surfaced
# immediately by the helper below.
_TRANSIENT_EXC = (
    httpx.TransportError,  # covers ConnectError, ReadTimeout, ConnectTimeout, ...
)


class CircuitOpenError(Exception):
    """Raised by ``CircuitBreaker.before()`` while the breaker is OPEN.

    Callers can catch this to fail fast / fall back instead of attempting (and
    blocking on) a call to a known-bad dependency.
    """


def is_transient(exc: BaseException) -> bool:
    """True when ``exc`` represents a retryable transient failure."""
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code >= 500
    return isinstance(exc, _TRANSIENT_EXC)


class CircuitBreaker:
    """A minimal consecutive-failure circuit breaker (in-process, single-host).

    Not distributed and not thread-safe across event loops — one instance per
    dependency per process is the intended usage, which is all these call sites
    need. ``asyncio`` coroutines run cooperatively, so the plain counters below
    are race-free for our purposes (no await between read and write).
    """

    def __init__(self, *, fail_max: int = 5, reset_timeout: float = 30.0,
                 name: str = "circuit") -> None:
        self._fail_max = fail_max
        self._reset_timeout = reset_timeout
        self._name = name
        self._failures = 0
        self._opened_at = 0.0
        self._state = "closed"  # closed | open | half_open

    @property
    def state(self) -> str:
        return self._state

    def before(self) -> None:
        """Gate a call. Raises ``CircuitOpenError`` if the breaker is OPEN.

        Transitions OPEN -> HALF_OPEN once the cooldown has elapsed so a single
        probe is allowed through.
        """
        if self._state == "open":
            if (time.monotonic() - self._opened_at) >= self._reset_timeout:
                self._state = "half_open"
            else:
                raise CircuitOpenError(f"{self._name} circuit open")

    def on_success(self) -> None:
        self._failures = 0
        self._state = "closed"

    def on_failure(self) -> None:
        self._failures += 1
        # A failed half-open probe, or hitting the threshold from closed, opens
        # (or re-opens) the breaker for a fresh cooldown.
        if self._state == "half_open" or self._failures >= self._fail_max:
            self._state = "open"
            self._opened_at = time.monotonic()


async def retry_async(
    fn: Callable[[], Awaitable[T]],
    *,
    attempts: int = 3,
    base_delay: float = 0.2,
    max_delay: float = 2.0,
    breaker: CircuitBreaker | None = None,
    on_retry: Callable[[int, BaseException, float], None] | None = None,
) -> T:
    """Run ``fn`` with retry + exponential backoff + jitter on transient errors.

    * Non-transient exceptions propagate immediately (no retry).
    * If ``breaker`` is supplied it gates each attempt (``before``) and records
      ``on_success`` / ``on_failure``; a breaker-open state short-circuits via
      ``CircuitOpenError`` without consuming a retry budget.
    * Returns ``fn``'s result, or re-raises the last exception after the final
      attempt.
    """
    last_exc: BaseException | None = None
    for attempt in range(1, attempts + 1):
        if breaker is not None:
            breaker.before()  # may raise CircuitOpenError (fail fast)
        try:
            result = await fn()
        except BaseException as exc:  # noqa: BLE001 - classified just below
            last_exc = exc
            transient = is_transient(exc)
            if breaker is not None:
                # Only transient failures should trip the breaker; a 4xx is a
                # caller/data problem, not a sign the dependency is unhealthy.
                if transient:
                    breaker.on_failure()
                else:
                    breaker.on_success()
            if not transient or attempt >= attempts:
                raise
            # Exponential backoff with full jitter, capped.
            delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
            delay = random.uniform(0, delay)
            if on_retry is not None:
                on_retry(attempt, exc, delay)
            await asyncio.sleep(delay)
        else:
            if breaker is not None:
                breaker.on_success()
            return result
    # Unreachable (loop either returns or raises) — keeps type checkers happy.
    assert last_exc is not None
    raise last_exc
