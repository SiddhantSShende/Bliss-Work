"""auth-svc — identity keystone. FastAPI app, lifespan, CORS, routing."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from prometheus_fastapi_instrumentator import Instrumentator
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from .config import settings
from .crypto import init_cryptor
from .db import engine, run_migrations
from .errors import register_exception_handlers
from .events.poller import OutboxPoller
from .logging_config import configure_logging, log
from .middleware import BodySizeLimitMiddleware, RequestIDMiddleware, SecurityHeadersMiddleware
from .rate_limit import SensitiveRateLimitMiddleware, limiter, rate_limit_handler
from .routes import auth as auth_routes
from .routes import email_verify as email_verify_routes
from .routes import internal as internal_routes
from .routes import invites as invite_routes
from .routes import jwks as jwks_routes
from .routes import password_reset as password_reset_routes
from .security.keys import jwks  # warm key load
from .tracing import setup_tracing, shutdown_tracing

configure_logging(settings.log_level)

_poller = OutboxPoller()


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("auth_svc_starting")
    await run_migrations()
    # Fail fast if the signing key cannot be loaded.
    jwks()
    # Build the at-rest column-encryption Cryptor (per-org DEK envelope). Fails
    # fast if the KEK/blind-index secrets are misconfigured.
    init_cryptor(settings)
    # Production-safety warnings (don't crash dev): a missing internal token means
    # the internal endpoints reject every caller; an http-on-prod cookie leaks the
    # refresh token. Surface these loudly so a misconfigured deploy is obvious.
    if not os.getenv("TB_INTERNAL_TOKEN"):
        log.warning("tb_internal_token_unset", detail="internal service endpoints will reject all callers")
    if settings.web_origin.startswith("https://") and not settings.cookie_secure:
        log.warning("cookie_secure_false_behind_tls", detail="set COOKIE_SECURE=true so refresh cookies are TLS-only")
    await _poller.start()
    log.info("auth_svc_ready")
    try:
        yield
    finally:
        await _poller.stop()
        await engine.dispose()
        shutdown_tracing()  # flush any buffered spans (no-op when disabled)
        log.info("auth_svc_stopped")


_prod = settings.tb_env.strip().lower() in {"production", "prod"}
# Defense-in-depth: no interactive docs / OpenAPI schema in prod. The edge already
# 404s these, but disabling them here also covers the private network and dev-mode
# leaks. Kept on outside production for developer convenience.
app = FastAPI(
    title="auth-svc",
    lifespan=lifespan,
    docs_url=None if _prod else "/docs",
    redoc_url=None if _prod else "/redoc",
    openapi_url=None if _prod else "/openapi.json",
)

# Canonical-shape exception handlers (HTTPException, validation, Exception).
register_exception_handlers(app)

# slowapi: wire the limiter singleton, the exception handler, and the
# SlowAPIMiddleware (which evaluates the @limiter.limit decorators).
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_handler)

# Middleware order: Starlette runs them inside-out, so the *last* add_middleware
# call is the outermost wrapper. We want CORS outermost (so CORS headers land
# even on 429/500 responses), then security headers, then request-id (innermost
# so it tags structlog before any handler runs and is visible to nested logs).
app.add_middleware(SlowAPIMiddleware)
# Tight per-IP limits on login/orgs/refresh (runs just outside SlowAPI, after
# RequestID so its 429 carries the request id).
app.add_middleware(SensitiveRateLimitMiddleware)
app.add_middleware(RequestIDMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(BodySizeLimitMiddleware)
# CORS allowlist: the web origin (exact) + Electron desktop origins — file://,
# app://, and the literal `null` Chromium sends from a file:// document — are
# allowed in every environment. Loopback (localhost/127.0.0.1) origins are
# allowed ONLY outside production, so a page on a victim's localhost can't make
# credentialed calls to the prod API.
_cors_origin_regex = (
    r"^(app://.*|file://.*|null)$"
    if _prod
    else r"^(app://.*|file://.*|null|https?://(localhost|127\.0\.0\.1)(:\d+)?)$"
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_origin],
    allow_origin_regex=_cors_origin_regex,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,  # auth-svc needs the refresh cookie
    expose_headers=["X-Request-Id", "Retry-After"],
)

# OpenTelemetry distributed tracing — no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is
# set, so dev runs without a collector are unchanged. Wired after the middleware
# stack so the FastAPI instrumentor wraps the fully assembled app.
setup_tracing(app)

# Prometheus /metrics — HTTP RED metrics (request count, latency, in-progress).
# instrument() installs the middleware; expose() mounts the scrape endpoint
# (unauthenticated — Prometheus scrapes it directly; not in the OpenAPI schema).
# should_group_status_codes=False keeps the exact numeric status label (401/429/…)
# so security alerts can tell credential-stuffing (401) from rate-limit (429).
Instrumentator(should_group_status_codes=False).instrument(app).expose(app, include_in_schema=False)

app.include_router(jwks_routes.router)
app.include_router(auth_routes.router)
app.include_router(invite_routes.router)
app.include_router(password_reset_routes.router)
app.include_router(email_verify_routes.router)
app.include_router(internal_routes.router)
