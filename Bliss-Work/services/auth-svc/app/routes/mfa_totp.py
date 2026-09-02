"""TOTP (RFC 6238) enrollment: enroll-start, enroll-confirm, and backup-code
regeneration. See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7.

Deliberately reachable two ways, resolved by mfa_service.resolve_actor_for_enrollment:
an ordinary Bearer-authed caller adding a factor from Settings, or an admin
blocked at the password step post-grace-period presenting only the restricted
"MFA pending" credential (valid while mfa_enrolled is still false).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy import text

from .. import service
from ..db import engine
from ..logging_config import log
from ..net import request_context
from ..schemas import (
    BackupCodesRegenerateResponse,
    MfaStepUpRequest,
    SessionDTO,
    TotpEnrollConfirmRequest,
    TotpEnrollConfirmResponse,
    TotpEnrollStartRequest,
    TotpEnrollStartResponse,
)
from ..security.auth_dep import Principal, get_principal
from crypto import cryptor
from . import mfa_service, session_events
from .cookies import set_refresh_cookie

router = APIRouter(prefix="/auth/mfa/totp", tags=["mfa"])


@router.post("/enroll/start", response_model=TotpEnrollStartResponse)
async def enroll_start(
    body: TotpEnrollStartRequest,
    authorization: str | None = Header(default=None),
) -> TotpEnrollStartResponse:
    """Generate a TOTP secret + otpauth:// URI. Deliberately NOT persisted here
    — nothing about MFA state changes until enroll/confirm succeeds, so an
    abandoned enrollment attempt leaves no trace."""
    async with engine.connect() as conn:
        user_id, _org_id = await mfa_service.resolve_actor_for_enrollment(
            conn, authorization=authorization, pending_token=body.pendingToken
        )
        dto = await service.user_dto(conn, user_id)
    if dto is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
    secret = mfa_service.generate_totp_secret()
    otpauth_url = mfa_service.totp_otpauth_url(secret, account_name=dto.email or dto.username)
    return TotpEnrollStartResponse(secret=secret, otpauthUrl=otpauth_url)


@router.post("/enroll/confirm", response_model=TotpEnrollConfirmResponse)
async def enroll_confirm(
    body: TotpEnrollConfirmRequest,
    request: Request,
    response: Response,
    authorization: str | None = Header(default=None),
) -> TotpEnrollConfirmResponse:
    """Verify `code` against the client-held `secret`, and only NOW persist it
    (encrypted) + flip mfa_enrolled + mint backup codes — all in one
    transaction. Reached via the restricted enrollment credential, success
    also consumes the pending token and mints the real session directly,
    rather than forcing a second round trip through challenge-verify."""
    session: SessionDTO | None = None
    raw_refresh: str | None = None
    async with engine.begin() as conn:
        user_id, org_id = await mfa_service.resolve_actor_for_enrollment(
            conn, authorization=authorization, pending_token=body.pendingToken
        )
        if not await mfa_service.verify_totp_replay_safe(conn, user_id, body.secret, body.code):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "incorrect code")

        secret_enc = await cryptor().encrypt(conn, org_id, body.secret)
        await conn.execute(
            text(
                "UPDATE users SET mfa_totp_secret_enc = :s, mfa_enrolled = true, "
                "mfa_enrolled_at = now() WHERE id = :id"
            ),
            {"s": secret_enc, "id": user_id},
        )
        codes = mfa_service.generate_backup_codes()
        await mfa_service.store_backup_codes(conn, org_id, user_id, codes)

        ip, user_agent, request_id = request_context(request)
        await service.write_audit(
            conn,
            org_id=org_id,
            actor_id=user_id,
            action="mfa.totp_enrolled",
            target=user_id,
            meta=session_events.context_meta(ip=ip, user_agent=user_agent, request_id=request_id),
        )

        if body.pendingToken:
            # Reached via the restricted enrollment credential: consume it now
            # (it has done its job) and mint the real session directly.
            await mfa_service.consume_mfa_pending(conn, body.pendingToken)
            session, raw_refresh, family_id = await service.build_session(conn, user_id)
            await session_events.session_started(
                conn,
                session.user.orgId,
                user_id,
                session_id=family_id,
                ip=ip,
                user_agent=user_agent,
                request_id=request_id,
            )
        log.info("mfa_totp_enrolled", user_id=user_id, via_pending_token=bool(body.pendingToken))

    if raw_refresh is not None:
        set_refresh_cookie(response, raw_refresh)
    return TotpEnrollConfirmResponse(backupCodes=codes, session=session)


@router.post("/backup-codes/regenerate", response_model=BackupCodesRegenerateResponse)
async def regenerate_backup_codes(
    body: MfaStepUpRequest,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> BackupCodesRegenerateResponse:
    """Step-up re-auth (password + a still-valid current second factor), same
    as MFA-disable. Invalidates every existing unused code BEFORE inserting
    the new batch — otherwise old codes stay valid indefinitely alongside the
    new ones."""
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        ok = await mfa_service.verify_step_up(
            conn,
            principal.org_id,
            principal.user_id,
            body.password,
            body.totpCode,
            body.backupCode,
            body.webauthnCredential,
        )
        if not ok:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "re-authentication failed")

        await mfa_service.invalidate_backup_codes(conn, principal.user_id)
        codes = mfa_service.generate_backup_codes()
        await mfa_service.store_backup_codes(conn, principal.org_id, principal.user_id, codes)

        ip, user_agent, request_id = request_context(request)
        await service.write_audit(
            conn,
            org_id=principal.org_id,
            actor_id=principal.user_id,
            action="mfa.backup_codes_regenerated",
            target=principal.user_id,
            meta=session_events.context_meta(ip=ip, user_agent=user_agent, request_id=request_id),
        )
    log.info("mfa_backup_codes_regenerated", user_id=principal.user_id)
    return BackupCodesRegenerateResponse(backupCodes=codes)
