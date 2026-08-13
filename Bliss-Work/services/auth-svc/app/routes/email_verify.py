"""Email-verification endpoints.

`/verify` is public (the token in the emailed link is the credential); `/resend`
is authenticated (re-issues a link for the caller's own email). Both are
generic/idempotent so they don't leak account state.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status

from .. import service
from ..db import engine
from ..logging_config import log
from ..schemas import MessageResponse, VerifyEmailRequest
from ..security.auth_dep import Principal, get_principal
from ..security.origin import enforce_origin
from .account_service import create_email_verification_tx, verify_email_tx

router = APIRouter(prefix="/auth/email", tags=["email"])


@router.post(
    "/verify",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(enforce_origin)],
)
async def verify_email(body: VerifyEmailRequest, response: Response) -> Response:
    async with engine.begin() as conn:
        await verify_email_tx(conn, body.token)
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
    return MessageResponse(
        message="If your email is unverified, a new verification link has been sent."
    )
