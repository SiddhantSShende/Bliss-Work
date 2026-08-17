"""Rate limit configuration for telemetry-svc — mirrors auth-svc/app/rate_limit.py.

Ingest is the highest-QPS surface in the product: a beacon per open client every
30s, plus desktop samples, plus extension batches. The per-key ceiling here is
what stops one looping client (or one hostile token) from turning that firehose
into a write amplification attack on a shared Postgres. Export is limited far
harder at the route, because one call can scan 20k rollup rows.
"""
from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded

from .net import rate_limit_key

from .config import settings


# NOTE: slowapi.util.get_remote_address is deliberately NOT used here. It
# returns request.client.host, which behind our edge is Caddy's address on
# every request — see app/net.py. Reintroducing it silently turns the
# per-caller budget below into a single global one.


limiter = Limiter(
    key_func=rate_limit_key,
    default_limits=["600/minute"],  # global per-key safety net
    headers_enabled=True,
    # Redis storage makes the limit honest across pods. Without it slowapi uses
    # an in-process store, so every ceiling here silently multiplies by the
    # replica count — the 600/min default, the 10/min export cap and the 60/min
    # agent-ingest cap all become N times looser the moment this scales out,
    # which is precisely when they matter. Falls back to in-process when no
    # Redis is configured, which is the correct behaviour for a single instance.
    #
    # swallow_errors fails OPEN on a Redis blip: serving unlimited beats
    # 500-ing every request because the limiter's store is unreachable.
    storage_uri=settings.slowapi_storage_uri or settings.redis_url or "memory://",
    swallow_errors=True,
)


async def rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
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
