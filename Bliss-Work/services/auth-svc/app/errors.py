"""Global FastAPI exception handlers.

Every error path through auth-svc emits the canonical JSON envelope:

    { "error": { "code": "...", "message": "...", "requestId": "...", "details": {...} } }

Without these handlers, an unhandled exception or validation error would emit
FastAPI's default shape (just `{"detail": "..."}`), which the frontend would
then have to special-case. By translating everything to the canonical shape
here, the frontend's ApiError.fromResponse parser handles all errors uniformly.

Security note: the body never includes a stack trace or internal error message
to the client. Full tracebacks go to structlog (where structured logs include
the request_id stamped by RequestIDMiddleware).
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DataError

from .logging_config import log


def _error_body(code: str, message: str, request_id: str, details: dict | None = None) -> dict:
    body: dict = {"error": {"code": code, "message": message, "requestId": request_id}}
    if details:
        body["error"]["details"] = details
    return body


def _request_id(request: Request) -> str:
    # RequestIDMiddleware stamps request.state.request_id, which is the
    # canonical place to read from (the inbound header may be empty if the
    # client didn't forward one; we always have a minted id in state).
    rid = getattr(request.state, "request_id", "") if hasattr(request, "state") else ""
    return rid or request.headers.get("x-request-id") or ""


def _code_for_status(status: int) -> str:
    return {
        400: "bad_request",
        401: "unauthorized",
        403: "forbidden",
        404: "not_found",
        409: "conflict",
        422: "validation_error",
        429: "rate_limited",
        500: "internal_error",
        502: "service_unavailable",
        503: "service_unavailable",
        504: "gateway_timeout",
    }.get(status, "internal_error" if status >= 500 else "bad_request")


async def _http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    rid = _request_id(request)
    msg = exc.detail if isinstance(exc.detail, str) else "request failed"
    details = None
    if not isinstance(exc.detail, str) and exc.detail is not None:
        # FastAPI sometimes carries dict detail (e.g. validation breakdowns).
        details = {"detail": exc.detail}
    body = _error_body(_code_for_status(exc.status_code), msg, rid, details)
    response = JSONResponse(status_code=exc.status_code, content=body)
    response.headers["X-Request-Id"] = rid
    if exc.headers:
        for k, v in exc.headers.items():
            response.headers[k] = v
    return response


async def _validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    rid = _request_id(request)
    # exc.errors() is a list of dicts with loc/msg/type — that's what the
    # frontend can render field-level inline errors from. Each dict also
    # carries an "input" key holding the raw submitted value verbatim, which
    # would otherwise echo a too-short/too-long password (or any other
    # sensitive field) straight back into the response body. No consumer
    # reads "input", so it's dropped for every field rather than echoed.
    fields = [{k: v for k, v in error.items() if k != "input"} for error in exc.errors()]
    body = _error_body(
        "validation_error",
        "request validation failed",
        rid,
        {"fields": fields},
    )
    response = JSONResponse(status_code=422, content=body)
    response.headers["X-Request-Id"] = rid
    return response


async def _data_error_handler(request: Request, exc: DataError) -> JSONResponse:
    """A malformed value reached Postgres as a bind parameter — most often a
    non-UUID path parameter hitting a `uuid`-typed column (asyncpg raises
    InvalidTextRepresentationError, SQLSTATE 22P02, which SQLAlchemy
    classifies as DataError; the same happens for e.g. an out-of-range
    numeric). Several routes take a raw `str` path param and pass it straight
    through to a query with no upfront validation, so a typo'd or scanned id
    used to fall through to `_unhandled_exception_handler` as a logged 500.
    `DataError` is specifically SQLAlchemy's "the driver rejected this DATA",
    distinct from `IntegrityError`/`OperationalError`/etc., so this can never
    mask a genuine server-side failure as a client error.
    """
    rid = _request_id(request)
    log.warning("malformed_value_reached_db", path=request.url.path, request_id=rid)
    body = _error_body("bad_request", "invalid request", rid)
    response = JSONResponse(status_code=400, content=body)
    response.headers["X-Request-Id"] = rid
    return response


async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    rid = _request_id(request)
    # Full traceback to logs only — never to the client.
    log.exception("unhandled_exception", path=request.url.path, request_id=rid)
    body = _error_body("internal_error", "internal server error", rid)
    response = JSONResponse(status_code=500, content=body)
    response.headers["X-Request-Id"] = rid
    return response


def register_exception_handlers(app: FastAPI) -> None:
    """Wire the canonical handlers on the FastAPI app."""
    app.add_exception_handler(HTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(DataError, _data_error_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
