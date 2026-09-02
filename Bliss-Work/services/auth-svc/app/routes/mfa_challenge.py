"""The login-time second-factor check, and MFA-disable. See
docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7.

`enforce_origin` (CSRF) is applied ONLY to `/verify` here — it sets the
refresh cookie — not to `/disable`, matching the existing convention that
CSRF defence-in-depth belongs on cookie-setting endpoints, not on
bearer-only ones.

A wrong TOTP code / backup code counts against the SAME identity-level
lockout a wrong password does (`service.register_failed_login`, promoted in
Phase 5): a 6-digit code is a 1-in-a-million guess, and without a shared
lockout an attacker who has already stolen a password gets unlimited
attempts at the second factor, which defeats the point of having one.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import text

from .. import service
from ..db import engine
from ..logging_config import log
from ..net import request_context
from ..schemas import MfaChallengeRequest, MfaMethodsDTO, MfaStepUpRequest, SessionDTO
from ..security.auth_dep import Principal, get_principal
from ..security.origin import enforce_origin
from crypto import cryptor
from . import mfa_service, session_events
from .cookies import set_refresh_cookie
from .mfa_webauthn import verify_webauthn_assertion

router = APIRouter(prefix="/auth/mfa", tags=["mfa"])


async def _identity_for_user(conn, user_id: str):
    return (
        await conn.execute(
            text(
                "SELECT i.id, i.failed_login_count, i.locked_until FROM identities i "
                "JOIN users u ON u.identity_id = i.id WHERE u.id = :uid"
            ),
            {"uid": user_id},
        )
    ).first()


@router.post("/challenge/verify", response_model=SessionDTO, dependencies=[Depends(enforce_origin)])
async def verify_challenge(body: MfaChallengeRequest, request: Request, response: Response) -> SessionDTO:
    generic = HTTPException(status.HTTP_401_UNAUTHORIZED, "incorrect code")
    now = datetime.now(timezone.utc)
    session: SessionDTO | None = None
    raw_refresh: str | None = None
    failed = False
    locked_secs = 0
    ip, user_agent, request_id = request_context(request)

    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)  # pre-org-context, same as /auth/login
        resolved = await mfa_service.peek_mfa_pending(conn, body.pendingToken)
        if resolved is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or expired session")
        user_id, org_id = resolved
        await service.set_org_guc(conn, org_id)

        ident = await _identity_for_user(conn, user_id)
        if ident is None:
            raise generic
        if ident.locked_until is not None and ident.locked_until > now:
            retry = max(1, int((ident.locked_until - now).total_seconds()))
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "account temporarily locked due to failed attempts; try again later",
                headers={"Retry-After": str(retry)},
            )

        ok = False
        if body.totpCode:
            secret_enc = (
                await conn.execute(
                    text("SELECT mfa_totp_secret_enc FROM users WHERE id = :id"), {"id": user_id}
                )
            ).scalar()
            if secret_enc is not None:
                secret = await cryptor().decrypt(conn, org_id, secret_enc)
                ok = await mfa_service.verify_totp_replay_safe(conn, user_id, secret, body.totpCode)
        elif body.backupCode:
            ok = await mfa_service.verify_and_consume_backup_code(conn, user_id, body.backupCode)
        elif body.webauthnCredential:
            waid, _waorg = await verify_webauthn_assertion(conn, body.webauthnCredential)
            ok = waid == user_id  # the challenge itself is scoped to this pending session

        if not ok:
            locked_secs = await service.register_failed_login(conn, ident)
            await session_events.login_failed(
                conn, str(ident.id), ip=ip, user_agent=user_agent, request_id=request_id
            )
            failed = True
        else:
            if ident.failed_login_count or ident.locked_until is not None:
                await service.reset_identity_lockout(conn, str(ident.id))
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

    if failed:
        if locked_secs > 0:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "account temporarily locked due to failed attempts; try again later",
                headers={"Retry-After": str(locked_secs)},
            )
        raise generic

    assert session is not None and raw_refresh is not None
    set_refresh_cookie(response, raw_refresh)
    log.info("mfa_challenge_ok", user_id=session.user.id)
    return session


@router.get("/methods", response_model=MfaMethodsDTO)
async def mfa_methods(principal: Principal = Depends(get_principal)) -> MfaMethodsDTO:
    """Which second factors the CALLER has registered — lets Settings decide
    whether to offer a passkey as a step-up shortcut (see MfaMethodsDTO)."""
    async with engine.connect() as conn:
        await service.set_org_guc(conn, principal.org_id)
        methods = await mfa_service.enrolled_methods(conn, principal.user_id)
    return MfaMethodsDTO(methods=methods)


@router.post("/disable", status_code=status.HTTP_204_NO_CONTENT)
async def disable_mfa(
    body: MfaStepUpRequest,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> Response:
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

        await conn.execute(
            text(
                "UPDATE users SET mfa_totp_secret_enc = NULL, mfa_totp_last_counter = NULL, "
                "mfa_enrolled = false, mfa_enrolled_at = NULL WHERE id = :id"
            ),
            {"id": principal.user_id},
        )
        await conn.execute(
            text("DELETE FROM mfa_webauthn_credentials WHERE user_id = :uid"),
            {"uid": principal.user_id},
        )
        await conn.execute(
            text("DELETE FROM mfa_backup_codes WHERE user_id = :uid"), {"uid": principal.user_id}
        )

        ip, user_agent, request_id = request_context(request)
        await service.write_audit(
            conn,
            org_id=principal.org_id,
            actor_id=principal.user_id,
            action="mfa.disabled",
            target=principal.user_id,
            meta=session_events.context_meta(ip=ip, user_agent=user_agent, request_id=request_id),
        )
    log.warning("mfa_disabled", user_id=principal.user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
