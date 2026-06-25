"""Rate limit configuration for auth-svc.

Auth endpoints are the most abuse-prone surface (credential stuffing, account
enumeration, invite spam). We limit them hard at the application layer; in
production this is layered with an edge WAF (see INFRASTRUCTURE.md).

The limiter is in-process by default (slowapi's MemoryStore). For multi-pod
deployment, point slowapi at Redis via SLOWAPI_STORAGE_URI; this still fails
open if Redis is unreachable.
"""
from __future__ import annotations

import time

from fastapi import Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.middleware.base import BaseHTTPMiddleware


def _user_or_ip(request: Request) -> str:
    """Bucket key: authed user if we have one, else source IP. Falls back to
    IP when the request hasn't been verified yet (e.g. /login itself)."""
    # The auth dependency stores the principal on request.state when run.
    principal = getattr(request.state, "principal", None)
    if principal is not None and getattr(principal, "user_id", None):
        return f"user:{principal.user_id}"
    return f"ip:{get_remote_address(request)}"


limiter = Limiter(
    key_func=_user_or_ip,
    # default_limits applies to EVERY route via SlowAPIMiddleware. We use it
    # because the route-level @limiter.limit decorator breaks FastAPI body
    # parsing in services that use `from __future__ import annotations`
    # (pydantic 2 forward-ref resolution gets confused). Per-route caps that
    # need to differ from this global one live in middleware.py's custom
    # logic — which is also why the Go services apply per-route budgets.
    default_limits=["120/minute"],
    headers_enabled=True,  # adds X-RateLimit-{Limit,Remaining,Reset}
)


async def rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """Emit the canonical error envelope on 429."""
    rid = request.headers.get("x-request-id") or ""
    body = {
        "error": {
            "code": "rate_limited",
            "message": "too many requests",
            "requestId": rid,
        }
    }
    response = JSONResponse(status_code=429, content=body)
    response.headers["Retry-After"] = "60"
    response.headers["X-Request-Id"] = rid
    return response


# ── Per-endpoint tight limits for abuse-prone auth surfaces ──────────────────
# (METHOD, path) -> (max_requests, window_seconds). Login / org-creation /
# refresh are the highest-value abuse targets (credential stuffing, signup spam,
# refresh-token grinding), so they get a far tighter per-IP budget than the
# global 120/min default. Implemented as a small middleware because slowapi's
# per-route @limiter.limit decorator breaks FastAPI body parsing under
# `from __future__ import annotations` (see module docstring). In-process per pod
# (same trade-off as the slowapi MemoryStore); back with Redis for a multi-pod
# honest limit.
_SENSITIVE_LIMITS: dict[tuple[str, str], tuple[int, int]] = {
    ("POST", "/auth/login"): (10, 60),
    ("POST", "/auth/orgs"): (5, 60),
    ("POST", "/auth/refresh"): (30, 60),
}

_MAX_BUCKETS = 100_000  # bound memory under an IP-rotating flood
_MAX_WINDOW = 60


class SensitiveRateLimitMiddleware(BaseHTTPMiddleware):
    """Per-IP fixed-window limiter for the most abuse-prone auth endpoints."""

    def __init__(self, app) -> None:
        super().__init__(app)
        self._buckets: dict[tuple[str, str, str], tuple[int, float]] = {}

    async def dispatch(self, request: Request, call_next):
        rule = _SENSITIVE_LIMITS.get((request.method, request.url.path))
        if rule is None:
            return await call_next(request)
        limit, window = rule
        ip = get_remote_address(request)
        now = time.monotonic()
        key = (request.method, request.url.path, ip)
        count, start = self._buckets.get(key, (0, now))
        if now - start >= window:  # window elapsed: reset
            count, start = 0, now
        count += 1
        self._buckets[key] = (count, start)
        if len(self._buckets) > _MAX_BUCKETS:
            self._purge_expired(now)
        if count > limit:
            rid = request.headers.get("x-request-id") or ""
            retry_after = max(1, int(window - (now - start)))
            response = JSONResponse(
                status_code=429,
                content={
                    "error": {"code": "rate_limited", "message": "too many requests", "requestId": rid}
                },
            )
            response.headers["Retry-After"] = str(retry_after)
            response.headers["X-Request-Id"] = rid
            return response
        return await call_next(request)

    def _purge_expired(self, now: float) -> None:
        stale = [k for k, (_, start) in self._buckets.items() if now - start >= _MAX_WINDOW]
        for k in stale:
            self._buckets.pop(k, None)
