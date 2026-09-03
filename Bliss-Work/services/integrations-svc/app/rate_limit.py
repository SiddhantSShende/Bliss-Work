"""Rate limit configuration for integrations-svc — mirrors auth-svc/app/rate_limit.py.

Per-user, because the expensive surfaces here spend someone ELSE's budget: an
OAuth connect/refresh burst is hammering a provider's API under our client
credentials, and an outbound forward turns one call into a third-party delivery.
"""
from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded

from client_ip import rate_limit_key as _rate_limit_key

from .config import settings


# NOTE: slowapi.util.get_remote_address is deliberately NOT used here. It
# returns request.client.host, which behind our edge is Caddy's address on
# every request — see services/shared/client_ip/client_ip.py. Reintroducing
# it silently turns the per-caller budget below into a single global one.
def rate_limit_key(request: Request) -> str:
    return _rate_limit_key(request, settings.trusted_proxy_hops)


limiter = Limiter(
    key_func=rate_limit_key,
    default_limits=["600/minute"],  # global per-key safety net
    headers_enabled=True,
    # Redis storage makes the ceiling honest across replicas. Without it slowapi
    # keeps its buckets in process memory, so every limit here silently
    # multiplies by the replica count — and worse, becomes non-deterministic,
    # since what a caller actually gets depends on how the load balancer
    # happened to spread their requests. docker-compose.prod.yml runs this
    # service with two replicas behind Caddy, so that is not hypothetical.
    # Falls back to in-process when no Redis is configured, which is the correct
    # behaviour for a single instance.
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
