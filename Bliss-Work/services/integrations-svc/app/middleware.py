"""HTTP middleware for task-svc — mirrors auth-svc/app/middleware.py.

See the docstring in auth-svc for design notes. We duplicate (instead of
importing across services) to keep services independently deployable.
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
# auth/task payloads are tiny, so this bounds a memory/CPU DoS from an oversized
# body. Clients (fetch/axios/browsers) always send Content-Length for a JSON body,
# so the header check is the effective control; a chunked body with no length is
# additionally bounded by the reverse-proxy body limit in prod.
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

SECURITY_HEADERS = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
}


class RequestIDMiddleware(BaseHTTPMiddleware):
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
    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        response = await call_next(request)
        for k, v in SECURITY_HEADERS.items():
            response.headers.setdefault(k, v)
        return response


class PrincipalMiddleware(BaseHTTPMiddleware):
    """Verify the bearer token once, before anything needs to know who it is.

    ── Why this is middleware and not (only) a dependency ───────────────────
    The rate limiter buckets by user when it can and by IP otherwise, and it
    runs in SlowAPIMiddleware.dispatch() — which is strictly BEFORE FastAPI
    resolves any dependency. The limiter's `user:` branch therefore read a
    `request.state.principal` that nothing had ever assigned, so every request,
    authenticated or not, fell through to the IP bucket — and that bucket was
    itself global (see app/net.py).

    Verifying here fixes the ordering and costs nothing net: `require_principal`
    reuses what this stores, so a token is verified once per request, not twice.

    ── It must never reject ─────────────────────────────────────────────────
    A missing, malformed or expired token leaves `request.state.principal`
    unset and the request continues. Authorization stays entirely with
    `require_principal`, which produces the canonical 401 with the right error
    envelope on routes that need it — and public routes (health, metrics) keep
    working, which they would not if this refused anything.
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        auth = request.headers.get("authorization")
        if auth and auth.lower().startswith("bearer "):
            # Lazy import: auth.py pulls in httpx and the JWKS cache, and
            # importing it at module scope would create a cycle.
            from .auth import verify_bearer

            try:
                request.state.principal = await verify_bearer(auth)
            except Exception:  # noqa: BLE001 — identity is best-effort here
                request.state.principal = None
        else:
            request.state.principal = None
        return await call_next(request)
