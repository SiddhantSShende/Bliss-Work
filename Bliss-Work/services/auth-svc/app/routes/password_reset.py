"""Forgot-password / reset endpoints (public, unauthenticated).

Security posture: single-use short-TTL tokens (see account_service), generic
non-enumerable responses, an Origin/Referer CSRF guard on the state-changing
POSTs, and revoke-all-sessions on a successful reset. Rate limits for these
paths live in rate_limit._SENSITIVE_LIMITS.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Response, status

from ..db import engine
from ..logging_config import log
from ..schemas import (
    ForgotPasswordRequest,
    MessageResponse,
    ResetPasswordRequest,
    TokenVerifyResponse,
)
from ..security.origin import enforce_origin
from .account_service import (
    PURPOSE_RESET,
    create_password_reset_tx,
    peek_token_valid,
    reset_password_tx,
)

router = APIRouter(prefix="/auth/password", tags=["password"])

_GENERIC = "If an account exists for that email, a password reset link has been sent."


@router.post(
    "/forgot",
    response_model=MessageResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(enforce_origin)],
)
async def forgot_password(body: ForgotPasswordRequest) -> MessageResponse:
    async with engine.begin() as conn:
        await create_password_reset_tx(conn, str(body.email))
    # Always the same response + status, whether or not the email matched.
    log.info("password_reset_requested")
    return MessageResponse(message=_GENERIC)


@router.get("/reset/verify", response_model=TokenVerifyResponse)
async def verify_reset_token(token: str = Query(..., max_length=512)) -> TokenVerifyResponse:
    async with engine.connect() as conn:
        valid = await peek_token_valid(conn, PURPOSE_RESET, token)
    return TokenVerifyResponse(valid=valid)


@router.post(
    "/reset",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(enforce_origin)],
)
async def reset_password(body: ResetPasswordRequest, response: Response) -> Response:
    async with engine.begin() as conn:
        await reset_password_tx(conn, body.token, body.password)
    log.info("password_reset_completed")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
