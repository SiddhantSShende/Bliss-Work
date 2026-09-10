"""Unit tests for the per-IP fixed-window limiter on abuse-prone auth routes.

Target: ``app.rate_limit.SensitiveRateLimitMiddleware`` and its rule table.

We drive the middleware's ``dispatch`` directly with a synthetic ASGI request
and a trivial ``call_next``. ``time.monotonic`` is monkeypatched to a fake clock
so we can advance "time" deterministically without sleeping — this keeps the
window/reset assertions fast and flake-free. No network, DB or real sleeping.

The async ``dispatch`` coroutine is driven via ``asyncio.run`` from plain sync
tests so we don't depend on a pytest async plugin (pytest-asyncio / anyio) being
installed in CI.
"""
from __future__ import annotations

import asyncio

import pytest
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app import rate_limit
from app.rate_limit import (
    _SENSITIVE_LIMITS,
    SensitiveRateLimitMiddleware,
)


# ── test doubles ─────────────────────────────────────────────────────────────
class FakeClock:
    """Deterministic monotonic clock. ``advance`` moves it forward."""

    def __init__(self, now: float = 1_000.0) -> None:
        self.now = now

    def __call__(self) -> float:  # mimics time.monotonic
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def make_request(method: str, path: str, ip: str = "1.2.3.4") -> Request:
    """Build a minimal-but-real Starlette Request for ``dispatch``.

    ``slowapi.util.get_remote_address`` reads ``request.client.host``; we set it
    via the ASGI ``client`` 2-tuple so per-IP bucketing keys off ``ip``.
    """
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "raw_path": path.encode(),
        "headers": [],
        "query_string": b"",
        "client": (ip, 12345),
        "server": ("testserver", 80),
        "scheme": "http",
    }
    return Request(scope)


async def ok_call_next(_request: Request) -> Response:
    """Downstream app: always 200. Lets us tell 'passed' from a 429 reject."""
    return Response(status_code=200)


def dispatch(mw: SensitiveRateLimitMiddleware, request: Request) -> Response:
    """Run the async middleware dispatch synchronously."""
    return asyncio.run(mw.dispatch(request, ok_call_next))


# A representative sensitive route + its configured budget.
SENSITIVE_PATH = "/auth/login"
SENSITIVE_METHOD = "POST"
SENSITIVE_LIMIT, SENSITIVE_WINDOW = _SENSITIVE_LIMITS[(SENSITIVE_METHOD, SENSITIVE_PATH)]


@pytest.fixture
def mw() -> SensitiveRateLimitMiddleware:
    # app=None is fine: dispatch never calls into the wrapped app, only call_next.
    return SensitiveRateLimitMiddleware(app=None)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> FakeClock:
    c = FakeClock()
    monkeypatch.setattr(rate_limit.time, "monotonic", c)
    return c


# ── rule table ───────────────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "method,path,limit,window",
    [
        ("POST", "/auth/login", 10, 60),
        ("POST", "/auth/orgs", 5, 60),
        ("POST", "/auth/refresh", 30, 60),
        # CAPTCHA generation is otherwise free (no auth, no cost to the
        # caller) — without a budget of its own it becomes a DoS/enumeration
        # vector in its own right. Read from settings, not hardcoded.
        ("GET", "/auth/captcha", rate_limit.settings.captcha_rate_limit_per_minute, 60),
    ],
)
def test_sensitive_limits_table(method: str, path: str, limit: int, window: int) -> None:
    """The tight per-endpoint budgets are exactly the documented values."""
    assert _SENSITIVE_LIMITS[(method, path)] == (limit, window)


def test_captcha_generation_is_rate_limited_per_ip(
    mw: SensitiveRateLimitMiddleware, clock: FakeClock
) -> None:
    limit, _window = _SENSITIVE_LIMITS[("GET", "/auth/captcha")]
    for _ in range(limit):
        resp = dispatch(mw, make_request("GET", "/auth/captcha"))
        assert resp.status_code == 200
    blocked = dispatch(mw, make_request("GET", "/auth/captcha"))
    assert blocked.status_code == 429


# ── pass-through for non-sensitive routes ────────────────────────────────────
def test_non_sensitive_route_is_never_limited(
    mw: SensitiveRateLimitMiddleware, clock: FakeClock
) -> None:
    """A route absent from the rule table is always forwarded (no bucket)."""
    for _ in range(SENSITIVE_LIMIT * 5):
        resp = dispatch(mw, make_request("GET", "/healthz"))
        assert resp.status_code == 200
    assert mw._buckets == {}  # never tracked


