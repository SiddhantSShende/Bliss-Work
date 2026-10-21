from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from .config import settings
from .db import dispose_engine, get_engine, init_engine, run_migrations
from .errors import register_exception_handlers
from .logging_setup import configure_logging, log
from .middleware import BodySizeLimitMiddleware, RequestIDMiddleware
from .outbox_poller import poller as outbox_poller
from .routes import internal_router, router

configure_logging(settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_engine()
    await run_migrations()
    # Outbox -> Kafka. The ONLY path that emits billing.events.v1 (see
    # app/outbox_poller.py); writes to `outbox` happen in the same
    # transaction as the billing state change that caused them.
    await outbox_poller.start()
    log.info("billing_svc_started", port=settings.port)
    try:
        yield
    finally:
        await outbox_poller.stop()
        await dispose_engine()
        log.info("billing_svc_stopped")


_prod = settings.tb_env.strip().lower() in {"production", "prod"}
app = FastAPI(
    title="billing-svc",
    lifespan=lifespan,
    docs_url=None if _prod else "/docs",
    redoc_url=None if _prod else "/redoc",
    openapi_url=None if _prod else "/openapi.json",
)

register_exception_handlers(app)
app.add_middleware(RequestIDMiddleware)
app.add_middleware(BodySizeLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)
app.include_router(internal_router)


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/readyz")
async def readyz():
    engine = get_engine()
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    return {"status": "ready"}
