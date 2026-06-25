"""Unit tests for ``app.resilience`` — CircuitBreaker, retry_async, is_transient.

Pure logic: ``resilience.py`` depends only on ``httpx`` + asyncio + stdlib (no
DB/Kafka/Redis), so these run anywhere ``httpx`` is installed (it's in
requirements.txt). We drive time via a monkeypatched ``time.monotonic`` rather
than sleeping, and ``retry_async``'s backoff sleep is patched out so the suite
stays fast and deterministic.
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

resilience = pytest.importorskip(
    "app.resilience",
    reason="httpx not installed locally; CI installs requirements.txt and runs this.",
)
CircuitBreaker = resilience.CircuitBreaker
CircuitOpenError = resilience.CircuitOpenError
is_transient = resilience.is_transient
retry_async = resilience.retry_async


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _status_error(code: int) -> httpx.HTTPStatusError:
    req = httpx.Request("GET", "http://x/")
    resp = httpx.Response(code, request=req)
    return httpx.HTTPStatusError(f"{code}", request=req, response=resp)


def _run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- #
# is_transient
# --------------------------------------------------------------------------- #
class TestIsTransient:
    @pytest.mark.parametrize(
        "exc, expected",
        [
            # 5xx HTTP status errors are transient.
            (_status_error(500), True),
            (_status_error(502), True),
            (_status_error(503), True),
            (_status_error(599), True),
            # 4xx / business errors are NOT transient — surface immediately.
            (_status_error(400), False),
            (_status_error(401), False),
            (_status_error(404), False),
            (_status_error(409), False),
            (_status_error(499), False),
            # Transport-level failures are transient.
            (httpx.ConnectError("boom"), True),
            (httpx.ReadTimeout("slow"), True),
            (httpx.ConnectTimeout("slow"), True),
            (httpx.PoolTimeout("full"), True),
            # Arbitrary application exceptions are not transient.
            (ValueError("nope"), False),
            (RuntimeError("nope"), False),
            (KeyError("nope"), False),
        ],
    )
    def test_classification(self, exc, expected):
        assert is_transient(exc) is expected


# --------------------------------------------------------------------------- #
# CircuitBreaker state machine
# --------------------------------------------------------------------------- #
class TestCircuitBreaker:
    def test_starts_closed(self):
        cb = CircuitBreaker()
        assert cb.state == "closed"
        cb.before()  # no raise while closed

    def test_opens_after_fail_max_consecutive(self):
        cb = CircuitBreaker(fail_max=3)
        cb.on_failure()
        assert cb.state == "closed"
        cb.on_failure()
        assert cb.state == "closed"
        cb.on_failure()  # third consecutive failure trips it
        assert cb.state == "open"

    def test_open_breaker_fails_fast(self):
        cb = CircuitBreaker(fail_max=1)
        cb.on_failure()
        assert cb.state == "open"
        with pytest.raises(CircuitOpenError):
            cb.before()

    def test_success_resets_failure_count(self):
        cb = CircuitBreaker(fail_max=3)
        cb.on_failure()
        cb.on_failure()
        cb.on_success()  # streak broken
        assert cb.state == "closed"
        cb.on_failure()
        cb.on_failure()
        assert cb.state == "closed"  # only 2 since reset, not yet at fail_max

    def test_half_open_after_cooldown(self, monkeypatch):
        clock = {"t": 1000.0}
        monkeypatch.setattr(resilience.time, "monotonic", lambda: clock["t"])
        cb = CircuitBreaker(fail_max=1, reset_timeout=30.0)
        cb.on_failure()
        assert cb.state == "open"
        # Still inside the cooldown window -> stays open, fails fast.
        clock["t"] += 29.0
        with pytest.raises(CircuitOpenError):
            cb.before()
        assert cb.state == "open"
        # Cooldown elapsed -> next before() transitions to half_open (probe).
        clock["t"] += 2.0  # total 31s >= 30s
        cb.before()  # must NOT raise
        assert cb.state == "half_open"

    def test_half_open_success_closes(self, monkeypatch):
        clock = {"t": 0.0}
        monkeypatch.setattr(resilience.time, "monotonic", lambda: clock["t"])
        cb = CircuitBreaker(fail_max=1, reset_timeout=10.0)
        cb.on_failure()
        clock["t"] += 11.0
        cb.before()
        assert cb.state == "half_open"
        cb.on_success()
        assert cb.state == "closed"

    def test_half_open_failure_reopens(self, monkeypatch):
        clock = {"t": 0.0}
        monkeypatch.setattr(resilience.time, "monotonic", lambda: clock["t"])
        cb = CircuitBreaker(fail_max=5, reset_timeout=10.0)
        cb.on_failure()  # only 1 failure, but...
        # force open by tripping fail_max
        for _ in range(4):
            cb.on_failure()
        assert cb.state == "open"
        clock["t"] += 11.0
        cb.before()
        assert cb.state == "half_open"
        cb.on_failure()  # probe failed -> immediately re-open
        assert cb.state == "open"


# --------------------------------------------------------------------------- #
# retry_async
# --------------------------------------------------------------------------- #
class TestRetryAsync:
    @pytest.fixture(autouse=True)
    def _no_sleep(self, monkeypatch):
        # Never actually sleep on backoff; keep the suite instant & deterministic.
        async def _instant(_delay):
            return None

        monkeypatch.setattr(resilience.asyncio, "sleep", _instant)

    def test_returns_on_first_success(self):
        calls = {"n": 0}

        async def fn():
            calls["n"] += 1
            return "ok"

        assert _run(retry_async(fn, attempts=3)) == "ok"
        assert calls["n"] == 1  # no retries on success

    def test_retries_transient_then_succeeds(self):
        calls = {"n": 0}

        async def fn():
            calls["n"] += 1
            if calls["n"] < 3:
                raise httpx.ConnectError("transient")
            return "recovered"

        assert _run(retry_async(fn, attempts=5)) == "recovered"
        assert calls["n"] == 3

    def test_exhausts_attempts_and_raises_last(self):
        calls = {"n": 0}

        async def fn():
            calls["n"] += 1
            raise httpx.ReadTimeout("always")

        with pytest.raises(httpx.ReadTimeout):
            _run(retry_async(fn, attempts=3))
        assert calls["n"] == 3  # exactly attempts tries, no more

    def test_non_transient_not_retried(self):
        calls = {"n": 0}

        async def fn():
            calls["n"] += 1
            raise ValueError("business error")

        with pytest.raises(ValueError):
            _run(retry_async(fn, attempts=5))
        assert calls["n"] == 1  # surfaced immediately, no retry

    def test_4xx_not_retried(self):
        calls = {"n": 0}

        async def fn():
            calls["n"] += 1
            raise _status_error(404)

        with pytest.raises(httpx.HTTPStatusError):
            _run(retry_async(fn, attempts=5))
        assert calls["n"] == 1

    def test_on_retry_callback_fires_per_retry(self):
        seen = []

        async def fn():
            raise httpx.ConnectError("x")

        def on_retry(attempt, exc, delay):
            seen.append(attempt)

        with pytest.raises(httpx.ConnectError):
            _run(retry_async(fn, attempts=3, on_retry=on_retry))
        # Called before sleeping on attempts 1 and 2, but NOT on the final
        # attempt (which re-raises instead of scheduling another try).
        assert seen == [1, 2]

    def test_breaker_records_failures_and_opens(self):
        # fail_max == attempts: the breaker trips open on the FINAL failure (which
        # re-raises the transient error), rather than mid-loop where the next
        # attempt's before() would short-circuit with CircuitOpenError. Real
        # callers use fail_max (5) > attempts (3), so the breaker only opens
        # across calls, never within one — this mirrors that.
        cb = CircuitBreaker(fail_max=3)

        async def fn():
            raise httpx.ConnectError("x")

        with pytest.raises(httpx.ConnectError):
            _run(retry_async(fn, attempts=3, breaker=cb))
        # Three transient failures recorded -> breaker has tripped open.
        assert cb.state == "open"

    def test_breaker_open_short_circuits_without_calling_fn(self):
        cb = CircuitBreaker(fail_max=1)
        cb.on_failure()  # open it
        assert cb.state == "open"
        calls = {"n": 0}

        async def fn():
            calls["n"] += 1
            return "ok"

        with pytest.raises(CircuitOpenError):
            _run(retry_async(fn, attempts=3, breaker=cb))
        assert calls["n"] == 0  # fn never invoked while breaker is open

    def test_breaker_success_resets(self):
        cb = CircuitBreaker(fail_max=3)
        cb.on_failure()  # 1 prior failure

        async def fn():
            return "ok"

        assert _run(retry_async(fn, attempts=3, breaker=cb)) == "ok"
        assert cb.state == "closed"

    def test_non_transient_marks_breaker_success(self):
        # A 4xx is the dependency working fine; it must NOT count toward opening
        # the breaker. resilience records on_success() for non-transient errors.
        cb = CircuitBreaker(fail_max=2)
        cb.on_failure()  # 1 prior transient failure on record

        async def fn():
            raise _status_error(400)

        with pytest.raises(httpx.HTTPStatusError):
            _run(retry_async(fn, attempts=3, breaker=cb))
        assert cb.state == "closed"  # success reset, did not trip
