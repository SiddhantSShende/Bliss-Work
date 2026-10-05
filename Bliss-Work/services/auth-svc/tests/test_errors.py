"""register_exception_handlers: the canonical error envelope, and the
DataError -> 400 mapping specifically.

Several routes (members.py's role/deactivate/reactivate/remove, sessions.py's
DELETE /auth/sessions/{id}, invites.py's DELETE /auth/invites/{id}, and a few
internal.py routes) take a raw `str` path parameter and pass it straight
through to a query against a `uuid`-typed column with no upfront validation.
A non-UUID value there used to fall through to `_unhandled_exception_handler`
as a logged 500 (see docs' audit finding A1-09) — asyncpg raises
InvalidTextRepresentationError for the malformed literal, which SQLAlchemy
classifies as `sqlalchemy.exc.DataError`, distinct from IntegrityError /
OperationalError / etc., so mapping it globally can't mask a genuine
server-side failure as a client error.

No database needed: this is entirely about which handler FastAPI's exception
middleware dispatches to for a given exception TYPE, so a synthetic app with
throwaway routes that raise each type is enough — and faster/more precise
than provoking the real error out of a live route via a real query.
"""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.exc import DataError, IntegrityError

from app.errors import register_exception_handlers


def _make_app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/boom/data-error")
    async def _data_error():
        raise DataError(
            "SELECT * FROM users WHERE id = :id",
            {"id": "not-a-uuid"},
            Exception('invalid input syntax for type uuid: "not-a-uuid"'),
        )

    @app.get("/boom/integrity-error")
    async def _integrity_error():
        # A REAL constraint violation must still be a 500 — DataError is
        # specifically "the driver rejected this data", not every DBAPIError.
        raise IntegrityError("INSERT ...", {}, Exception("duplicate key value"))

    @app.get("/boom/generic")
    async def _generic():
        raise RuntimeError("something else entirely")

    return app


@pytest.fixture
def client():
    app = _make_app()
    # raise_app_exceptions=False: every route here deliberately raises, and by
    # default ASGITransport re-raises an exception into the TEST even once a
    # registered handler has already turned it into a response (Starlette's
    # ServerErrorMiddleware does both, so a TestClient/pytest run still shows
    # the traceback) — this test is about the RESPONSE the handler produces,
    # not about surfacing the traceback.
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def test_data_error_becomes_a_400_not_a_500(client):
    async with client as c:
        r = await c.get("/boom/data-error")
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["error"]["code"] == "bad_request"
    # Never the DB-API text (statement, params, or the driver's own message) —
    # that's an internal detail, not something to hand back to the caller.
    assert "not-a-uuid" not in r.text
    assert "SELECT" not in r.text


async def test_data_error_response_still_uses_the_canonical_envelope(client):
    async with client as c:
        r = await c.get("/boom/data-error")
    body = r.json()
    assert set(body.keys()) == {"error"}
    assert set(body["error"].keys()) >= {"code", "message", "requestId"}
    assert r.headers["x-request-id"] == body["error"]["requestId"]


async def test_a_real_constraint_violation_is_still_a_500(client):
    """Guards against over-broadening: only DataError gets the 400 treatment.
    IntegrityError (and everything else DBAPIError covers) is a genuine
    server-side fault and must stay a 500, exactly as before this change."""
    async with client as c:
        r = await c.get("/boom/integrity-error")
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal_error"


async def test_an_ordinary_unhandled_exception_is_unaffected(client):
    async with client as c:
        r = await c.get("/boom/generic")
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal_error"
