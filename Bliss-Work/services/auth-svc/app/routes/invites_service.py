"""Non-route helpers for the invite lifecycle.

Token mint/hash, outbox emission, and user creation on accept live here so
the router module stays a thin HTTP layer. All functions operate within a
caller-supplied transaction to preserve outbox + state-change atomicity.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from .. import service
from ..config import settings
from ..crypto import cryptor
from ..events.outbox import TOPIC_AUTH, build_event, enqueue_event
from ..routing import directory, placement
from ..routing.decision import Route, route_for
from ..routing.events import KEY_INVITE, invite_key
from ..schemas import AcceptInviteRequest, CreateInviteRequest, SessionDTO
from ..security.auth_dep import Principal
from ..security.passwords import (
    PASSWORD_POLICY_MESSAGE,
    hash_password_async,
    password_meets_policy,
    verify_password_async,
)

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


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


async def create_invite_tx(
    conn: AsyncConnection,
    body: CreateInviteRequest,
    principal: Principal,
) -> str:
    """Mint an invite token, persist the invite, emit invite.created. Returns id."""
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
        meta={"email": str(body.email), "role": body.role},
    )
    return invite_id


async def accept_invite_tx(
    conn: AsyncConnection,
    body: AcceptInviteRequest,
) -> tuple[SessionDTO, str, str]:
    """Accept an invite: create user, emit user.created, build a session.

    Returns (session, raw_refresh, user_id). Uses SELECT ... FOR UPDATE so a
    single invite cannot be accepted concurrently.
    """
    if not password_meets_policy(body.password):
        raise HTTPException(status_code=422, detail=PASSWORD_POLICY_MESSAGE)
    token_hash = service.sha256_bytes(body.token)
    now = datetime.now(timezone.utc)

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
    user_id = service.new_uuid()
    c = cryptor()
    email_enc = await c.encrypt(conn, org_id, str(invite.email))
    email_bidx = c.blind_index(str(invite.email))
    dn_enc = await c.encrypt(conn, org_id, body.displayName)
    # Cross-org identity: if this email already has an identity, attach this
    # membership to it (reuse the shared credential) after authenticating with the
    # existing password; otherwise create a fresh identity. Invited users are
    # email-verified (the invite proves control of the address).
    existing_ident = (
        await conn.execute(
            text("SELECT id, password_hash FROM identities WHERE email_bidx = :b"),
            {"b": email_bidx},
        )
    ).first()
    if existing_ident is not None:
        if not await verify_password_async(existing_ident.password_hash, body.password):
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                "that email already has an account — use your existing password to join",
            )
        identity_id = str(existing_ident.id)
        ph = existing_ident.password_hash
    else:
        identity_id = service.new_uuid()
        ph = await hash_password_async(body.password)
        await conn.execute(
            text(
                "INSERT INTO identities (id, email_bidx, password_hash, email_verified) "
                "VALUES (:id, :b, :ph, true)"
            ),
            {"id": identity_id, "b": email_bidx, "ph": ph},
        )
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
    )
    await enqueue_event(conn, topic=TOPIC_AUTH, kafka_key=user_id, event=event)
    await service.write_audit(
        conn,
        org_id=org_id,
        actor_id=user_id,
        action="invite.accepted",
        target=str(invite.id),
    )

    session, raw_refresh = await service.build_session(conn, user_id)
    return session, raw_refresh, user_id
