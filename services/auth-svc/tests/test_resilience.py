"""Unit tests for the hand-rolled resilience helpers.

Target: ``app.security.resilience`` — ``is_transient`` classification, the
``CircuitBreaker`` state machine, and ``retry_async`` orchestration.

All pure logic: ``time.monotonic`` is monkeypatched to a fake clock and
``asyncio.sleep`` is stubbed to a no-op so backoff never actually sleeps. No
network — transient failures are simulated with constructed ``httpx`` exceptions.
Async coroutines run via ``asyncio.run`` so no async pytest plugin is required.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

from app.security import resilience
from app.security.resilience import (
    CircuitBreaker,
    CircuitOpenError,
    is_transient,
    retry_async,
)


# ── fakes ────────────────────────────────────────────────────────────────────
class FakeClock:
    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _status_error(code: int) -> httpx.HTTPStatusError:
    """An HTTPStatusError carrying a response with ``code`` (no real request)."""
    request = httpx.Request("GET", "http://svc/x")
    response = httpx.Response(code, request=request)
    return httpx.HTTPStatusError(f"status {code}", request=request, response=response)


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make backoff instantaneous and deterministic for every test."""
    async def _instant(_seconds: float) -> None:
        return None

    monkeypatch.setattr(resilience.asyncio, "sleep", _instant)
    # Pin jitter so we never depend on randomness.
    monkeypatch.setattr(resilience.random, "uniform", lambda _a, b: b)


# ── is_transient classification ──────────────────────────────────────────────
def test_is_transient_5xx_status_is_transient() -> None:
    assert is_transient(_status_error(500)) is True
    assert is_transient(_status_error(503)) is True


@pytest.mark.parametrize("code", [400, 401, 403, 404, 409, 422, 499])
def test_is_transient_4xx_status_is_not_transient(code: int) -> None:
    assert is_transient(_status_error(code)) is False


def test_is_transient_transport_errors_are_transient() -> None:
    request = httpx.Request("GET", "http://svc/x")
    assert is_transient(httpx.ConnectError("boom", request=request)) is True
    assert is_transient(httpx.ReadTimeout("slow", request=request)) is True
    assert is_transient(httpx.ConnectTimeout("slow", request=request)) is True


def test_is_transient_arbitrary_exception_is_not_transient() -> None:
    assert is_transient(ValueError("bad data")) is False
    assert is_transient(KeyError("missing")) is False


# ── CircuitBreaker state machine ─────────────────────────────────────────────
def test_breaker_starts_closed() -> None:
    cb = CircuitBreaker(fail_max=3)
    assert cb.state == "closed"
    cb.before()  # closed never blocks


def test_breaker_opens_after_fail_max_consecutive_failures() -> None:
    cb = CircuitBreaker(fail_max=3)
    cb.on_failure()
    cb.on_failure()
    assert cb.state == "closed"  # not yet at threshold
    cb.on_failure()  # 3rd consecutive failure
    assert cb.state == "open"
    with pytest.raises(CircuitOpenError):
        cb.before()  # open => fail fast


def test_breaker_success_resets_failure_count() -> None:
    """A success in CLOSED resets the streak so the breaker doesn't trip."""
    cb = CircuitBreaker(fail_max=3)
    cb.on_failure()
    cb.on_failure()
    cb.on_success()  # resets streak back to 0
    assert cb.state == "closed"
    cb.on_failure()
    cb.on_failure()
    assert cb.state == "closed"  # only 2 since the reset, still under fail_max


def test_breaker_half_open_after_cooldown_then_close_on_success() -> None:
    clock = FakeClock()
    cb = CircuitBreaker(fail_max=2, reset_timeout=30.0)
    # Use a patched clock for the breaker's monotonic reads.
    import app.security.resilience as mod

    orig = mod.time.monotonic
    try:
        mod.time.monotonic = clock  # type: ignore[assignment]
        cb.on_failure()
        cb.on_failure()  # opens at t=1000
        assert cb.state == "open"

        # Before cooldown elapses: still open, blocks.
        clock.advance(29)
        with pytest.raises(CircuitOpenError):
            cb.before()
        assert cb.state == "open"

        # After cooldown: before() transitions OPEN -> HALF_OPEN and allows probe.
        clock.advance(2)  # total 31 >= 30
        cb.before()
        assert cb.state == "half_open"

        # A successful probe closes the breaker.
        cb.on_success()
        assert cb.state == "closed"
    finally:
        mod.time.monotonic = orig  # type: ignore[assignment]


