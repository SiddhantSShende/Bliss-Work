"""Non-route helpers for the invite lifecycle.

Token mint/hash, outbox emission, and user creation on accept live here so
the router module stays a thin HTTP layer. All functions operate within a
caller-supplied transaction to preserve outbox + state-change atomicity.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request, status
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from .. import service
from ..config import settings
from crypto import cryptor
from ..dates import iso_z
from ..events.outbox import TOPIC_AUTH, build_event, enqueue_event
from ..logging_config import log
from ..net import request_context
from ..routing import directory, placement
from . import mfa_service, session_events
from ..routing.decision import Route, route_for
from ..routing.events import KEY_INVITE, invite_key
from ..schemas import AcceptInviteRequest, CreateInviteRequest, MfaPendingDTO, SessionDTO
from ..security.auth_dep import Principal
from ..security.passwords import PASSWORD_POLICY_MESSAGE, password_meets_policy

INVITE_TTL = timedelta(hours=72)


class InviteAtAnotherSite(Exception):
    """This invite belongs to an org whose data lives at another site.

    Carried out of the service layer as an exception rather than a response
    because `accept_invite_tx` runs inside the caller's transaction and has no
    business building HTTP: the router catches this and hands it to the shared
    redirect helper, which is the same code path an org-mismatch takes.
    """

    def __init__(self, home_site: str) -> None:
        super().__init__(home_site)
        self.home_site = home_site


async def create_invite_tx(
    conn: AsyncConnection,
    body: CreateInviteRequest,
    principal: Principal,
    *,
    ip: str | None = None,
    user_agent: str | None = None,
    request_id: str | None = None,
) -> str:
    """Mint an invite token, persist the invite, emit invite.created. Returns id.

    Invalidates any prior PENDING invite for the same (org, email) so only the
    newest link is ever honored — mirrors account_service.py's `mint_token`.
    A partial unique index (`invites (org_id, email) WHERE status='pending'`,
    migration 0015) backstops this against two genuinely concurrent creates
    racing each other: under READ COMMITTED, a concurrent transaction's
    invalidate-UPDATE can't see this one's not-yet-committed INSERT, so both
    would otherwise supersede nothing and both insert. On that race the
    INSERT below raises a unique-violation; this retries the
    supersede-then-insert once, now correctly seeing the other transaction's
    committed row. See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 6.
    """
    raw_token = service.new_refresh_secret()
    invite_id = service.new_uuid()
    expires_at = datetime.now(timezone.utc) + INVITE_TTL

    role_id = await service.role_id(conn, body.role)
    org_row = (
        await conn.execute(
            text("SELECT name FROM orgs WHERE id = :id"), {"id": principal.org_id}
        )
    ).first()
    if org_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "org not found")

    for attempt in range(2):
        await conn.execute(
            text(
                "UPDATE invites SET status = 'superseded' "
                "WHERE org_id = :org AND email = :email AND status = 'pending'"
            ),
            {"org": principal.org_id, "email": str(body.email)},
        )
        try:
            # SAVEPOINT: a failed INSERT poisons the whole transaction in
            # Postgres until rolled back — nesting lets us roll back just
            # this attempt and retry within the same outer transaction the
            # router opened, rather than aborting invite creation entirely.
            async with conn.begin_nested():
                await conn.execute(
                    text(
                        """
                        INSERT INTO invites
                            (id, org_id, email, role_id, token_hash, invited_by, expires_at)
                        VALUES (:id, :org, :email, :rid, :hash, :by, :exp)
                        """
                    ),
                    {
                        "id": invite_id,
                        "org": principal.org_id,
                        "email": str(body.email),
                        "rid": role_id,
                        "hash": service.sha256_bytes(raw_token),
                        "by": principal.user_id,
                        "exp": expires_at,
                    },
                )
            break
        except IntegrityError:
            if attempt == 1:
                raise
            log.info(
                "invite_create_race_retry",
                org_id=principal.org_id,
                detail="concurrent create for the same (org, email); retrying",
            )

    # Make the invite routable from EVERY site before the link is emailed.
    #
    # Stamped with the ORG's home site, not this one. An admin may well be
    # signed in at a site that is not their org's home — that is the whole point
    # of cross-site routing — and an invite stamped with the serving site would
    # send its recipient somewhere the org's data is not.
    #
    # In the same transaction as the invite insert, so there is no window where
    # a valid invite exists that no site can route.
    home_site = await placement.home_site_of_org(conn, principal.org_id) or settings.site_id
    await placement.record_invite_placement(
        conn,
        invite_key(service.sha256_bytes(raw_token)),
        home_site=home_site,
        expires_at=expires_at,
    )

    invite_url = f"{settings.invite_base_url}?token={raw_token}"
    event = build_event(
        "invite.created",
        principal.org_id,
        inviteId=invite_id,
        email=str(body.email),
        inviteUrl=invite_url,
        orgName=org_row.name,
        invitedByUsername=principal.username,
        expiresAt=iso_z(expires_at),
    )
    await enqueue_event(conn, topic=TOPIC_AUTH, kafka_key=principal.user_id, event=event)
    await service.write_audit(
        conn,
        org_id=principal.org_id,
        actor_id=principal.user_id,
        action="invite.created",
        target=invite_id,
        meta=session_events.context_meta(
            ip=ip,
            user_agent=user_agent,
            request_id=request_id,
            email=str(body.email),
            role=body.role,
        ),
    )
    return invite_id


async def precheck_commitment_for_invite(
    engine: AsyncEngine, token: str
) -> tuple[str, str, str] | None:
    """Best-effort, non-authoritative lookup of (org_id, role, user_id_hint)
    for a billing-svc commitment check BEFORE `accept_invite_tx` opens its own
    transaction — see routes/invites.py's accept_invite. Returns None when the
    invite doesn't resolve locally (wrong token, expired, already accepted, or
    it belongs to another site's data — all of which accept_invite_tx will
    re-check authoritatively and report correctly on its own; skipping the
    billing call here just avoids a wasted one).

    `user_id_hint` reuses a previously-removed user's id when this email was a
    member before (so the SAME id used for the billing reservation is the id
    accept_invite_tx actually writes), or a freshly minted one otherwise.
    Plain reads only — no locks, no writes — so nothing here needs to survive
    into the real transaction.
    """
    token_hash = service.sha256_bytes(token)
    async with engine.connect() as conn:
        await service.set_bypass_rls(conn)
        row = (
            await conn.execute(
                text(
                    """
                    SELECT i.org_id, i.email, r.name AS role_name
                    FROM invites i
                    JOIN roles r ON r.id = i.role_id
                    WHERE i.token_hash = :hash AND i.status = 'pending' AND i.expires_at > now()
                    """
                ),
                {"hash": token_hash},
            )
        ).first()
        if row is None:
            return None
        org_id = str(row.org_id)
        email_bidx = cryptor().blind_index(str(row.email))
        existing = (
            await conn.execute(
                text(
                    "SELECT id FROM users WHERE org_id = :org AND email_bidx = :bidx AND status = 'removed'"
                ),
                {"org": org_id, "bidx": email_bidx},
            )
        ).first()
    user_id = str(existing.id) if existing is not None else service.new_uuid()
    return org_id, str(row.role_name), user_id


async def accept_invite_tx(
    conn: AsyncConnection,
    body: AcceptInviteRequest,
    request: Request,
    *,
    user_id_hint: str | None = None,
) -> tuple[SessionDTO | MfaPendingDTO, str | None, str]:
    """Accept an invite: create user, emit user.created, build a session.

    Returns (session, raw_refresh, user_id). Uses SELECT ... FOR UPDATE so a
    single invite cannot be accepted concurrently.

    When an EXISTING identity (password-only so far) still owes a second factor,
    no session is built: the first element is the `MfaPendingDTO` /auth/login
    would have returned and `raw_refresh` is None. The membership and the
    accepted invite are committed regardless — the password was verified.
    """
    if not password_meets_policy(body.password):
        raise HTTPException(status_code=422, detail=PASSWORD_POLICY_MESSAGE)
    token_hash = service.sha256_bytes(body.token)
    now = datetime.now(timezone.utc)
    ip, user_agent, request_id = request_context(request)

    # Pre-org-context: the invite is found by token hash before the org is known,
    # so the SELECT runs under bypass (invites is RLS). Once we have the invite's
    # org we pin app.org_id and clear the bypass so the user/role/org_keys writes
    # below are genuinely org-scoped.
    await service.set_bypass_rls(conn)

    # ── Which SITE owns this invite? ─────────────────────────────────────────
    #
    # This lookup has to come first, and it is the reason the routing directory
    # exists. Redemption is keyed on the token hash ALONE — deliberately, since
    # an invite link must work for someone who belongs to no org yet — so there
    # is no org id to route by and the local `invites` table is not authoritative
    # for an invite minted at another site.
    #
    # Without this, a recipient whose org lives at the other site sees "invalid
    # or expired invite": the row genuinely is not here, and the old code could
    # not tell that apart from a bad token.
    #
    # Raises for the remote / not-yet-replicated / expired cases; returns for the
    # local one. See routing/decision.py for why an unknown key is a retry rather
    # than a 404.
    entry = await directory.lookup(conn, KEY_INVITE, invite_key(token_hash))
    decision = route_for(entry, settings.site_id, now=now)
    if decision.route is Route.RETRY:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "this invite is not available at this site yet — retry shortly",
            headers={"Retry-After": "2"},
        )
    if decision.route is Route.REDIRECT:
        raise InviteAtAnotherSite(decision.home_site or "")
    if decision.route is Route.GONE:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid or expired invite")

    invite = (
        await conn.execute(
            text(
                """
                SELECT id, org_id, email, role_id, status, expires_at
                FROM invites
                WHERE token_hash = :hash
                FOR UPDATE
                """
            ),
            {"hash": token_hash},
        )
    ).first()

    if invite is None or invite.status != "pending" or invite.expires_at <= now:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid or expired invite")

    org_id = str(invite.org_id)
    # Bind RLS to the invite's org and drop the bypass before any write/crypto.
    await conn.execute(text("SELECT set_config('app.bypass_rls', 'off', true)"))
    await service.set_org_guc(conn, org_id)
    c = cryptor()
    email_enc = await c.encrypt(conn, org_id, str(invite.email))
    email_bidx = c.blind_index(str(invite.email))
    dn_enc = await c.encrypt(conn, org_id, body.displayName)
    # Cross-org identity: if this email already has an identity, attach this
    # membership to it (reuse the shared credential) after authenticating with the
    # existing password; otherwise create a fresh identity. Invited users are
    # email-verified (the invite proves control of the address) regardless of
    # the identity's own state, so that state is not read here.
    identity_id, ph, new_identity, _existing_verified = await service.resolve_or_create_identity(
        conn,
        email_bidx,
        body.password,
        new_identity_email_verified=True,
        already_registered_error=HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "that email already has an account — use your existing password to join",
        ),
    )
    # A `users` row for this (org, email) can already exist — most commonly a
    # previously-removed member being re-invited (members.py's remove_member
    # docstring: "Re-invitable afterwards"; _apply_status's removed branch:
    # "so a re-invite starts from a clean slate"). Neither actually clears
    # email_bidx, so the row — and its slot in uq_users_org_email_bidx —
    # survives removal forever; an unconditional INSERT below would hit that
    # unique index and 500 instead of the clean-slate re-invite both of those
    # comments promise. An active/suspended row is a different mistake (the
    # invite target is already a member) and gets its own clear answer rather
    # than the same crash.
    existing_user = (
        await conn.execute(
            text("SELECT id, status FROM users WHERE org_id = :org AND email_bidx = :bidx"),
            {"org": org_id, "bidx": email_bidx},
        )
    ).first()
    if existing_user is not None and existing_user.status != "removed":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "this email already belongs to a member of this organization",
        )

    if existing_user is not None:
        # Reactivate the removed row in place — its history (audit log,
        # authored messages/tasks) points at this id, and the unique index
        # would reject a second row for this (org, email) regardless.
        user_id = str(existing_user.id)
        try:
            async with conn.begin_nested():
                await conn.execute(
                    text(
                        """
                        UPDATE users
                        SET identity_id = :iid, email_enc = :email_enc, email_bidx = :email_bidx,
                            username = :username, password_hash = :ph, display_name_enc = :dn_enc,
                            email_verified = true, status = 'active', removed_at = NULL
                        WHERE id = :id
                        """
                    ),
                    {
                        "id": user_id,
                        "iid": identity_id,
                        "email_enc": email_enc,
                        "email_bidx": email_bidx,
                        "username": body.username,
                        "ph": ph,
                        "dn_enc": dn_enc,
                    },
                )
        except IntegrityError as exc:
            constraint = getattr(exc.orig, "constraint_name", None)
            if constraint == "users_org_id_username_key":
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "username is already in use in this organization",
                ) from exc
            raise
    else:
        # Reuse the pre-generated id from precheck_commitment_for_invite when
        # given, so the billing-svc reservation made against it (before this
        # transaction opened) lines up with the row actually created here.
        user_id = user_id_hint or service.new_uuid()
        try:
            async with conn.begin_nested():
                await conn.execute(
                    text(
                        """
                        INSERT INTO users (id, org_id, identity_id, email_enc, email_bidx, username, password_hash, display_name_enc, email_verified)
                        VALUES (:id, :org, :iid, :email_enc, :email_bidx, :username, :ph, :dn_enc, true)
                        """
                    ),
                    {
                        "id": user_id,
                        "org": org_id,
                        "iid": identity_id,
                        "email_enc": email_enc,
                        "email_bidx": email_bidx,
                        "username": body.username,
                        "ph": ph,
                        "dn_enc": dn_enc,
                    },
                )
        except IntegrityError as exc:
            constraint = getattr(exc.orig, "constraint_name", None)
            if constraint == "users_org_id_username_key":
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "username is already in use in this organization",
                ) from exc
            raise
    # Either branch leaves this user with no role row: a fresh insert has
    # never had one, and _apply_status's removal path deletes every role row
    # for a removed user (see its own "clean slate" comment) — so this is
    # always a fresh grant, never a conflict.
    await conn.execute(
        text(
            """
            INSERT INTO user_roles (user_id, role_id, org_id)
            VALUES (:uid, :rid, :org)
            """
        ),
        {"uid": user_id, "rid": int(invite.role_id), "org": org_id},
    )
    await conn.execute(
        text(
            """
            UPDATE invites
            SET status = 'accepted', accepted_at = now(), accepted_user_id = :uid
            WHERE id = :id
            """
        ),
        {"uid": user_id, "id": str(invite.id)},
    )

    dto = await service.user_dto(conn, user_id)
    assert dto is not None
    event = build_event(
        "user.created",
        org_id,
        userId=user_id,
        username=dto.username,
        displayName=dto.displayName,
        # See the note at the org-creation emit in routes/auth.py.
        email=dto.email,
    )
    await enqueue_event(conn, topic=TOPIC_AUTH, kafka_key=user_id, event=event)

    # An existing identity reached this point on its password alone; if a second
    # factor is enrolled it is still owed (see mfa_service.pending_for_new_membership).
    mfa_pending = (
        None
        if new_identity
        else await mfa_service.pending_for_new_membership(
            conn, identity_id, user_id, org_id, dto.roles
        )
    )
    if mfa_pending is not None:
        await service.write_audit(
            conn,
            org_id=org_id,
            actor_id=user_id,
            action="invite.accepted",
            target=str(invite.id),
            meta=session_events.context_meta(
                ip=ip, user_agent=user_agent, request_id=request_id
            ),
        )
        return mfa_pending, None, user_id

    # build_session runs BEFORE the audit write (rather than in its usual
    # trailing spot) purely so the family id it mints is available to put in
    # this row's meta as sessionId — same transaction either way.
    session, raw_refresh, family_id = await service.build_session(conn, user_id)
    await service.write_audit(
        conn,
        org_id=org_id,
        actor_id=user_id,
        action="invite.accepted",
        target=str(invite.id),
        meta=session_events.context_meta(
            session_id=family_id, ip=ip, user_agent=user_agent, request_id=request_id
        ),
    )
    return session, raw_refresh, user_id
