"""sticky-svc — the durable record of which task notes belong on a desktop.

Reads task.events.v1 and maintains one row per (org, assignee, task): OPEN from
the moment a task is assigned, CLOSED only when it reaches a terminal status.
Clients ask it what should be stuck to the user's desktop and join the ids
against task-svc for the note's content.

The same row carries the USER's choice, kept apart from that lifecycle:
PUT/DELETE /sticky/pins/{task} pin or unpin a task, reversibly, and each change
is published as `sticky.pin.changed` (via a transactional outbox) so every device
of that user follows. See app/transitions.py for the two axes and why they must
never be merged.

Why a service and not a column on task_assignees: this also records DELIVERY —
whether a note has ever actually reached a screen — which is what lets
sticky-relay tell "they have seen it and are working on it" apart from "the
websocket frame was lost and they have no idea". task-svc has no business
knowing about desktop windows.

Deliberately stores NO task title or description. Those are encrypted at rest in
task-svc under a per-org DEK; a second copy here would double the key-rotation
and compliance surface to save one round-trip the client already makes.
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from prometheus_fastapi_instrumentator import Instrumentator
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from sqlalchemy import text

from .config import settings
from .consumer import consumer
from .db import dispose_engine, get_engine, init_engine, run_migrations
from .errors import register_exception_handlers
from .logging_setup import configure_logging, log
from .outbox import poller as outbox_poller
from .middleware import BodySizeLimitMiddleware, PrincipalMiddleware, RequestIDMiddleware, SecurityHeadersMiddleware
from .rate_limit import limiter, rate_limit_handler
from .routes import internal, router
from .tracing import setup_tracing
from tracing import shutdown_tracing

configure_logging(settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_engine()
    # Wire tracing after the engine exists so SQLAlchemy can instrument it; no-op
    # unless OTEL_EXPORTER_OTLP_ENDPOINT is set. The FastAPI app + middleware are
    # already configured at module import, so instrument_app() binds cleanly.
    setup_tracing(app)
    await run_migrations()
    await consumer.start()
    await outbox_poller.start()
    log.info("sticky_svc_started", port=settings.port)
    try:
        yield
    finally:
        await outbox_poller.stop()
        await consumer.stop()
        await dispose_engine()
        shutdown_tracing(log=log)  # flush any buffered spans (no-op when disabled)
        log.info("sticky_svc_stopped")


_prod = settings.tb_env.strip().lower() in {"production", "prod"}
# Defense-in-depth: no interactive docs / OpenAPI schema in prod (mirrors auth-svc).
app = FastAPI(
    title="sticky-svc",
    lifespan=lifespan,
    docs_url=None if _prod else "/docs",
    redoc_url=None if _prod else "/redoc",
    openapi_url=None if _prod else "/openapi.json",
)

# Canonical-shape exception handlers (HTTPException, validation, Exception).
register_exception_handlers(app)

# slowapi: see auth-svc/app/main.py for design notes.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_handler)

# Middleware stack: see auth-svc/app/main.py for ordering notes.
app.add_middleware(SlowAPIMiddleware)
# Verifies the bearer token and caches the Principal on request.state, so
# SlowAPI (added above, therefore INNER, therefore running after this) can
# bucket by user instead of falling through to IP for every caller.
app.add_middleware(PrincipalMiddleware)
app.add_middleware(RequestIDMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(BodySizeLimitMiddleware)
# CORS allowlist: web origin (exact) + Electron desktop origins (file://, app://,
# and the literal `null` Chromium sends from a file:// document) in every env.
# Loopback origins are allowed ONLY outside production. Mirrors auth-svc.
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
    allow_credentials=True,  # browser sends the auth cookie cross-origin
    expose_headers=["X-Request-Id", "Retry-After"],
)

# Prometheus /metrics — HTTP RED metrics (request count, latency, in-progress).
# Unauthenticated scrape endpoint; not included in the OpenAPI schema.
# should_group_status_codes=False keeps the exact numeric status label (401/429/…)
# so security alerts can tell credential-stuffing (401) from rate-limit (429).
Instrumentator(should_group_status_codes=False).instrument(app).expose(app, include_in_schema=False)


@app.get("/healthz")
async def healthz() -> JSONResponse:
    # IMAGE_TAG is set by docker-compose.prod.yml from the deployed commit's
    # short SHA; defaults to "dev" when unset (e.g. a local run outside compose).
    return JSONResponse({"status": "ok", "version": os.environ.get("IMAGE_TAG", "dev")})


# Seconds to wait on the DB readiness check before declaring the dependency
# unreachable; short enough that the probe itself can't hang an orchestrator.
_READINESS_TIMEOUT_S = 3.0


@app.get("/readyz")
async def readyz() -> JSONResponse:
    """Readiness probe: verify the critical dependency (Postgres) is reachable.

    Returns 200 when a `SELECT 1` succeeds, or 503 (canonical error envelope via
    the HTTPException handler) when the DB is unreachable or the check times out.
    """
    try:
        engine = get_engine()
        async with engine.connect() as conn:
            await asyncio.wait_for(
                conn.execute(text("SELECT 1")), timeout=_READINESS_TIMEOUT_S
            )
    except Exception as exc:  # asyncio.TimeoutError, DB/driver errors, etc.
        log.warning("readiness_check_failed", error=str(exc))
        raise HTTPException(status_code=503, detail="database unavailable") from exc
    return JSONResponse({"status": "ready"})


app.include_router(router)
app.include_router(internal)
