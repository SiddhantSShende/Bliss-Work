from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from prometheus_fastapi_instrumentator import Instrumentator
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from sqlalchemy import text

from .config import settings
from .crypto import init_cryptor
from .db import dispose_engine, get_engine, init_engine, run_migrations
from .errors import register_exception_handlers
from .logging_setup import configure_logging, log
from .middleware import BodySizeLimitMiddleware, RequestIDMiddleware, SecurityHeadersMiddleware
from .outbox import poller
from .rate_limit import limiter, rate_limit_handler
from .refresh_worker import worker as refresh_worker
from .routes import router
from .routes.internal import router as internal_router
from .routes.oauth import router as oauth_router
from .routes.webhooks import router as webhooks_router
from .tracing import setup_tracing

configure_logging(settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_engine()
    setup_tracing(app)
    await run_migrations()
    # Build the at-rest column-encryption Cryptor (per-org DEK envelope) after the
    # org_keys migration exists. Fails fast if the KEK secrets are misconfigured.
    init_cryptor(settings)
    # Transactional-outbox publisher for integration.activity.created (live hub).
    await poller.start()
    # Refresh OAuth access tokens (Gmail/Microsoft) before they expire.
    await refresh_worker.start()
    log.info("integrations_svc_started", port=settings.port)
    try:
        yield
    finally:
        await refresh_worker.stop()
        await poller.stop()
        await dispose_engine()
        log.info("integrations_svc_stopped")


_prod = settings.tb_env.strip().lower() in {"production", "prod"}
# Defense-in-depth: no interactive docs / OpenAPI schema in prod (mirrors task-svc).
app = FastAPI(
    title="integrations-svc",
    lifespan=lifespan,
    docs_url=None if _prod else "/docs",
    redoc_url=None if _prod else "/redoc",
    openapi_url=None if _prod else "/openapi.json",
)

register_exception_handlers(app)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_handler)

app.add_middleware(SlowAPIMiddleware)
app.add_middleware(RequestIDMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(BodySizeLimitMiddleware)
# CORS allowlist: web origin (exact) + Electron desktop origins in every env;
# loopback only outside production. Mirrors task-svc. NOTE: the public webhook /
# OAuth-callback routes (added with the provider layer) are server-to-server and
# must NOT be added to this credentialed CORS group.
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
    return JSONResponse({"status": "ok"})


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


app.include_router(router)
# Private service-to-service endpoints (shared-secret; edge-blocked by the WAF).
app.include_router(internal_router, prefix="/internal")
# Public inbound webhooks (provider-signature authenticated; NOT under /internal/).
app.include_router(webhooks_router, prefix="/ext")
# Public OAuth authorization-code callbacks (state/PKCE authenticated).
app.include_router(oauth_router, prefix="/ext")
