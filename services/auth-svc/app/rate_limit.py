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

from .config import settings
from .logging_config import log


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
    # Redis storage makes the limit honest across pods; falls back to REDIS_URL
    # (so just setting that one var makes BOTH this limiter and the sensitive
    # middleware distributed), then to in-process "memory://" (per-pod).
    # swallow_errors keeps the service up (fails OPEN on a Redis blip) rather
    # than 500-ing every request when the store is unreachable.
    storage_uri=settings.slowapi_storage_uri or settings.redis_url or "memory://",
    swallow_errors=True,
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
    # Email-secret flows: tight per-IP budgets so an attacker can't spray reset
    # links / grind reset tokens / spam verification resends. Per-account abuse
    # is separately bounded by single-use short-TTL tokens + prior-token
    # invalidation (see routes/account_service.py).
    ("POST", "/auth/password/forgot"): (3, 60),
    ("POST", "/auth/password/reset"): (5, 60),
    ("POST", "/auth/email/resend"): (3, 60),
    ("POST", "/auth/email/verify"): (10, 60),
}

_MAX_BUCKETS = 100_000  # bound memory under an IP-rotating flood
_MAX_WINDOW = 60


class SensitiveRateLimitMiddleware(BaseHTTPMiddleware):
    """Per-IP fixed-window limiter for the most abuse-prone auth endpoints.

    Redis-backed when REDIS_URL/SLOWAPI_STORAGE_URI is set (honest across pods);
    otherwise an in-process dict (per-pod). On any Redis error we fall back to
    the in-process path so a Redis blip degrades to per-pod limiting rather than
    failing fully open."""

    def __init__(self, app) -> None:
        super().__init__(app)
        self._buckets: dict[tuple[str, str, str], tuple[int, float]] = {}
        self._redis = None
        uri = settings.redis_url or settings.slowapi_storage_uri
        if uri.startswith(("redis://", "rediss://")):
            try:
                import redis.asyncio as aioredis

                # Short timeouts: a slow/unreachable Redis must not pin the auth
                # hot path — we time out and fall back to the in-process limiter.
                self._redis = aioredis.from_url(
                    uri, socket_timeout=0.25, socket_connect_timeout=0.25
                )
            except Exception as exc:  # noqa: BLE001 - fall back to in-process
                log.warning("ratelimit_redis_init_failed", error=str(exc))
                self._redis = None

    async def dispatch(self, request: Request, call_next):
        rule = _SENSITIVE_LIMITS.get((request.method, request.url.path))
        if rule is None:
            return await call_next(request)
        limit, window = rule
        ip = get_remote_address(request)
        allowed, retry_after = await self._check(request.method, request.url.path, ip, limit, window)
        if not allowed:
            rid = request.headers.get("x-request-id") or ""
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

    async def _check(self, method: str, path: str, ip: str, limit: int, window: int) -> tuple[bool, int]:
        """Return (allowed, retry_after_seconds)."""
        if self._redis is not None:
            try:
                key = f"authrl:{method}:{path}:{ip}"
                count = await self._redis.incr(key)
                if count == 1:
                    await self._redis.expire(key, window)
                    ttl = window
                else:
                    ttl = await self._redis.ttl(key)
                    if ttl < 0:  # missing TTL (shouldn't happen) — re-arm it
                        await self._redis.expire(key, window)
                        ttl = window
                if count > limit:
                    return False, max(1, int(ttl))
                return True, 0
            except Exception as exc:  # noqa: BLE001 - degrade to in-process
                log.warning("ratelimit_redis_error", error=str(exc))
        return self._check_inprocess(method, path, ip, limit, window)

    def _check_inprocess(self, method: str, path: str, ip: str, limit: int, window: int) -> tuple[bool, int]:
        now = time.monotonic()
        key = (method, path, ip)
        count, start = self._buckets.get(key, (0, now))
        if now - start >= window:  # window elapsed: reset
            count, start = 0, now
        count += 1
        self._buckets[key] = (count, start)
        if len(self._buckets) > _MAX_BUCKETS:
            self._purge_expired(now)
        if count > limit:
            return False, max(1, int(window - (now - start)))
        return True, 0

    def _purge_expired(self, now: float) -> None:
        stale = [k for k, (_, start) in self._buckets.items() if now - start >= _MAX_WINDOW]
        for k in stale:
            self._buckets.pop(k, None)
