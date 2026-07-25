"""Rate limit configuration for task-svc — mirrors auth-svc/app/rate_limit.py.

Task creation and state mutation are limited per-user since these turn into
fan-out events; an org_admin who scripts a million `createTask` calls is the
worst case to plan for.
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
