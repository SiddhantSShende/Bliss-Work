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
from slowapi.util import get_remote_address


def _user_or_ip(request: Request) -> str:
    principal = getattr(request.state, "principal", None)
    if principal is not None and getattr(principal, "user_id", None):
        return f"user:{principal.user_id}"
    return f"ip:{get_remote_address(request)}"


limiter = Limiter(
    key_func=_user_or_ip,
    default_limits=["600/minute"],  # global per-key safety net
    headers_enabled=True,
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
