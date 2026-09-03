"""WebAuthn (passkeys/security keys) enrollment + the login-time assertion
check. See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7.

Exposes four ROUTES — register/start, register/finish, auth/start,
step-up/start — plus one plain function, `verify_webauthn_assertion`, that
mfa_challenge.py's single login-time verify endpoint (and mfa_service's
step-up re-auth) call when the caller presents a WebAuthn assertion rather
than a TOTP code or backup code. There is no separate "auth/finish" or
"step-up/finish" ROUTE: that verification is exactly what mfa_challenge.py's
verify endpoint, and mfa_service.verify_step_up, already do for all
second-factor kinds, and duplicating it here would just be a second place
sessions/step-ups get minted from.

── Acceptance criteria for every assertion this module verifies ─────────────
(the checklist from the plan, and where each one is actually enforced)

  * challenge is fresh, single-use, and one THIS server issued — enforced by
    `mfa_service.consume_webauthn_challenge` (the user_tokens single-use +
    expiry machinery), not by anything WebAuthn-specific.
  * origin matches the configured RP origin exactly — `expected_origin`.
  * RP ID matches — `expected_rp_id`.
  * credential ID resolves to a stored row for THIS user — the credential
    lookup is scoped by `user_id`, not merely "does this credential exist
    anywhere" (see `verify_webauthn_assertion`).
  * signature verifies against that row's stored public key —
    `credential_public_key`.
  * user-presence is set, user-verification is set when required — `webauthn`
    raises internally on a missing UP flag; `require_user_verification` is
    True only when the CALLER'S org has `require_mfa_for_admins` on (the one
    place this platform expresses "this org wants a stronger bar" — there is
    no separate per-authenticator UV policy to read instead).
  * sign_count is strictly greater than the stored value, EXCEPT when both
    the stored value and the assertion's are 0 — this exemption is not
    something we implement: the `webauthn` library's own
    `verify_authentication_response` already skips the monotonic check in
    exactly that case (confirmed by reading its source), which exists because
    several platform authenticators (Touch ID/Face ID, notably) never
    implement a signature counter and permanently report 0. Passing the
    stored `sign_count` straight through is sufficient; no extra logic here
    would do anything but duplicate the library's.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from sqlalchemy import text
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, options_to_json_dict, parse_client_data_json
from webauthn.helpers.exceptions import WebAuthnException
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    UserVerificationRequirement,
)

from .. import service
from ..config import settings
from ..db import engine
from ..logging_config import log
from ..net import request_context
from ..schemas import (
    SessionDTO,
    WebauthnAuthStartRequest,
    WebauthnRegisterFinishRequest,
    WebauthnRegisterFinishResponse,
    WebauthnRegisterStartRequest,
)
from ..security.auth_dep import Principal, get_principal
from . import mfa_service, session_events
from .cookies import set_refresh_cookie

router = APIRouter(prefix="/auth/mfa/webauthn", tags=["mfa"])


async def _org_requires_uv(conn, org_id: str) -> bool:
    val = (
        await conn.execute(
            text("SELECT require_mfa_for_admins FROM orgs WHERE id = :id"), {"id": org_id}
        )
    ).scalar()
    return bool(val)


async def _credential_ids_for_user(conn, user_id: str) -> list[bytes]:
    rows = (
        await conn.execute(
            text("SELECT credential_id FROM mfa_webauthn_credentials WHERE user_id = :uid"),
            {"uid": user_id},
        )
    ).all()
    return [bytes(r.credential_id) for r in rows]


def _client_data_challenge(client_data_json: bytes) -> bytes:
    return parse_client_data_json(client_data_json).challenge


@router.post("/register/start")
async def register_start(
    body: WebauthnRegisterStartRequest,
    authorization: str | None = Header(default=None),
) -> dict:
    async with engine.connect() as conn:
        user_id, org_id = await mfa_service.resolve_actor_for_enrollment(
            conn, authorization=authorization, pending_token=body.pendingToken
        )
        dto = await service.user_dto(conn, user_id)
        if dto is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
        exclude_ids = await _credential_ids_for_user(conn, user_id)
        uv_required = await _org_requires_uv(conn, org_id)
        challenge = await mfa_service.mint_webauthn_challenge(conn, org_id, user_id)

    options = generate_registration_options(
        rp_id=settings.webauthn_rp_id,
        rp_name=settings.webauthn_rp_name,
        user_name=dto.username,
        user_id=user_id.encode("utf-8"),
        user_display_name=dto.displayName or dto.username,
        challenge=challenge,
        exclude_credentials=[PublicKeyCredentialDescriptor(id=cid) for cid in exclude_ids],
        authenticator_selection=AuthenticatorSelectionCriteria(
            user_verification=(
                UserVerificationRequirement.REQUIRED
                if uv_required
                else UserVerificationRequirement.PREFERRED
            )
        ),
    )
    return options_to_json_dict(options)


@router.post("/register/finish", response_model=WebauthnRegisterFinishResponse)
async def register_finish(
    body: WebauthnRegisterFinishRequest,
    request: Request,
    response: Response,
) -> WebauthnRegisterFinishResponse:
    """Identity for this call comes from the CHALLENGE, not a fresh Bearer/
    pendingToken check — the challenge was already minted for a specific
    (user_id, org_id) at register/start, and only that user's authenticator
    can produce a valid signature over it. `pendingToken` here is a pure
    signal ("also mint a session on success"), not a second auth check."""
    session: SessionDTO | None = None
    raw_refresh: str | None = None
    async with engine.begin() as conn:
        try:
            client_data_json = bytes(
                _b64(body.credential["response"]["clientDataJSON"])
            )
        except (KeyError, TypeError) as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "malformed credential") from exc
        challenge = _client_data_challenge(client_data_json)
        user_id, org_id = await mfa_service.consume_webauthn_challenge(conn, challenge)
        uv_required = await _org_requires_uv(conn, org_id)

        if await mfa_service.is_already_enrolled(conn, user_id):
            # Adding another credential to an ALREADY-enrolled account is as
            # consequential as MFA-disable (it plants a durable extra
            # passkey an attacker holding only a stolen Bearer token could
            # not otherwise obtain) — gate it behind the same step-up
            # re-auth disable/regenerate already require.
            step_up = body.stepUp
            ok = step_up is not None and await mfa_service.verify_step_up(
                conn, org_id, user_id,
                step_up.password, step_up.totpCode, step_up.backupCode, step_up.webauthnCredential,
            )
            if not ok:
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "re-authentication failed")

        try:
            verified = verify_registration_response(
                credential=body.credential,
                expected_challenge=challenge,
                expected_rp_id=settings.webauthn_rp_id,
                expected_origin=settings.web_origin,
                require_user_verification=uv_required,
            )
        except WebAuthnException as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "could not verify credential") from exc

        cred_id = service.new_uuid()
        await conn.execute(
            text(
                """
                INSERT INTO mfa_webauthn_credentials
                    (id, user_id, org_id, credential_id, public_key, sign_count, nickname)
                VALUES (:id, :uid, :org, :cid, :pk, :sc, :nick)
                """
            ),
            {
                "id": cred_id,
                "uid": user_id,
                "org": org_id,
                "cid": verified.credential_id,
                "pk": verified.credential_public_key,
                "sc": verified.sign_count,
                "nick": body.nickname,
            },
        )
        await conn.execute(
            text(
                "UPDATE users SET mfa_enrolled = true, "
                "mfa_enrolled_at = COALESCE(mfa_enrolled_at, now()) WHERE id = :id"
            ),
            {"id": user_id},
        )

        ip, user_agent, request_id = request_context(request)
        await service.write_audit(
            conn,
            org_id=org_id,
            actor_id=user_id,
            action="mfa.webauthn_enrolled",
            target=user_id,
            meta=session_events.context_meta(ip=ip, user_agent=user_agent, request_id=request_id),
        )

        if body.pendingToken:
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
        log.info("mfa_webauthn_enrolled", user_id=user_id, via_pending_token=bool(body.pendingToken))

    if raw_refresh is not None:
        set_refresh_cookie(response, raw_refresh)
    return WebauthnRegisterFinishResponse(id=cred_id, nickname=body.nickname, session=session)


@router.post("/auth/start")
async def auth_start(body: WebauthnAuthStartRequest) -> dict:
    async with engine.connect() as conn:
        resolved = await mfa_service.peek_mfa_pending(conn, body.pendingToken)
        if resolved is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or expired session")
        user_id, org_id = resolved
        allow_ids = await _credential_ids_for_user(conn, user_id)
        if not allow_ids:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "no passkey registered")
        uv_required = await _org_requires_uv(conn, org_id)
        challenge = await mfa_service.mint_webauthn_challenge(conn, org_id, user_id)

    options = generate_authentication_options(
        rp_id=settings.webauthn_rp_id,
        challenge=challenge,
        allow_credentials=[PublicKeyCredentialDescriptor(id=cid) for cid in allow_ids],
        user_verification=(
            UserVerificationRequirement.REQUIRED
            if uv_required
            else UserVerificationRequirement.PREFERRED
        ),
    )
    return options_to_json_dict(options)


@router.post("/step-up/start")
async def step_up_start(principal: Principal = Depends(get_principal)) -> dict:
    """WebAuthn request options for step-up re-auth (MFA-disable,
    backup-codes/regenerate) — scoped to the CALLER's own already-registered
    credentials via the Bearer principal. Deliberately a separate route from
    auth/start above rather than a shared one: that endpoint resolves
    identity from the restricted login-time pending token (no session yet),
    while this one requires an actual signed-in caller, exactly like
    mfa_service.verify_step_up itself does for the assertion it produces."""
    async with engine.connect() as conn:
        await service.set_org_guc(conn, principal.org_id)
        allow_ids = await _credential_ids_for_user(conn, principal.user_id)
        if not allow_ids:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "no passkey registered")
        uv_required = await _org_requires_uv(conn, principal.org_id)
        challenge = await mfa_service.mint_webauthn_challenge(conn, principal.org_id, principal.user_id)

    options = generate_authentication_options(
        rp_id=settings.webauthn_rp_id,
        challenge=challenge,
        allow_credentials=[PublicKeyCredentialDescriptor(id=cid) for cid in allow_ids],
        user_verification=(
            UserVerificationRequirement.REQUIRED
            if uv_required
            else UserVerificationRequirement.PREFERRED
        ),
    )
    return options_to_json_dict(options)


async def verify_webauthn_assertion(conn, credential: dict) -> tuple[str, str]:
    """Called by mfa_challenge.py's verify endpoint. Returns (user_id, org_id)
    on success; raises HTTPException(400/401) otherwise. See the module
    docstring for how each acceptance-criterion item is actually enforced."""
    try:
        client_data_json = bytes(_b64(credential["response"]["clientDataJSON"]))
    except (KeyError, TypeError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "malformed credential") from exc
    challenge = _client_data_challenge(client_data_json)
    user_id, org_id = await mfa_service.consume_webauthn_challenge(conn, challenge)

    try:
        credential_id = bytes(_b64(credential["rawId"]))
    except (KeyError, TypeError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "malformed credential") from exc

    row = (
        await conn.execute(
            text(
                "SELECT public_key, sign_count FROM mfa_webauthn_credentials "
                "WHERE user_id = :uid AND credential_id = :cid"
            ),
            {"uid": user_id, "cid": credential_id},
        )
    ).first()
    if row is None:
        # Scoped to THIS user deliberately — a credential_id that exists for a
        # DIFFERENT user must fail exactly like one that doesn't exist at all.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "unrecognized passkey")

    uv_required = await _org_requires_uv(conn, org_id)
    try:
        verified = verify_authentication_response(
            credential=credential,
            expected_challenge=challenge,
            expected_rp_id=settings.webauthn_rp_id,
            expected_origin=settings.web_origin,
            credential_public_key=bytes(row.public_key),
            credential_current_sign_count=int(row.sign_count),
            require_user_verification=uv_required,
        )
    except WebAuthnException as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "could not verify passkey") from exc

    await conn.execute(
        text(
            "UPDATE mfa_webauthn_credentials SET sign_count = :sc, last_used_at = now() "
            "WHERE user_id = :uid AND credential_id = :cid"
        ),
        {"sc": verified.new_sign_count, "uid": user_id, "cid": credential_id},
    )
    return user_id, org_id


def _b64(value: str) -> bytes:
    return base64url_to_bytes(value)
