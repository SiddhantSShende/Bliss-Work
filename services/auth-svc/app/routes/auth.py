"""Auth + session + directory endpoints."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from .. import service
from ..config import settings
from ..crypto import cryptor
from ..db import engine
from ..events.outbox import TOPIC_AUTH, build_event, enqueue_event
from ..logging_config import log
from ..schemas import (
    CreateOrgRequest,
    LoginRequest,
    OrgMembershipDTO,
    RefreshRequest,
    SessionDTO,
    UpdateProfileRequest,
    UserDTO,
)
from ..security.auth_dep import Principal, get_principal
from ..security.origin import enforce_origin
from ..security.passwords import (
    PASSWORD_POLICY_MESSAGE,
    dummy_verify,
    hash_password,
    password_meets_policy,
    verify_password,
)
from .account_service import create_email_verification_tx
from .cookies import REFRESH_COOKIE, clear_refresh_cookie, set_refresh_cookie

router = APIRouter(prefix="/auth", tags=["auth"])


async def _register_failed_login(conn: AsyncConnection, ident) -> int:
    """Bump an IDENTITY's failed-login counter; lock the identity once it reaches
    `login_max_failed_attempts`. Returns the lockout duration in seconds if it just
    locked, else 0. The caller must let the transaction COMMIT (raise the auth error
    AFTER the `engine.begin()` block) so the increment persists. Lockout lives on the
    identity so a shared credential is throttled uniformly across all its orgs."""
    new_count = int(ident.failed_login_count) + 1
    if new_count >= settings.login_max_failed_attempts:
        await conn.execute(
            text(
                "UPDATE identities SET failed_login_count = 0, "
                "locked_until = now() + make_interval(mins => :m) WHERE id = :id"
            ),
            {"m": settings.lockout_minutes, "id": str(ident.id)},
        )
        return settings.lockout_minutes * 60
    await conn.execute(
        text("UPDATE identities SET failed_login_count = :c WHERE id = :id"),
        {"c": new_count, "id": str(ident.id)},
    )
    return 0


@router.post(
    "/orgs",
    response_model=SessionDTO,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(enforce_origin)],
)
async def create_org(body: CreateOrgRequest, response: Response) -> SessionDTO:
    if not password_meets_policy(body.password):
        raise HTTPException(status_code=422, detail=PASSWORD_POLICY_MESSAGE)
    async with engine.begin() as conn:
        # The org slug uniqueness probe reads `orgs` (RLS) before any org context
        # exists, and is intentionally a cross-org check, so run it under bypass.
        await service.set_bypass_rls(conn)
        slug = await service.unique_slug(conn, body.orgName)
        org_id = service.new_uuid()
        user_id = service.new_uuid()

        # Bind the RLS context to the org being created BEFORE any insert and
        # clear the bypass so the writes below are genuinely org-scoped. Every
        # row written (orgs.id, users/user_roles/org_keys.org_id) carries this
        # id, so the org_isolation WITH CHECK passes.
        await conn.execute(
            text("SELECT set_config('app.bypass_rls', 'off', true)")
        )
        await service.set_org_guc(conn, org_id)

        await conn.execute(
            text(
                """
                INSERT INTO orgs (id, name, slug, created_by)
                VALUES (:id, :name, :slug, :by)
                """
            ),
            {"id": org_id, "name": body.orgName, "slug": slug, "by": user_id},
        )
        c = cryptor()
        email_enc = await c.encrypt(conn, org_id, str(body.email))
        email_bidx = c.blind_index(str(body.email))
        dn_enc = await c.encrypt(conn, org_id, body.displayName)
        # Cross-org identity: if this email already has an identity (an existing
        # user creating another org), reuse the shared credential — but only after
        # authenticating with its password. Otherwise create a fresh identity.
        existing_ident = (
            await conn.execute(
                text(
                    "SELECT id, password_hash, email_verified FROM identities WHERE email_bidx = :b"
                ),
                {"b": email_bidx},
            )
        ).first()
        if existing_ident is not None:
            if not verify_password(existing_ident.password_hash, body.password):
                raise HTTPException(status.HTTP_409_CONFLICT, "that email is already registered")
            identity_id = str(existing_ident.id)
            ph = existing_ident.password_hash
            member_verified = bool(existing_ident.email_verified)
            new_identity = False
        else:
            identity_id = service.new_uuid()
            ph = hash_password(body.password)
            await conn.execute(
                text(
                    "INSERT INTO identities (id, email_bidx, password_hash, email_verified) "
                    "VALUES (:id, :b, :ph, false)"
                ),
                {"id": identity_id, "b": email_bidx, "ph": ph},
            )
            member_verified = False
            new_identity = True
        await conn.execute(
            text(
                """
                INSERT INTO users (id, org_id, identity_id, email_enc, email_bidx, username, password_hash, display_name_enc, email_verified)
                VALUES (:id, :org, :iid, :email_enc, :email_bidx, :username, :ph, :dn_enc, :ev)
                """
            ),
            {
                "id": user_id,
                "org": org_id,
                "iid": identity_id,
                "email_enc": email_enc,
                "email_bidx": email_bidx,
                "username": str(body.email).split("@", 1)[0],
                "ph": ph,
                "dn_enc": dn_enc,
                "ev": member_verified,
            },
        )
        admin_role = await service.role_id(conn, "org_admin")
        await conn.execute(
            text(
                """
                INSERT INTO user_roles (user_id, role_id, org_id)
                VALUES (:uid, :rid, :org)
                """
            ),
            {"uid": user_id, "rid": admin_role, "org": org_id},
        )

        dto = await service.user_dto(conn, user_id)
        assert dto is not None
        event = build_event(
            "user.created",
            org_id,
            userId=user_id,
            username=dto.username,
            displayName=dto.displayName,
        )
        await enqueue_event(conn, topic=TOPIC_AUTH, kafka_key=user_id, event=event)
        await service.write_audit(
            conn, org_id=org_id, actor_id=user_id, action="org.created", target=org_id
        )

        # Send the email-verification link only for a BRAND-NEW identity (an
        # existing verified identity creating another org doesn't re-verify). The
        # admin still gets a session below (never locked out on signup — an in-app
        # banner prompts verification); this runs in the same org-scoped tx so the
        # token + outbox row are atomic with the user insert.
        if new_identity:
            await create_email_verification_tx(conn, user_id, org_id, str(body.email))

        session, raw_refresh = await service.build_session(conn, user_id)

    set_refresh_cookie(response, raw_refresh)
    log.info("org_created", org_id=org_id, user_id=user_id, slug=slug)
    return session


@router.post("/login", response_model=SessionDTO, dependencies=[Depends(enforce_origin)])
async def login(body: LoginRequest, response: Response) -> SessionDTO:
    generic = HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    now = datetime.now(timezone.utc)
    # Outcome is carried OUT of the transaction: a failed-login increment must be
    # committed, so we raise the auth error only after `engine.begin()` exits
    # normally (raising inside would roll the counter back).
    session: SessionDTO | None = None
    raw_refresh: str | None = None
    failed = False
    locked_secs = 0  # >0 => the account just crossed the lockout threshold
    async with engine.begin() as conn:
        # Pre-org-context: resolve the IDENTITY by the cross-org email blind index
        # (the shared credential), so this trusted lookup runs under bypass.
        # build_session below decrypts via org_keys (also RLS) in the same tx.
        await service.set_bypass_rls(conn)
        ident = await service.identity_by_bidx(conn, cryptor().blind_index(str(body.email)))

        if ident is None:
            dummy_verify()  # equalize timing on unknown email; nothing to write
            raise generic

        if ident.locked_until is not None and ident.locked_until > now:
            # Identity-level lockout is in effect. No write here, so raising
            # inline is safe. 429 is inherently account-targeted; accepted.
            retry = max(1, int((ident.locked_until - now).total_seconds()))
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "account temporarily locked due to failed logins; try again later",
                headers={"Retry-After": str(retry)},
            )

        if not verify_password(ident.password_hash, body.password):
            locked_secs = await _register_failed_login(conn, ident)
            failed = True  # commit the increment, then raise below
        elif settings.require_email_verification and not ident.email_verified:
            # Correct password but unverified and the gate is enabled. Not a
            # failed attempt (don't count it); block with a clear message.
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "please verify your email address before signing in",
            )
        else:
            # Pick the org to open: last-used if still valid, else active-then-oldest.
            membership_id = await service.default_membership(conn, ident)
            if membership_id is None:
                # Identity with no active membership — treat as invalid credentials.
                failed = True
            else:
                if ident.failed_login_count or ident.locked_until is not None:
                    await service.reset_identity_lockout(conn, str(ident.id))
                await service.touch_last_user(conn, str(ident.id), membership_id)
                session, raw_refresh = await service.build_session(conn, membership_id)
    # Transaction committed. Any persisted failed-login increment is durable now.

    if failed:
        if locked_secs > 0:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "account temporarily locked due to failed logins; try again later",
                headers={"Retry-After": str(locked_secs)},
            )
        raise generic

    assert session is not None and raw_refresh is not None
    set_refresh_cookie(response, raw_refresh)
    log.info("login_ok", user_id=session.user.id)
    return session


def _refresh_rejected(code: str, *, clear_cookie: bool = True) -> JSONResponse:
    """401 for a refresh that cannot be honoured.

    RETURNED, never raised. Raising HTTPException discards the `response` object
    the handler was given, so the `clear_refresh_cookie(response)` that used to
    live here never reached the browser: the client kept its dead cookie and
    re-presented it on every poll, which is how one revoked family produced 26
    identical 401s in eight minutes. Building the response here means the
    Set-Cookie deletion actually ships.

    `code` tells the client whether this is terminal ('reused' / 'expired' — the
    session is over) or not ('missing'), which is the difference between a clean
    trip to /login and a silent 401 loop.
    """
    payload = JSONResponse(
        status_code=status.HTTP_401_UNAUTHORIZED,
        content={"detail": "invalid refresh token", "code": code},
    )
    if clear_cookie:
        clear_refresh_cookie(payload)
    return payload


@router.post("/refresh", response_model=SessionDTO, dependencies=[Depends(enforce_origin)])
async def refresh(
    response: Response,
    body: RefreshRequest | None = None,
    refresh_token: str | None = Cookie(default=None, alias=REFRESH_COOKIE),
) -> SessionDTO | JSONResponse:
    from_body = bool(body and body.token)
    raw = (body.token if body else None) or refresh_token
    if not raw:
        # No credential at all — nothing to invalidate, and NOT terminal: a
        # request that simply arrived without the cookie must not log anyone out.
        return _refresh_rejected("missing", clear_cookie=False)
    try:
        async with engine.begin() as conn:
            # Pre-org-context: the token is looked up by hash in refresh_tokens
            # (no RLS) before the org is known; build_session then reads
            # users/org_keys (RLS) cross-org, so this trusted flow uses bypass.
            await service.set_bypass_rls(conn)
            session, new_raw = await service.rotate_refresh_token(conn, raw)
    except service.RefreshError as exc:
        # Log WHO and WHICH family, and whether the token came from the cookie
        # (browser) or the request body (desktop — see the `raw` line above).
        # When two clients collide, that field is what identifies the culprit.
        log.info(
            "refresh_rejected",
            error=str(exc),
            code=exc.code,
            user_id=exc.user_id,
            family_id=exc.family_id,
            source="body" if from_body else "cookie",
        )
        return _refresh_rejected(exc.code)

    set_refresh_cookie(response, new_raw)
    return session


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(enforce_origin)],
)
async def logout(
    response: Response,
    refresh_token: str | None = Cookie(default=None, alias=REFRESH_COOKIE),
) -> Response:
    if refresh_token:
        async with engine.begin() as conn:
            await service.revoke_family_by_token(conn, refresh_token)
    clear_refresh_cookie(response)
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/orgs/mine", response_model=list[OrgMembershipDTO])
async def my_orgs(principal: Principal = Depends(get_principal)) -> list[OrgMembershipDTO]:
    """Every organization the caller's identity belongs to (for the switcher)."""
    async with engine.connect() as conn:
        await service.set_bypass_rls(conn)  # cross-org membership list
        iid = await service.identity_id_for_user(conn, principal.user_id)
        memberships = await service.memberships_for_identity(conn, iid) if iid else []
    if not memberships:
        # Legacy fallback (a token minted before the identity link): expose just
        # the caller's current org so the switcher still renders.
        return [
            OrgMembershipDTO(
                orgId=principal.org_id, orgName="", roles=principal.roles, active=True  # type: ignore[arg-type]
            )
        ]
    return [
        OrgMembershipDTO(
            orgId=m["orgId"],
            orgName=m["orgName"],
            roles=m["roles"],
            active=(m["orgId"] == principal.org_id),
        )
        for m in memberships
    ]


