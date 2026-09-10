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
from crypto import init_cryptor
from .db import dispose_engine, get_engine, init_engine, run_migrations
from .errors import register_exception_handlers
from .logging_setup import configure_logging, log
from .middleware import BodySizeLimitMiddleware, PrincipalMiddleware, RequestIDMiddleware, SecurityHeadersMiddleware
from .rate_limit import limiter, rate_limit_handler
from .routes.analytics import router as analytics_router
from .routes.ingest import router as ingest_router
from .routes.timeline import router as timeline_router
from .sessions import sweeper
from .tracing import setup_tracing
from tracing import shutdown_tracing

configure_logging(settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_engine()
    setup_tracing(app)
    await run_migrations()
    # Build the at-rest Cryptor AFTER the migration that creates org_keys.
    init_cryptor(settings)
    # Server-observed activity: domain events → activity rows.
    await consumer.start()
    # Closes sessions nobody said goodbye for (killed tab, closed laptop lid).
    await sweeper.start()
    log.info("telemetry_svc_started", port=settings.port)
    try:
        yield
    finally:
        await sweeper.stop()
        await consumer.stop()
        await dispose_engine()
        shutdown_tracing(log=log)  # flush any buffered spans (no-op when disabled)
        log.info("telemetry_svc_stopped")


_prod = settings.tb_env.strip().lower() in {"production", "prod"}
app = FastAPI(
    title="telemetry-svc",
    lifespan=lifespan,
    docs_url=None if _prod else "/docs",
    redoc_url=None if _prod else "/redoc",
    openapi_url=None if _prod else "/openapi.json",
)

register_exception_handlers(app)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_handler)

app.add_middleware(SlowAPIMiddleware)
# Verifies the bearer token and caches the Principal on request.state, so
# SlowAPI (added above, therefore INNER, therefore running after this) can
# bucket by user instead of falling through to IP for every caller.
app.add_middleware(PrincipalMiddleware)
# Registered (therefore wrapped) BEFORE RequestIDMiddleware and
# SecurityHeadersMiddleware: Starlette's add_middleware makes the LAST
# registration the OUTERMOST layer, so those two must be added after this one
# to stay outside it. BodySizeLimitMiddleware.dispatch() returns its 413
# directly without calling call_next(), so anything registered before it
# (SlowAPI, Principal — unchanged, still skipped for an oversized body) never
# runs; anything registered after it still wraps the short-circuited response
# and gets to stamp X-Request-Id / the security headers on it.
app.add_middleware(BodySizeLimitMiddleware)
app.add_middleware(RequestIDMiddleware)
app.add_middleware(SecurityHeadersMiddleware)

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
    allow_credentials=True,
    expose_headers=["X-Request-Id", "Retry-After"],
)

Instrumentator(should_group_status_codes=False).instrument(app).expose(app, include_in_schema=False)


@app.get("/healthz")
async def healthz() -> JSONResponse:
    # IMAGE_TAG is set by docker-compose.prod.yml from the deployed commit's
    # short SHA; defaults to "dev" when unset (e.g. a local run outside compose).
    return JSONResponse({"status": "ok", "version": os.environ.get("IMAGE_TAG", "dev")})


_READINESS_TIMEOUT_S = 3.0


@app.get("/readyz")
async def readyz() -> JSONResponse:
    try:
        engine = get_engine()
        async with engine.connect() as conn:
            await asyncio.wait_for(conn.execute(text("SELECT 1")), timeout=_READINESS_TIMEOUT_S)
    except Exception as exc:
        log.warning("readiness_check_failed", error=str(exc))
        raise HTTPException(status_code=503, detail="database unavailable") from exc
    return JSONResponse({"status": "ready"})


app.include_router(ingest_router)
app.include_router(timeline_router)
app.include_router(analytics_router)
