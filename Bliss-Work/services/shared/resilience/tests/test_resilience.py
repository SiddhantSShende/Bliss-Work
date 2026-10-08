"""Unit tests for ``resilience`` — CircuitBreaker, retry_async, is_transient.

Pure logic: ``resilience.py`` depends only on ``httpx`` + asyncio + stdlib (no
DB/Kafka/Redis), so these run anywhere ``httpx`` is installed. We drive time
via a monkeypatched ``time.monotonic`` rather than sleeping, and
``retry_async``'s backoff sleep is patched out so the suite stays fast and
deterministic.

Each consuming service (auth-svc, task-svc, integrations-svc, telemetry-svc,
sticky-svc, email-worker) previously kept its own near-identical copy of the
base test suite below; this is the one copy. The ``idempotent`` flag section
covers the behavior integrations-svc and email-worker rely on for
non-retryable real-world sends (email, chat messages).
"""
from __future__ import annotations

import asyncio

import httpx
import pytest

import resilience
from resilience import CircuitBreaker, CircuitOpenError, is_transient, retry_async


def _status_error(code: int) -> httpx.HTTPStatusError:
    req = httpx.Request("GET", "http://x/")
    resp = httpx.Response(code, request=req)
    return httpx.HTTPStatusError(f"{code}", request=req, response=resp)


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
        with pytest.raises(CircuitOpenError):
            cb.before()

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
# retry_async — base behavior (idempotent default)
# --------------------------------------------------------------------------- #
class TestRetryAsync:
    @pytest.fixture(autouse=True)
    def _no_sleep(self, monkeypatch):
        # Never actually sleep on backoff; keep the suite instant & deterministic.
        async def _instant(_delay):
            return None

        monkeypatch.setattr(resilience.asyncio, "sleep", _instant)

    async def test_returns_on_first_success(self):
        calls = {"n": 0}

        async def fn():
            calls["n"] += 1
            return "ok"

        assert await retry_async(fn, attempts=3) == "ok"
        assert calls["n"] == 1  # no retries on success

    async def test_cancellation_does_not_count_as_breaker_success_or_failure(self, monkeypatch):
        clock = {"t": 0.0}
        monkeypatch.setattr(resilience.time, "monotonic", lambda: clock["t"])
        cb = CircuitBreaker(fail_max=1, reset_timeout=10.0)
        cb.on_failure()
        failures_before = cb._failures
        clock["t"] += 11.0

        async def cancelled():
            raise asyncio.CancelledError

        with pytest.raises(asyncio.CancelledError):
            await retry_async(cancelled, breaker=cb)
        assert cb.state == "open"
        assert cb._failures == failures_before

    async def test_retries_transient_then_succeeds(self):
        calls = {"n": 0}

        async def fn():
            calls["n"] += 1
            if calls["n"] < 3:
                raise httpx.ConnectError("transient")
            return "recovered"

        assert await retry_async(fn, attempts=5) == "recovered"
        assert calls["n"] == 3

    async def test_exhausts_attempts_and_raises_last(self):
        calls = {"n": 0}

        async def fn():
            calls["n"] += 1
            raise httpx.ReadTimeout("always")

        with pytest.raises(httpx.ReadTimeout):
            await retry_async(fn, attempts=3)
        assert calls["n"] == 3  # exactly attempts tries, no more

    async def test_non_transient_not_retried(self):
        calls = {"n": 0}

        async def fn():
            calls["n"] += 1
            raise ValueError("business error")

        with pytest.raises(ValueError):
            await retry_async(fn, attempts=5)
        assert calls["n"] == 1  # surfaced immediately, no retry

    async def test_4xx_not_retried(self):
        calls = {"n": 0}

        async def fn():
            calls["n"] += 1
            raise _status_error(404)

        with pytest.raises(httpx.HTTPStatusError):
            await retry_async(fn, attempts=5)
        assert calls["n"] == 1

    async def test_on_retry_callback_fires_per_retry(self):
        seen = []

        async def fn():
            raise httpx.ConnectError("x")

        def on_retry(attempt, exc, delay):
            seen.append(attempt)

        with pytest.raises(httpx.ConnectError):
            await retry_async(fn, attempts=3, on_retry=on_retry)
        # Called before sleeping on attempts 1 and 2, but NOT on the final
        # attempt (which re-raises instead of scheduling another try).
        assert seen == [1, 2]

    async def test_breaker_records_failures_and_opens(self):
        # fail_max == attempts: the breaker trips open on the FINAL failure (which
        # re-raises the transient error), rather than mid-loop where the next
        # attempt's before() would short-circuit with CircuitOpenError. Real
        # callers use fail_max (5) > attempts (3), so the breaker only opens
        # across calls, never within one — this mirrors that.
        cb = CircuitBreaker(fail_max=3)

        async def fn():
            raise httpx.ConnectError("x")

        with pytest.raises(httpx.ConnectError):
            await retry_async(fn, attempts=3, breaker=cb)
        # Three transient failures recorded -> breaker has tripped open.
        assert cb.state == "open"

    async def test_breaker_open_short_circuits_without_calling_fn(self):
        cb = CircuitBreaker(fail_max=1)
        cb.on_failure()  # open it
        assert cb.state == "open"
        calls = {"n": 0}

        async def fn():
            calls["n"] += 1
            return "ok"

        with pytest.raises(CircuitOpenError):
            await retry_async(fn, attempts=3, breaker=cb)
        assert calls["n"] == 0  # fn never invoked while breaker is open

    async def test_breaker_success_resets(self):
        cb = CircuitBreaker(fail_max=3)
        cb.on_failure()  # 1 prior failure

        async def fn():
            return "ok"

        assert await retry_async(fn, attempts=3, breaker=cb) == "ok"
        assert cb.state == "closed"

    async def test_non_transient_marks_breaker_success(self):
        # A 4xx is the dependency working fine; it must NOT count toward opening
        # the breaker. resilience records on_success() for non-transient errors.
        cb = CircuitBreaker(fail_max=2)
        cb.on_failure()  # 1 prior transient failure on record

        async def fn():
            raise _status_error(400)

        with pytest.raises(httpx.HTTPStatusError):
            await retry_async(fn, attempts=3, breaker=cb)
        assert cb.state == "closed"  # success reset, did not trip


