"""Auth + session + directory endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from sqlalchemy import text

from .. import service
from ..crypto import cryptor
from ..db import engine
from ..events.outbox import TOPIC_AUTH, build_event, enqueue_event
from ..logging_config import log
from ..schemas import (
    CreateOrgRequest,
    LoginRequest,
    RefreshRequest,
    SessionDTO,
    UpdateProfileRequest,
    UserDTO,
)
from ..security.auth_dep import Principal, get_principal
from ..security.passwords import (
    PASSWORD_POLICY_MESSAGE,
    dummy_verify,
    hash_password,
    password_meets_policy,
    verify_password,
)
from .cookies import REFRESH_COOKIE, clear_refresh_cookie, set_refresh_cookie

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/orgs", response_model=SessionDTO, status_code=status.HTTP_201_CREATED)
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
        await conn.execute(
            text(
                """
                INSERT INTO users (id, org_id, email_enc, email_bidx, username, password_hash, display_name_enc)
                VALUES (:id, :org, :email_enc, :email_bidx, :username, :ph, :dn_enc)
                """
            ),
            {
                "id": user_id,
                "org": org_id,
                "email_enc": email_enc,
                "email_bidx": email_bidx,
                "username": str(body.email).split("@", 1)[0],
                "ph": hash_password(body.password),
                "dn_enc": dn_enc,
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

        session, raw_refresh = await service.build_session(conn, user_id)

    set_refresh_cookie(response, raw_refresh)
    log.info("org_created", org_id=org_id, user_id=user_id, slug=slug)
    return session


@router.post("/login", response_model=SessionDTO)
async def login(body: LoginRequest, response: Response) -> SessionDTO:
    generic = HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    async with engine.begin() as conn:
        # Pre-org-context: the org is unknown until we resolve the user by the
        # cross-org email blind index, so this trusted lookup runs under bypass.
        # build_session below decrypts via org_keys (also RLS) in the same tx.
        await service.set_bypass_rls(conn)
        row = (
            await conn.execute(
                text(
                    """
                    SELECT u.id, u.password_hash, u.status
                    FROM users u
                    WHERE u.email_bidx = :bidx
                    ORDER BY (u.status = 'active') DESC, u.created_at ASC
                    LIMIT 1
                    """
                ),
                {"bidx": cryptor().blind_index(str(body.email))},
            )
        ).first()

        if row is None:
            dummy_verify()
            raise generic
        if row.status != "active" or not verify_password(row.password_hash, body.password):
            raise generic

        session, raw_refresh = await service.build_session(conn, str(row.id))

    set_refresh_cookie(response, raw_refresh)
    log.info("login_ok", user_id=session.user.id)
    return session


@router.post("/refresh", response_model=SessionDTO)
async def refresh(
    response: Response,
    body: RefreshRequest | None = None,
    refresh_token: str | None = Cookie(default=None, alias=REFRESH_COOKIE),
) -> SessionDTO:
    raw = (body.token if body else None) or refresh_token
    if not raw:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing refresh token")
    try:
        async with engine.begin() as conn:
            # Pre-org-context: the token is looked up by hash in refresh_tokens
            # (no RLS) before the org is known; build_session then reads
            # users/org_keys (RLS) cross-org, so this trusted flow uses bypass.
            await service.set_bypass_rls(conn)
            session, new_raw = await service.rotate_refresh_token(conn, raw)
    except ValueError as exc:
        log.info("refresh_rejected", error=str(exc))
        clear_refresh_cookie(response)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid refresh token") from exc

    set_refresh_cookie(response, new_raw)
    return session


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
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