@router.post(
    "/orgs/{org_id}/switch",
    response_model=SessionDTO,
    dependencies=[Depends(enforce_origin)],
)
async def switch_org(
    org_id: str, response: Response, principal: Principal = Depends(get_principal)
) -> SessionDTO:
    """Switch the active organization: re-mint a session for the caller's membership
    in `org_id` (only orgs their identity belongs to). Rotates the refresh cookie to
    the target membership's family."""
    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)  # cross-org: resolve identity + target membership
        iid = await service.identity_id_for_user(conn, principal.user_id)
        if iid is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "cannot switch organizations")
        target_user = await service.membership_in_org(conn, iid, org_id)
        if target_user is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "not a member of that organization")
        await service.touch_last_user(conn, iid, target_user)
        session, raw_refresh = await service.build_session(conn, target_user)
    set_refresh_cookie(response, raw_refresh)
    log.info("org_switched", user_id=session.user.id, org_id=org_id)
    return session


@router.get("/me", response_model=UserDTO)
async def me(principal: Principal = Depends(get_principal)) -> UserDTO:
    async with engine.connect() as conn:
        # user_dto reads `users` and decrypts via `org_keys` (both RLS); scope to
        # the caller's verified org. engine.connect() runs in an implicit tx, so
        # the transaction-local GUC is cleaned up when the connection returns.
        await service.set_org_guc(conn, principal.org_id)
        dto = await service.user_dto(conn, principal.user_id)
    if dto is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
    return dto


