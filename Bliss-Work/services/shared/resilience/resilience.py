"""Tiny resilience helpers for cross-service HTTP calls — shared across this
repo's Python services.

Hand-rolled (no new deps — httpx + asyncio only) so a slow/down dependency
degrades gracefully instead of cascading.

  * ``retry_async`` — up to N attempts with exponential backoff + jitter, but
    ONLY on transient failures (connect/read timeouts, connection errors, 5xx).
    A 4xx / business error is surfaced immediately — retrying it just adds
    latency. Pass ``idempotent=False`` for a call that creates a real-world
    side effect on every execution (sending an email, posting a chat message):
    a read/write timeout or 5xx means the request may already have reached
    the far side, so retrying it risks a silent duplicate send. Non-idempotent
    calls still retry the subset of errors proven to have failed BEFORE any
    bytes went out (connect timeout/error, pool timeout) — those are safe no
    matter what the call does.
  * ``CircuitBreaker`` — a minimal in-process breaker. After ``fail_max``
    consecutive failures it OPENS and fails fast (raising ``CircuitOpenError``)
    for ``reset_timeout`` seconds instead of every caller blocking on the full
    per-attempt timeout (the cascade). After the cooldown it goes HALF-OPEN and
    lets a single probe through; success closes it, failure re-opens it.

Behavior-preserving on the happy path: the first attempt runs exactly as
before, and a healthy dependency never sees the breaker open or any retry.
``idempotent`` defaults to True, so a caller that never passes it gets the
exact same retry behavior as before this module had an idempotency concept.
"""
from __future__ import annotations

import asyncio
import random
import time
from typing import Awaitable, Callable, TypeVar

import httpx

T = TypeVar("T")

_TRANSIENT_EXC = (
    httpx.TransportError,  # ConnectError, ReadTimeout, ConnectTimeout, ...
)

# The subset of _TRANSIENT_EXC that is provably pre-send: the connection was
# never established (or never got a slot from the pool), so the far side never
# saw any part of the request. Safe to retry even for a non-idempotent call.
# ReadTimeout/WriteTimeout/ProtocolError etc. are NOT here on purpose — the
# request may already have been transmitted and acted on before the failure.
_PRE_SEND_EXC = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.PoolTimeout,
)


class CircuitOpenError(Exception):
    """Raised by ``CircuitBreaker.before()`` while the breaker is OPEN."""


def is_transient(exc: BaseException) -> bool:
    """True when ``exc`` represents a retryable transient failure.

    This drives circuit-breaker bookkeeping and is intentionally unaffected by
    call-site idempotency: a 500 or timeout means the dependency is unhealthy
    regardless of whether THIS attempt gets retried.
    """
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code >= 500
    return isinstance(exc, _TRANSIENT_EXC)


def _is_pre_send(exc: BaseException) -> bool:
    return isinstance(exc, _PRE_SEND_EXC)


class CircuitBreaker:
    """A minimal consecutive-failure circuit breaker (in-process, single-host).

    One instance per dependency per process. ``asyncio`` coroutines run
    cooperatively, so the plain counters below are race-free for our purposes
    (no await between read and write).
    """

    def __init__(self, *, fail_max: int = 5, reset_timeout: float = 30.0,
                 name: str = "circuit") -> None:
        self._fail_max = fail_max
        self._reset_timeout = reset_timeout
        self._name = name
        self._failures = 0
        self._opened_at = 0.0
        self._state = "closed"  # closed | open | half_open
        self._probe_in_flight = False

    @property
    def state(self) -> str:
        return self._state

    def before(self) -> None:
        """Raise ``CircuitOpenError`` if OPEN; transition to HALF_OPEN once the
        cooldown has elapsed so a single probe is allowed through."""
        if self._state == "open":
            if (time.monotonic() - self._opened_at) >= self._reset_timeout:
                self._state = "half_open"
                self._probe_in_flight = True
            else:
                raise CircuitOpenError(f"{self._name} circuit open")
        elif self._state == "half_open":
            if self._probe_in_flight:
                raise CircuitOpenError(f"{self._name} half-open probe in flight")
            self._probe_in_flight = True

    def on_success(self) -> None:
        self._failures = 0
        self._state = "closed"
        self._probe_in_flight = False

    def on_failure(self) -> None:
        self._failures += 1
        if self._state == "half_open" or self._failures >= self._fail_max:
            self._state = "open"
            self._opened_at = time.monotonic()
        self._probe_in_flight = False

    def on_cancelled(self) -> None:
        """Release a cancelled half-open probe without recording a result."""
        if self._state == "half_open":
            self._state = "open"
            self._opened_at = time.monotonic()
        self._probe_in_flight = False


async def retry_async(
    fn: Callable[[], Awaitable[T]],
    *,
    attempts: int = 3,
    base_delay: float = 0.2,
    max_delay: float = 2.0,
    breaker: CircuitBreaker | None = None,
    on_retry: Callable[[int, BaseException, float], None] | None = None,
    idempotent: bool = True,
) -> T:
    """Run ``fn`` with retry + exponential backoff + jitter on transient errors.

    Non-transient exceptions propagate immediately. If ``breaker`` is supplied
    it gates each attempt and records success/failure; a breaker-open state
    short-circuits via ``CircuitOpenError`` without consuming a retry budget.

    ``idempotent=False`` narrows what gets retried to pre-send failures only
    (see ``_PRE_SEND_EXC``) — the caller is telling us `fn` has a real-world
    side effect that must not fire twice, so a ReadTimeout/5xx after the
    request may already have reached the far side is surfaced on the first
    attempt instead of retried.
    """
    last_exc: BaseException | None = None
    for attempt in range(1, attempts + 1):
        if breaker is not None:
            breaker.before()  # may raise CircuitOpenError (fail fast)
        try:
            result = await fn()
        except asyncio.CancelledError:
            if breaker is not None:
                breaker.on_cancelled()
            raise
        except Exception as exc:
            last_exc = exc
            transient = is_transient(exc)
            if breaker is not None:
                if transient:
                    breaker.on_failure()
                else:
                    breaker.on_success()
            retryable = transient if idempotent else (transient and _is_pre_send(exc))
            if not retryable or attempt >= attempts:
                raise
            delay = min(max_delay, base_delay * (2 ** (attempt - 1)))
            delay = random.uniform(0, delay)
            if on_retry is not None:
                on_retry(attempt, exc, delay)
            await asyncio.sleep(delay)
        else:
            if breaker is not None:
                breaker.on_success()
            return result
    assert last_exc is not None
    raise last_exc