def test_breaker_half_open_failure_reopens() -> None:
    clock = FakeClock()
    cb = CircuitBreaker(fail_max=2, reset_timeout=30.0)
    import app.security.resilience as mod

    orig = mod.time.monotonic
    try:
        mod.time.monotonic = clock  # type: ignore[assignment]
        cb.on_failure()
        cb.on_failure()  # open at t=1000
        clock.advance(31)
        cb.before()  # -> half_open
        assert cb.state == "half_open"

        # A failed probe immediately re-opens for a fresh cooldown.
        cb.on_failure()
        assert cb.state == "open"
        with pytest.raises(CircuitOpenError):
            cb.before()  # cooldown clock reset, so still open right away
    finally:
        mod.time.monotonic = orig  # type: ignore[assignment]


# ── retry_async orchestration ────────────────────────────────────────────────
def test_retry_returns_on_first_success() -> None:
    calls = {"n": 0}

    async def fn() -> str:
        calls["n"] += 1
        return "ok"

    result = asyncio.run(retry_async(fn, attempts=3))
    assert result == "ok"
    assert calls["n"] == 1  # healthy dependency: exactly one call


def test_retry_retries_transient_then_succeeds() -> None:
    calls = {"n": 0}
    request = httpx.Request("GET", "http://svc/x")

    async def fn() -> str:
        calls["n"] += 1
        if calls["n"] < 3:
            raise httpx.ConnectError("transient", request=request)
        return "recovered"

    result = asyncio.run(retry_async(fn, attempts=3))
    assert result == "recovered"
    assert calls["n"] == 3


def test_retry_exhausts_attempts_and_reraises_last_transient() -> None:
    calls = {"n": 0}
    request = httpx.Request("GET", "http://svc/x")

    async def fn() -> str:
        calls["n"] += 1
        raise httpx.ReadTimeout("always slow", request=request)

    with pytest.raises(httpx.ReadTimeout):
        asyncio.run(retry_async(fn, attempts=3))
    assert calls["n"] == 3  # used the full budget


def test_retry_does_not_retry_non_transient() -> None:
    calls = {"n": 0}

    async def fn() -> str:
        calls["n"] += 1
        raise ValueError("business error")

    with pytest.raises(ValueError):
        asyncio.run(retry_async(fn, attempts=5))
    assert calls["n"] == 1  # 4xx / business error => no retry


def test_retry_does_not_retry_4xx_status() -> None:
    calls = {"n": 0}

    async def fn() -> str:
        calls["n"] += 1
        raise _status_error(404)

    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(retry_async(fn, attempts=5))
    assert calls["n"] == 1


def test_retry_with_breaker_trips_after_transient_failures() -> None:
    """Transient failures funneled through retry_async open the breaker, and a
    subsequent call fails fast with CircuitOpenError (no fn invocation)."""
    cb = CircuitBreaker(fail_max=2, reset_timeout=30.0)
    request = httpx.Request("GET", "http://svc/x")
    calls = {"n": 0}

    async def failing() -> str:
        calls["n"] += 1
        raise httpx.ConnectError("down", request=request)

    # attempts=2 => two transient failures => breaker opens.
    with pytest.raises(httpx.ConnectError):
        asyncio.run(retry_async(failing, attempts=2, breaker=cb))
    assert cb.state == "open"

    # Next call short-circuits before invoking fn.
    before = calls["n"]

    async def should_not_run() -> str:
        calls["n"] += 1
        return "nope"

    with pytest.raises(CircuitOpenError):
        asyncio.run(retry_async(should_not_run, attempts=3, breaker=cb))
    assert calls["n"] == before  # fn never called while breaker is open


def test_retry_breaker_not_tripped_by_non_transient() -> None:
    """A non-transient error must NOT count as a breaker failure (it records a
    success on the breaker), so the breaker stays closed."""
    cb = CircuitBreaker(fail_max=2, reset_timeout=30.0)

    async def business_error() -> str:
        raise ValueError("4xx-equivalent")

    for _ in range(5):
        with pytest.raises(ValueError):
            asyncio.run(retry_async(business_error, attempts=1, breaker=cb))
    assert cb.state == "closed"


def test_retry_on_retry_callback_invoked_for_transient() -> None:
    seen: list[int] = []
    request = httpx.Request("GET", "http://svc/x")

    async def fn() -> str:
        raise httpx.ConnectError("x", request=request)

    def on_retry(attempt: int, _exc: BaseException, _delay: float) -> None:
        seen.append(attempt)

    with pytest.raises(httpx.ConnectError):
        asyncio.run(retry_async(fn, attempts=3, on_retry=on_retry))
    # Callback fires before each backoff sleep => once per non-final attempt.
    assert seen == [1, 2]
