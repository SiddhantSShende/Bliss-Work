"""Global FastAPI exception handlers for billing-svc — mirrors auth-svc/app/errors.py.

See that module's docstring for design notes. We duplicate (rather than share
across services) so each service stays independently deployable.
"""
from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .logging_setup import log


def _error_body(code: str, message: str, request_id: str, details: dict | None = None) -> dict:
    body: dict = {"error": {"code": code, "message": message, "requestId": request_id}}
    if details:
        body["error"]["details"] = details
    return body


def _request_id(request: Request) -> str:
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
    body = _error_body(
        "validation_error",
        "request validation failed",
        rid,
        # A validator that raises ValueError (every model-level rule: "scheduledFor
        # must be in the future", "deadlineAt must be ...") leaves the exception
        # itself in `ctx.error`, which json cannot serialize — without this the 422
        # for those rules was an unhandled TypeError and the client got a 500.
        {"fields": jsonable_encoder(exc.errors(), custom_encoder={Exception: str})},
    )
    response = JSONResponse(status_code=422, content=body)
    response.headers["X-Request-Id"] = rid
    return response


async def _unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    rid = _request_id(request)
    log.exception("unhandled_exception", path=request.url.path, request_id=rid)
    body = _error_body("internal_error", "internal server error", rid)
    response = JSONResponse(status_code=500, content=body)
    response.headers["X-Request-Id"] = rid
    return response


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(HTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.add_exception_handler(Exception, _unhandled_exception_handler)
