"""Forgot-password / reset endpoints (public, unauthenticated).

Security posture: single-use short-TTL tokens (see account_service), generic
non-enumerable responses, an Origin/Referer CSRF guard on the state-changing
POSTs, and revoke-all-sessions on a successful reset. Rate limits for these
paths live in rate_limit._SENSITIVE_LIMITS.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, Response, status

from ..db import engine
from ..logging_config import log
from ..schemas import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    MessageResponse,
    ResetPasswordRequest,
    TokenVerifyResponse,
)
from ..security.auth_dep import Principal, get_principal
from ..security.origin import enforce_origin
from .account_service import (
    PURPOSE_RESET,
    change_password_tx,
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
async def forgot_password(body: ForgotPasswordRequest, request: Request) -> MessageResponse:
    async with engine.begin() as conn:
        await create_password_reset_tx(conn, str(body.email), request)
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
async def reset_password(
    body: ResetPasswordRequest, response: Response, request: Request
) -> Response:
    async with engine.begin() as conn:
        await reset_password_tx(conn, body.token, body.password, request)
    log.info("password_reset_completed")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post(
    "/change",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(enforce_origin)],
)
async def change_password(
    body: ChangePasswordRequest,
    response: Response,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> Response:
    """Authenticated self-service password change — current password only,
    no second factor (see change_password_tx's docstring)."""
    await change_password_tx(
        principal.user_id, principal.org_id, body.currentPassword, body.newPassword, request
    )
    log.info("password_changed", user_id=principal.user_id)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response
