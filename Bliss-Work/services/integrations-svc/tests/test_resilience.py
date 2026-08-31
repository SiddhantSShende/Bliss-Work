"""retry_async's idempotent flag — the guard against duplicate real sends.

The bug: every provider send (gmail send_message, microsoft send_mail/
send_chat_message, slack post_message) used to route through retry_async with
no way to opt out of retrying a ReadTimeout/5xx — both of which can mean the
far side already processed the request. A blind retry on either risks sending
the same real email or chat message twice. These tests exercise retry_async
directly (no network) to pin the exact behavior the fix depends on.
"""
from __future__ import annotations

import httpx
import pytest

from app.resilience import CircuitBreaker, is_transient, retry_async


def _mk_request() -> httpx.Request:
    return httpx.Request("POST", "https://example.invalid/send")


def _status_error(code: int) -> httpx.HTTPStatusError:
    resp = httpx.Response(status_code=code, request=_mk_request())
    return httpx.HTTPStatusError("boom", request=_mk_request(), response=resp)


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
