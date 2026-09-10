"""Auth + session + directory endpoints."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .. import service
from ..config import settings
from crypto import cryptor
from ..db import engine
from ..events.outbox import TOPIC_AUTH, build_event, enqueue_event
from ..logging_config import log
from ..net import request_context
from ..routing.notify import notify_capacity_alerts, notify_ops_no_capacity
from ..routing.placement import NoCapacityError, no_capacity_message, place_org
from ..schemas import (
    CreateOrgRequest,
    LoginRequest,
    MfaPendingDTO,
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
    dummy_verify_async,
    password_meets_policy,
    verify_password_async,
)
from . import captcha_service, mfa_service, session_events
from .account_service import create_email_verification_tx
from .cookies import REFRESH_COOKIE, clear_refresh_cookie, set_refresh_cookie
from .directory_service import InvalidUserIds, parse_user_ids
from .members_service import leave_org_tx

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post(
    "/orgs",
    response_model=SessionDTO,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(enforce_origin)],
)
async def create_org(body: CreateOrgRequest, response: Response) -> SessionDTO:
    # Checked before anything else touches the DB or Argon2 — see
    # captcha_service.verify_and_consume for why this gates the whole request.
    await captcha_service.verify_and_consume(body.captchaId, body.captchaValue)
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

        # ── Where will this organisation live? ───────────────────────────
        #
        # Decided ONCE, here, and never revisited: org data is partitioned by
        # site and never replicated, so this choice is permanent for the life of
        # the org. Done before any org row is written so a "no capacity" refusal
        # costs nothing and cannot half-create an organisation.
        #
        # `place_org` also writes the routing-directory row and the outbox event
        # that tells every peer site — in THIS transaction, so an org is never
        # visible locally without also being on its way to the rest of the mesh.
        try:
            placed = await place_org(
                conn,
                org_id,
                local_site=settings.site_id,
                candidates=settings.placement_candidate_list,
                max_report_age=timedelta(seconds=settings.site_capacity_max_age_seconds),
            )
        except NoCapacityError as exhausted:
            # Not a bad request and not transient: the deployment has nowhere to
            # put an organisation. 503 says "not now" honestly, and ops is paged
            # below — no retry and no user action fixes this one.
            log.error(
                "org_placement_no_capacity",
                reason=exhausted.reason,
                detail=no_capacity_message(exhausted.reason, exhausted.worst),
            )
            notify_ops_no_capacity(exhausted)
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "we can't create new organisations right now — our team has been notified",
            ) from exhausted

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
        identity_id, ph, new_identity, member_verified = await service.resolve_or_create_identity(
            conn,
            email_bidx,
            body.password,
            new_identity_email_verified=False,
            already_registered_error=HTTPException(
                status.HTTP_409_CONFLICT, "that email is already registered"
            ),
        )
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
            # The address is on the event because messaging-svc's user_projection
            # is what resolves a typed recipient to a member (in-app delivery)
            # and what stamps the From: header on mail that member composes.
            # Without it every colleague reads as an outside address.
            email=dto.email,
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

        session, raw_refresh, _ = await service.build_session(conn, user_id)

    set_refresh_cookie(response, raw_refresh)
    # AFTER the commit, and deliberately not awaited. A site crossing 80% is an
    # operational fact, not part of creating an account: an SMTP timeout or a
    # Slack outage must never delay — or fail — a signup that has already
    # succeeded. See routing/notify.py.
    notify_capacity_alerts(placed.alerts)
    log.info(
        "org_created",
        org_id=org_id,
        user_id=user_id,
        slug=slug,
        home_site=placed.site,
        placement_reason=placed.reason,
    )
    return session


@router.post(
    "/login", response_model=SessionDTO | MfaPendingDTO, dependencies=[Depends(enforce_origin)]
)
async def login(body: LoginRequest, response: Response, request: Request) -> SessionDTO | MfaPendingDTO:
    # Checked before the identity lookup or any Argon2 verify — independent of
    # whether the credentials themselves are right or wrong, so a captcha
    # failure never becomes a signal about account existence. See
    # captcha_service.verify_and_consume.
    await captcha_service.verify_and_consume(body.captchaId, body.captchaValue)
    generic = HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    now = datetime.now(timezone.utc)
    ip, user_agent, request_id = request_context(request)
    # Outcome is carried OUT of the transaction: a failed-login increment must be
    # committed, so we raise the auth error only after `engine.begin()` exits
    # normally (raising inside would roll the counter back).
    session: SessionDTO | None = None
    raw_refresh: str | None = None
    mfa_pending: MfaPendingDTO | None = None
    failed = False
    deactivated = False  # correct password, but every membership is suspended/removed
    locked_secs = 0  # >0 => the account just crossed the lockout threshold
    async with engine.begin() as conn:
        # Pre-org-context: resolve the IDENTITY by the cross-org email blind index
        # (the shared credential), so this trusted lookup runs under bypass.
        # build_session below decrypts via org_keys (also RLS) in the same tx.
        await service.set_bypass_rls(conn)
        ident = await service.identity_by_bidx(conn, cryptor().blind_index(str(body.email)))

        if ident is None:
            await dummy_verify_async()  # equalize timing on unknown email; nothing to write
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

        if not await verify_password_async(ident.password_hash, body.password):
            locked_secs = await service.register_failed_login(conn, ident)
            # Recorded in the same transaction as the counter increment, so the
            # audit trail and the lockout state can never disagree about how many
            # attempts there were.
            await session_events.login_failed(
                conn, str(ident.id), ip=ip, user_agent=user_agent, request_id=request_id
            )
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
                # No ACTIVE membership. Two very different situations:
                #  - the identity never had one -> generic 401 (no account oracle)
                #  - every membership was suspended/removed -> a specific 403, so
                #    the user knows to contact their admin instead of retrying a
                #    password that is in fact correct. Not an oracle: the caller
                #    already proved they own this credential.
                if await service.has_any_membership(conn, str(ident.id)):
                    deactivated = True
                else:
                    failed = True
            else:
                if ident.failed_login_count or ident.locked_until is not None:
                    await service.reset_identity_lockout(conn, str(ident.id))
                await service.touch_last_user(conn, str(ident.id), membership_id)

                # MFA gate, evaluated against exactly this membership (never
                # across the identity's other orgs) — see
                # docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7.
                dto = await service.user_dto(conn, membership_id)
                assert dto is not None
                mfa_required_now, must_enroll_first = await mfa_service.mfa_gate(
                    conn, membership_id, dto.orgId, dto.roles
                )
                if mfa_required_now:
                    pending_raw = await mfa_service.mint_mfa_pending(conn, dto.orgId, membership_id)
                    methods = (
                        [] if must_enroll_first else await mfa_service.enrolled_methods(conn, membership_id)
                    )
                    mfa_pending = MfaPendingDTO(
                        pendingToken=pending_raw,
                        methods=methods,  # type: ignore[arg-type]
                        enrollmentRequired=must_enroll_first,
                    )
                else:
                    session, raw_refresh, family_id = await service.build_session(conn, membership_id)
                    # Only in the SUCCESS branch. The failed path above commits its
                    # counter and raises afterwards, so anything enqueued before this
                    # point would be published for sign-ins that never happened.
                    await session_events.session_started(
                        conn,
                        session.user.orgId,
                        membership_id,
                        session_id=family_id,
                        ip=ip,
                        user_agent=user_agent,
                        request_id=request_id,
                    )
    # Transaction committed. Any persisted failed-login increment is durable now.

    if failed:
        if locked_secs > 0:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "account temporarily locked due to failed logins; try again later",
                headers={"Retry-After": str(locked_secs)},
            )
        raise generic

    if deactivated:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "your account has been deactivated; contact your workspace admin",
        )

    if mfa_pending is not None:
        # No session minted yet — no refresh cookie to set. The client calls
        # mfa_challenge.py's verify endpoint (or, if enrollmentRequired, the
        # enroll-start/enroll-confirm endpoints) with this pendingToken next.
        log.info("login_mfa_pending", enrollment_required=mfa_pending.enrollmentRequired)
        return mfa_pending

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
    request: Request,
    body: RefreshRequest | None = None,
    refresh_token: str | None = Cookie(default=None, alias=REFRESH_COOKIE),
) -> Response:
    """Logout carries no bearer token — this is the same pre-org-context shape
    as /auth/refresh, and for the same reason accepts the raw refresh token in
    the request body as well as the cookie: desktop and mobile cannot rely on
    the cookie travelling (see apps/desktop/src/main/session-token.ts), and
    previously had no way to name which session to revoke here at all. Mobile
    used to work around this by writing its Keychain-mirrored token back into
    the native cookie jar immediately before calling logout, purely so THIS
    endpoint would see it — see apps/mobile/src/services/authCookie.ts's
    ensureJarMatchesMirrorForLogout, now removable once this ships.
    """
    raw = (body.token if body else None) or refresh_token
    if raw:
        async with engine.begin() as conn:
            # The member is resolved from the refresh-token row itself BEFORE
            # the family is revoked. Cross-org lookup by token hash, hence
            # bypass, exactly as /auth/refresh does.
            await service.set_bypass_rls(conn)
            row = (
                await conn.execute(
                    text(
                        "SELECT u.id, u.org_id, rt.family_id FROM refresh_tokens rt "
                        "JOIN users u ON u.id = rt.user_id WHERE rt.token_hash = :h"
                    ),
                    {"h": service.sha256_bytes(raw)},
                )
            ).first()
            await service.revoke_family_by_token(conn, raw)
            if row is not None:
                ip, user_agent, request_id = request_context(request)
                await session_events.session_ended(
                    conn,
                    str(row.org_id),
                    str(row.id),
                    session_id=str(row.family_id),
                    ip=ip,
                    user_agent=user_agent,
                    request_id=request_id,
                )
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
    response_model=SessionDTO | MfaPendingDTO,
    dependencies=[Depends(enforce_origin)],
)
async def switch_org(
    org_id: str,
    response: Response,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> SessionDTO | MfaPendingDTO:
    """Switch the active organization: re-mint a session for the caller's membership
    in `org_id` (only orgs their identity belongs to). Rotates the refresh cookie to
    the target membership's family.

    Runs the IDENTICAL mandatory-MFA gate `login()` does, evaluated against the
    TARGET membership only: a user fully enrolled and clear in the org they are
    leaving can still be blocked entering an org that mandates MFA past its
    grace period, if they have never enrolled under that specific membership
    (MFA state does not carry across org boundaries — see
    docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7). When gated, the source
    org's session is deliberately left untouched — the switch never happened —
    and the caller retries via mfa_challenge.py's verify endpoint exactly as a
    fresh login would. One accepted narrowing versus a plain login: that path
    mints a session for the target membership on success but does not also
    emit this org's `session_ended` bookkeeping event, since the generic
    verify endpoint has no notion of "the org being left".
    """
    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)  # cross-org: resolve identity + target membership
        iid = await service.identity_id_for_user(conn, principal.user_id)
        if iid is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "cannot switch organizations")
        target_user = await service.membership_in_org(conn, iid, org_id)
        if target_user is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "not a member of that organization")

        target_roles = await service.roles_for_user(conn, target_user)
        mfa_required_now, must_enroll_first = await mfa_service.mfa_gate(
            conn, target_user, org_id, target_roles
        )
        if mfa_required_now:
            pending_raw = await mfa_service.mint_mfa_pending(conn, org_id, target_user)
            methods = (
                [] if must_enroll_first else await mfa_service.enrolled_methods(conn, target_user)
            )
            return MfaPendingDTO(
                pendingToken=pending_raw,
                methods=methods,  # type: ignore[arg-type]
                enrollmentRequired=must_enroll_first,
            )

        await service.touch_last_user(conn, iid, target_user)
        session, raw_refresh, family_id = await service.build_session(conn, target_user)
        # Ends the activity session in the org being left and opens one in the
        # org being entered — they are separate rows, because activity is scoped
        # per membership, not per person.
        await session_events.session_ended(
            conn, principal.org_id, principal.user_id, audit=False
        )
        ip, user_agent, request_id = request_context(request)
        await session_events.org_switched(
            conn,
            org_id,
            target_user,
            principal.org_id,
            session_id=family_id,
            ip=ip,
            user_agent=user_agent,
            request_id=request_id,
        )
    set_refresh_cookie(response, raw_refresh)
    log.info("org_switched", user_id=session.user.id, org_id=org_id)
    return session


@router.post(
    "/orgs/{org_id}/leave",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(enforce_origin)],
)
async def leave_org(
    request: Request, org_id: str, principal: Principal = Depends(get_principal)
) -> Response:
    """Leave one of the caller's own organizations — the counterpart to
    `/orgs/{org_id}/switch`, and like it, valid for any org the identity belongs
    to rather than only the one currently signed in to.

    The membership is marked removed, not deleted, exactly as an admin-initiated
    removal is: the person's messages, tasks and audit entries all point at that
    users row and must keep rendering their name, and a re-invite has to be able
    to restore it. Every session that membership holds is revoked, so leaving the
    ACTIVE org signs this client out of it — the caller is expected to switch to
    one of their remaining orgs, which `leave_org_tx` guarantees exists.
    """
    async with engine.begin() as conn:
        # Cross-org throughout: the target membership, and the other memberships
        # that decide whether it may be given up, are in orgs this request was
        # never scoped to. Same trusted path /orgs/{id}/switch takes.
        await service.set_bypass_rls(conn)
        iid = await service.identity_id_for_user(conn, principal.user_id)
        if iid is None:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "cannot leave organizations"
            )
        ip, user_agent, request_id = request_context(request)
        left_user_id = await leave_org_tx(
            conn, iid, org_id, ip=ip, user_agent=user_agent, request_id=request_id
        )
    log.info("org_left", user_id=left_user_id, org_id=org_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
        # Independently optional: the Profile page saves a display-name edit and
        # an avatar upload as two separate actions that happen to share this
        # endpoint, so only the field the caller actually sent is touched.
        if body.displayName is not None:
            await service.update_display_name(
                conn, principal.org_id, principal.user_id, body.displayName.strip()
            )
        if body.avatarUrl is not None:
            await service.update_avatar(conn, principal.org_id, principal.user_id, body.avatarUrl)
        if body.displayName is not None or body.avatarUrl is not None:
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


# A ceiling on one directory page, and the reason it is high rather than small.
#
# This endpoint had NO bound at all: it returned every member of the org and did
# two queries per member to build them. The obvious fix — a modest default page
# — would silently truncate for every existing client, none of which paginates,
# and a people list quietly missing colleagues is a worse bug than a slow one.
#
# So the page is generous enough that no real organisation notices it today,
# while the batched query underneath means even a full page is two round trips
# rather than ten thousand. Clients that outgrow it pass `offset`.
MAX_DIRECTORY_PAGE = 5000


@router.get("/directory", response_model=list[UserDTO])
async def directory(
    includeInactive: bool = False,
    limit: int = MAX_DIRECTORY_PAGE,
    offset: int = 0,
    principal: Principal = Depends(get_principal),
) -> list[UserDTO]:
    """Everyone in the caller's org. Suspended and removed members are excluded
    so they stop appearing in pickers, mention lists and the chat launcher.

    `includeInactive=true` (org_admin only) puts them back, because the name and
    email of a departed colleague must still resolve for the member-admin screen
    and for historical exports — the tasks .xlsx joins names from this endpoint,
    and a task allocated by someone who has since left must not export blank.

    Paged. `limit` is clamped to MAX_DIRECTORY_PAGE — see the note there for why
    the ceiling is high rather than small.
    """
    show_all = includeInactive and "org_admin" in principal.roles
    async with engine.connect() as conn:
        # Lists users in the caller's org and decrypts each via org_keys (RLS).
        await service.set_org_guc(conn, principal.org_id)
        return await service.user_dtos_for_org(
            conn,
            principal.org_id,
            include_inactive=show_all,
            limit=min(max(limit, 1), MAX_DIRECTORY_PAGE),
            offset=max(offset, 0),
        )


@router.get("/users", response_model=list[UserDTO])
async def users_by_ids(
    ids: str | None = None,
    principal: Principal = Depends(get_principal),
) -> list[UserDTO]:
    """Resolve up to `MAX_BATCH_IDS` users by id: `GET /auth/users?ids=a,b,c`.

    The lookup a screen needs when it is rendering rows for specific people and
    does NOT want the whole organisation. `/auth/directory` answers "everyone in
    my org" and is paged for that job; asking it to resolve twelve names means
    downloading up to five thousand rows and joining them in the browser, which
    is what every caller of it was doing.

    Scoped to the caller's org twice over — the `org_id` predicate in the query
    and the RLS context bound below. An id belonging to another tenant is not an
    error, it is simply absent from the response, so a caller cannot use presence
    or absence to probe for accounts elsewhere.

    Unlike `/auth/directory` this does NOT filter by status; see the note on
    `service.user_dtos_by_ids` for why a by-id lookup must still resolve
    suspended and removed colleagues.
    """
    try:
        wanted = parse_user_ids(ids)
    except InvalidUserIds as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    async with engine.connect() as conn:
        await service.set_org_guc(conn, principal.org_id)
        return await service.user_dtos_by_ids(conn, principal.org_id, wanted)


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