# --------------------------------------------------------------------------- #
# retry_async's idempotent flag — the guard against duplicate real sends.
#
# The bug this guards against: every provider send (gmail send_message,
# microsoft send_mail/send_chat_message, slack post_message) used to route
# through retry_async with no way to opt out of retrying a ReadTimeout/5xx —
# both of which can mean the far side already processed the request. A blind
# retry on either risks sending the same real email or chat message twice.
# --------------------------------------------------------------------------- #
def _mk_request() -> httpx.Request:
    return httpx.Request("POST", "https://example.invalid/send")


class _Counter:
    def __init__(self, exc: BaseException, *, fail_times: int = 99) -> None:
        self.exc = exc
        self.fail_times = fail_times
        self.calls = 0

    async def __call__(self):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise self.exc
        return "ok"


# ── idempotent=True (default): unchanged behavior, every transient error retries ──
@pytest.mark.parametrize(
    "exc",
    [
        httpx.ConnectError("x", request=_mk_request()),
        httpx.ConnectTimeout("x", request=_mk_request()),
        httpx.PoolTimeout("x", request=_mk_request()),
        httpx.ReadTimeout("x", request=_mk_request()),
        httpx.WriteTimeout("x", request=_mk_request()),
        _status_error(500),
        _status_error(503),
    ],
)
async def test_idempotent_default_retries_every_transient_error(exc):
    fn = _Counter(exc, fail_times=1)
    result = await retry_async(fn, attempts=3, base_delay=0.001, max_delay=0.001)
    assert result == "ok"
    assert fn.calls == 2  # failed once, succeeded on retry


# ── idempotent=False: only pre-send failures retry ──────────────────────────────
@pytest.mark.parametrize(
    "exc",
    [
        httpx.ConnectError("x", request=_mk_request()),
        httpx.ConnectTimeout("x", request=_mk_request()),
        httpx.PoolTimeout("x", request=_mk_request()),
    ],
)
async def test_non_idempotent_still_retries_pre_send_failures(exc):
    # The request never left the client, so a retry cannot duplicate anything.
    fn = _Counter(exc, fail_times=1)
    result = await retry_async(
        fn, attempts=3, base_delay=0.001, max_delay=0.001, idempotent=False
    )
    assert result == "ok"
    assert fn.calls == 2


@pytest.mark.parametrize(
    "exc",
    [
        httpx.ReadTimeout("x", request=_mk_request()),
        httpx.WriteTimeout("x", request=_mk_request()),
        _status_error(500),
        _status_error(503),
    ],
)
async def test_non_idempotent_does_not_retry_ambiguous_failures(exc):
    # The bug: a ReadTimeout/5xx after the request may have already reached
    # the far side (and been acted on) must surface on the FIRST attempt —
    # not get silently retried into a duplicate real-world send.
    fn = _Counter(exc)
    with pytest.raises(type(exc)):
        await retry_async(fn, attempts=3, base_delay=0.001, max_delay=0.001, idempotent=False)
    assert fn.calls == 1


# ── the circuit breaker must not be blinded by idempotent=False ─────────────────
async def test_breaker_still_opens_on_ambiguous_failure_even_when_not_retried():
    breaker = CircuitBreaker(fail_max=1, reset_timeout=30.0, name="t")
    fn = _Counter(_status_error(500))
    with pytest.raises(httpx.HTTPStatusError):
        await retry_async(
            fn, attempts=3, base_delay=0.001, max_delay=0.001, breaker=breaker, idempotent=False
        )
    # One attempt only (no retry), but the breaker still saw it as a failure —
    # the dependency IS unhealthy even though we chose not to hammer it again.
    assert fn.calls == 1
    assert breaker.state == "open"


async def test_breaker_records_success_on_a_4xx_business_error_regardless_of_idempotent():
    # A 4xx means the dependency answered; it is not evidence of an unhealthy
    # dependency, so the breaker treats it as a success either way.
    breaker = CircuitBreaker(fail_max=1, reset_timeout=30.0, name="t")
    breaker.on_failure()  # pre-open it (fail_max=1)
    assert breaker.state == "open"
    breaker._state = "half_open"  # simulate the cooldown having elapsed
    fn = _Counter(_status_error(400))
    with pytest.raises(httpx.HTTPStatusError):
        await retry_async(
            fn, attempts=3, base_delay=0.001, max_delay=0.001, breaker=breaker, idempotent=False
        )
    assert breaker.state == "closed"


# ── is_transient itself is unaffected by idempotency (sanity) ───────────────────
def test_is_transient_is_not_parameterized_by_idempotency():
    assert is_transient(httpx.ReadTimeout("x", request=_mk_request())) is True
    assert is_transient(_status_error(500)) is True
    assert is_transient(_status_error(404)) is False