@router.patch("/me", response_model=UserDTO)
async def update_me(
    body: UpdateProfileRequest,
    principal: Principal = Depends(get_principal),
) -> UserDTO:
    async with engine.begin() as conn:
        # Writes users + audit_log and decrypts via org_keys (all RLS) — scope to
        # the caller's verified org so both the WHERE filter and WITH CHECK pass.
        await service.set_org_guc(conn, principal.org_id)
        await service.update_display_name(
            conn, principal.org_id, principal.user_id, body.displayName.strip()
        )
        await service.write_audit(
            conn,
            org_id=principal.org_id,
            actor_id=principal.user_id,
            action="user.profile_updated",
            target=principal.user_id,
        )
        dto = await service.user_dto(conn, principal.user_id)
    if dto is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
    log.info("profile_updated", user_id=principal.user_id)
    return dto


@router.get("/directory", response_model=list[UserDTO])
async def directory(principal: Principal = Depends(get_principal)) -> list[UserDTO]:
    async with engine.connect() as conn:
        # Lists users in the caller's org and decrypts each via org_keys (RLS).
        await service.set_org_guc(conn, principal.org_id)
        rows = (
            await conn.execute(
                text("SELECT id FROM users WHERE org_id = :org ORDER BY username"),
                {"org": principal.org_id},
            )
        ).all()
        out: list[UserDTO] = []
        for r in rows:
            dto = await service.user_dto(conn, str(r.id))
            if dto is not None:
                out.append(dto)
    return out


@router.get("/users/{user_id}", response_model=UserDTO)
async def get_user(
    user_id: str, principal: Principal = Depends(get_principal)
) -> UserDTO:
    async with engine.connect() as conn:
        # Scope to the caller's org. A user_id in another org now yields no row
        # (user_dto -> None -> 404), matching the explicit cross-org check below.
        await service.set_org_guc(conn, principal.org_id)
        dto = await service.user_dto(conn, user_id)
    if dto is None or dto.orgId != principal.org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
    return dto
