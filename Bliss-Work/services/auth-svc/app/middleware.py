"""HTTP middleware for auth-svc.

request_id_middleware: every response carries X-Request-Id (forwarded by the
caller or freshly minted), pushed into structlog's contextvars so every log
line for the request is tagged.

security_headers_middleware: hard-set the OWASP-recommended response headers.

The actual rate-limit middleware lives in `rate_limit.py` (slowapi).
"""
from __future__ import annotations

import uuid
from typing import Awaitable, Callable

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

HEADER_REQUEST_ID = "X-Request-Id"

# Max request body (bytes). Mirrors the Go services' `mw.MaxBytes(1<<20)`. JSON
# auth payloads are tiny, so this bounds a memory/CPU DoS from an oversized body.
# Clients always send Content-Length for a JSON body, so the header check is the
# effective control; chunked bodies with no length are additionally bounded by
# the reverse-proxy body limit in prod.
MAX_BODY_BYTES = 1 << 20  # 1 MiB


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    """Reject requests whose declared Content-Length exceeds the cap with 413."""

    def __init__(self, app, max_bytes: int = MAX_BODY_BYTES) -> None:
        super().__init__(app)
        self.max_bytes = max_bytes

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        cl = request.headers.get("content-length")
        if cl is not None:
            try:
                if int(cl) > self.max_bytes:
                    return Response("request entity too large", status_code=413)
            except ValueError:
                return Response("invalid content-length", status_code=400)
        return await call_next(request)


# OWASP-recommended response headers. Identical to the set Go services emit.
SECURITY_HEADERS = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    # API responses are not framed by browsers; lock CSP all the way down.
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Stamp X-Request-Id on the response + structlog context + request.state.

    request.state.request_id is the canonical place the global exception
    handler in errors.py reads from; if we only put it in headers, an
    exception handler firing on a route that hasn't returned yet wouldn't
    see the freshly-minted id.
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        rid = request.headers.get(HEADER_REQUEST_ID) or ""
        if not rid or len(rid) > 128:
            rid = uuid.uuid4().hex
        request.state.request_id = rid
        structlog.contextvars.bind_contextvars(request_id=rid)
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.unbind_contextvars("request_id")
        response.headers[HEADER_REQUEST_ID] = rid
        return response


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Set OWASP-recommended response headers on every response."""

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        response = await call_next(request)
        for k, v in SECURITY_HEADERS.items():
            response.headers.setdefault(k, v)
        return response
