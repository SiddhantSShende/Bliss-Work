"""Public JWKS + health endpoints (no auth)."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from ..db import engine
from ..logging_config import log
from ..security.keys import jwks

router = APIRouter(tags=["public"])

# Bound the readiness DB check so the probe itself can't hang behind a wedged
# connection / pool exhaustion; the orchestrator gets a fast 503 instead.
_READYZ_DB_TIMEOUT_S = 3.0


@router.get("/.well-known/jwks.json")
async def jwks_endpoint() -> dict:
    return jwks()


@router.get("/healthz")
async def healthz() -> dict:
    # Cheap liveness probe: process is up and serving. Does NOT touch the DB —
    # see /readyz for the dependency (readiness) check.
    return {"status": "ok"}


@router.get("/readyz")
async def readyz() -> JSONResponse:
    """Readiness probe: trivial DB round-trip so traffic is only routed here once
    the critical dependency (Postgres) is reachable. Returns 503 on failure so a
    rolling deploy / DB blip drains this replica instead of serving 500s."""
    try:
        async with asyncio.timeout(_READYZ_DB_TIMEOUT_S):
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
    except Exception as exc:
        # Don't leak DB internals to the client; full detail goes to the logs.
        log.warning("readyz_db_unreachable", error=str(exc))
        return JSONResponse(status_code=503, content={"status": "not ready"})
    return JSONResponse(status_code=200, content={"status": "ready"})
