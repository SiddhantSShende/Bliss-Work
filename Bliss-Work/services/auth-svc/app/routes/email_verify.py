"""Email-verification endpoints.

`/verify/peek` is a read-only validity probe (does not consume — powers the
landing page's "Confirm your email" gate, see
docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 4). `/verify` is public and
CONSUMES the token (the token in the emailed link is the credential, but only
once the user explicitly confirms — a link-preview bot hitting `/verify/peek`
can no longer burn it). `/resend` is authenticated (re-issues a link for the
caller's own email). All three are generic/idempotent so they don't leak
account state.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, Response, status

from .. import service
from ..db import engine
from ..logging_config import log
from ..net import request_context
from ..schemas import MessageResponse, TokenVerifyResponse, VerifyEmailRequest
from ..security.auth_dep import Principal, get_principal
from ..security.origin import enforce_origin
from . import session_events
from .account_service import (
    PURPOSE_VERIFY,
    create_email_verification_tx,
    peek_token_valid,
    verify_email_tx,
)

router = APIRouter(prefix="/auth/email", tags=["email"])


@router.get("/verify/peek", response_model=TokenVerifyResponse)
async def peek_email_verification(token: str = Query(..., max_length=512)) -> TokenVerifyResponse:
    async with engine.connect() as conn:
        valid = await peek_token_valid(conn, PURPOSE_VERIFY, token)
    return TokenVerifyResponse(valid=valid)


@router.post(
    "/verify",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(enforce_origin)],
)
async def verify_email(body: VerifyEmailRequest, response: Response, request: Request) -> Response:
    async with engine.begin() as conn:
        await verify_email_tx(conn, body.token, request)
    log.info("email_verified")
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.post(
    "/resend",
    response_model=MessageResponse,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(enforce_origin)],
)
async def resend_verification(
    request: Request,
    principal: Principal = Depends(get_principal),
) -> MessageResponse:
    async with engine.begin() as conn:
        # Scope to the caller's org: user_dto decrypts the email and the token
        # insert's WITH CHECK requires org_id = app.org_id.
        await service.set_org_guc(conn, principal.org_id)
        dto = await service.user_dto(conn, principal.user_id)
        if dto is not None and not dto.emailVerified:
            await create_email_verification_tx(
                conn, principal.user_id, principal.org_id, dto.email
            )
            # Unlike the shared helper's other caller (signup), this IS a
            # security-relevant re-issue of a live credential-bearing link, so
            # it gets its own audit row here rather than inside
            # create_email_verification_tx — that helper also backs the
            # original send at signup, which is not a "resend".
            ip, user_agent, request_id = request_context(request)
            await service.write_audit(
                conn,
                org_id=principal.org_id,
                actor_id=principal.user_id,
                action="email.verification_resent",
                target=principal.user_id,
                meta=session_events.context_meta(
                    ip=ip, user_agent=user_agent, request_id=request_id
                ),
            )
    return MessageResponse(
        message="If your email is unverified, a new verification link has been sent."
    )
