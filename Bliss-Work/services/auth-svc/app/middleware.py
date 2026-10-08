"""HTTP middleware for auth-svc.

request_id_middleware: every response carries X-Request-Id (forwarded by the
caller or freshly minted), pushed into structlog's contextvars so every log
line for the request is tagged.

security_headers_middleware: hard-set the OWASP-recommended response headers.

The actual rate-limit middleware lives in `rate_limit.py` (slowapi).
"""
from __future__ import annotations

import uuid
from typing import Any, Awaitable, Callable

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

HEADER_REQUEST_ID = "X-Request-Id"

# Max request body (bytes). Mirrors the Go services' `mw.MaxBytes(1<<20)`. JSON
# auth payloads are tiny, so this bounds a memory/CPU DoS from an oversized body.
MAX_BODY_BYTES = 1 << 20  # 1 MiB


class BodySizeLimitMiddleware:
    """Bound declared and streamed request bodies before application handling."""

    def __init__(self, app: Callable[..., Awaitable[None]], max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: dict[str, Any], receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        content_length = headers.get(b"content-length")
        if content_length is not None:
            try:
                declared_size = int(content_length)
            except ValueError:
                await self._reject(send, 400, "invalid content-length")
                return
            if declared_size < 0:
                await self._reject(send, 400, "invalid content-length")
                return
            if declared_size > self.max_bytes:
                await self._reject(send, 413, "request entity too large")
                return

        messages = []
        total = 0
        while True:
            message = await receive()
            messages.append(message)
            if message["type"] == "http.disconnect":
                break
            if message["type"] != "http.request":
                continue
            total += len(message.get("body", b""))
            if total > self.max_bytes:
                await self._reject(send, 413, "request entity too large")
                return
            if not message.get("more_body", False):
                break

        async def replay_receive():
            if messages:
                return messages.pop(0)
            return await receive()

        await self.app(scope, replay_receive, send)

    @staticmethod
    async def _reject(send, status_code: int, message: str) -> None:
        body = message.encode("ascii")
        await send(
            {
                "type": "http.response.start",
                "status": status_code,
                "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


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


class PrincipalMiddleware(BaseHTTPMiddleware):
    """Verify the bearer token once, before anything needs to know who it is.

    ── Why this is middleware and not (only) a dependency ───────────────────
    The rate limiter buckets by user when it can and by IP otherwise, and it
    runs in SlowAPIMiddleware.dispatch() — which is strictly BEFORE FastAPI
    resolves any dependency. The limiter's `user:` branch therefore read a
    `request.state.principal` that nothing had ever assigned, so every request,
    authenticated or not, fell through to the IP bucket.

    Verifying here fixes the ordering and costs nothing net: `get_principal`
    reuses what this stores, so the token is verified once per request rather
    than twice.

    ── It must never reject ─────────────────────────────────────────────────
    A missing, malformed or expired token leaves `request.state.principal`
    unset and the request continues. Authorization stays entirely with
    `get_principal`, which produces the canonical 401 with the right error
    envelope on routes that require it — and public routes (login, JWKS,
    health) keep working, which they would not if this refused anything.
    Swallowing includes JWKS failures: a degraded keystore must not turn every
    unauthenticated request into a 503.
    """

    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        auth = request.headers.get("authorization")
        if auth and auth.lower().startswith("bearer "):
            # Imported lazily: auth_dep pulls in httpx and the JWKS cache, and
            # importing it at module scope would make this module a dependency
            # of the security package that imports it back.
            from .security.auth_dep import verify_bearer

            try:
                request.state.principal = await verify_bearer(auth)
            except Exception:  # noqa: BLE001 — identity is best-effort here
                request.state.principal = None
        else:
            request.state.principal = None
        return await call_next(request)