def test_get_on_sensitive_path_is_not_limited(
    mw: SensitiveRateLimitMiddleware, clock: FakeClock
) -> None:
    """Rule keys on (METHOD, path): GET /auth/login is not POST /auth/login."""
    for _ in range(SENSITIVE_LIMIT * 3):
        resp = dispatch(mw, make_request("GET", SENSITIVE_PATH))
        assert resp.status_code == 200


# ── core fixed-window behavior ───────────────────────────────────────────────
def test_allows_up_to_limit_then_429(
    mw: SensitiveRateLimitMiddleware, clock: FakeClock
) -> None:
    """Exactly ``limit`` requests pass within a window; the next is rejected."""
    for i in range(SENSITIVE_LIMIT):
        resp = dispatch(mw, make_request(SENSITIVE_METHOD, SENSITIVE_PATH))
        assert resp.status_code == 200, f"request #{i + 1} should pass"

    # The (limit + 1)-th request within the same window is rejected.
    rejected = dispatch(mw, make_request(SENSITIVE_METHOD, SENSITIVE_PATH))
    assert rejected.status_code == 429
    assert isinstance(rejected, JSONResponse)
    # Canonical error envelope + Retry-After is set and positive.
    assert rejected.headers["Retry-After"]
    assert int(rejected.headers["Retry-After"]) >= 1


def test_window_resets_after_elapsed(
    mw: SensitiveRateLimitMiddleware, clock: FakeClock
) -> None:
    """Once the window elapses the counter resets and traffic flows again."""
    # Burn the whole budget.
    for _ in range(SENSITIVE_LIMIT):
        dispatch(mw, make_request(SENSITIVE_METHOD, SENSITIVE_PATH))
    blocked = dispatch(mw, make_request(SENSITIVE_METHOD, SENSITIVE_PATH))
    assert blocked.status_code == 429

    # Advance past the window: the next request opens a fresh bucket.
    clock.advance(SENSITIVE_WINDOW)
    resp = dispatch(mw, make_request(SENSITIVE_METHOD, SENSITIVE_PATH))
    assert resp.status_code == 200

    # And the budget is full again (limit - 1 more allowed before another 429).
    for _ in range(SENSITIVE_LIMIT - 1):
        r = dispatch(mw, make_request(SENSITIVE_METHOD, SENSITIVE_PATH))
        assert r.status_code == 200
    again = dispatch(mw, make_request(SENSITIVE_METHOD, SENSITIVE_PATH))
    assert again.status_code == 429


def test_within_window_does_not_reset(
    mw: SensitiveRateLimitMiddleware, clock: FakeClock
) -> None:
    """A small time advance that stays inside the window must NOT reset."""
    for _ in range(SENSITIVE_LIMIT):
        dispatch(mw, make_request(SENSITIVE_METHOD, SENSITIVE_PATH))
    clock.advance(SENSITIVE_WINDOW - 1)  # still inside the window
    blocked = dispatch(mw, make_request(SENSITIVE_METHOD, SENSITIVE_PATH))
    assert blocked.status_code == 429


# ── per-(ip, path) isolation ─────────────────────────────────────────────────
def test_per_ip_isolation(
    mw: SensitiveRateLimitMiddleware, clock: FakeClock
) -> None:
    """One IP exhausting its budget does not affect a different IP."""
    for _ in range(SENSITIVE_LIMIT):
        dispatch(mw, make_request(SENSITIVE_METHOD, SENSITIVE_PATH, ip="10.0.0.1"))
    blocked = dispatch(mw, make_request(SENSITIVE_METHOD, SENSITIVE_PATH, ip="10.0.0.1"))
    assert blocked.status_code == 429

    # A fresh IP gets its own full budget.
    other = dispatch(mw, make_request(SENSITIVE_METHOD, SENSITIVE_PATH, ip="10.0.0.2"))
    assert other.status_code == 200


def test_per_path_isolation(
    mw: SensitiveRateLimitMiddleware, clock: FakeClock
) -> None:
    """Different sensitive paths bucket independently for the same IP."""
    # Exhaust /auth/orgs (limit 5) for one IP.
    orgs_limit = _SENSITIVE_LIMITS[("POST", "/auth/orgs")][0]
    for _ in range(orgs_limit):
        dispatch(mw, make_request("POST", "/auth/orgs"))
    blocked = dispatch(mw, make_request("POST", "/auth/orgs"))
    assert blocked.status_code == 429

    # The same IP can still hit /auth/login — separate bucket.
    login = dispatch(mw, make_request("POST", "/auth/login"))
    assert login.status_code == 200
