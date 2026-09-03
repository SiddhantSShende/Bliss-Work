"""Invite lifecycle: create, list, revoke, verify, accept."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import RedirectResponse
from sqlalchemy import text

from .. import service
from ..db import engine
from ..logging_config import log
from ..schemas import (
    AcceptInviteRequest,
    CreateInviteRequest,
    CreateInviteResponse,
    InviteListItem,
    InviteVerifyResponse,
    SessionDTO,
)
from ..security.auth_dep import Principal, require_org_admin
from ..security.origin import enforce_origin
from .cookies import set_refresh_cookie
from ..config import settings
from ..routing.decision import Route, RouteDecision
from ..routing.redirect import SiteEndpoints, enforce
from .invites_service import (
    InviteAtAnotherSite,
    accept_invite_tx,
    create_invite_tx,
    iso_z,
)
from .members_service import require_live_admin

router = APIRouter(prefix="/auth/invites", tags=["invites"])


@router.post(
    "",
    response_model=CreateInviteResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(enforce_origin)],
)
async def create_invite(
    body: CreateInviteRequest,
    principal: Principal = Depends(require_org_admin),
) -> CreateInviteResponse:
    async with engine.begin() as conn:
        # Reads `orgs`, writes `invites` + `audit_log` (all RLS) for the admin's
        # verified org; scope the tx before the helper runs any query.
        await service.set_org_guc(conn, principal.org_id)
        # require_org_admin only checks the JWT claim, which survives a
        # demotion for the rest of the token's life (see require_live_admin's
        # own docstring). Minting an invite grants org_admin to whoever
        # accepts it, so this is exactly the "endpoint that grants power"
        # case that guard exists for — without it, a just-demoted/removed
        # admin could invite themself straight back in as org_admin.
        await require_live_admin(conn, principal)
        invite_id = await create_invite_tx(conn, body, principal)
    log.info("invite_created", invite_id=invite_id, org_id=principal.org_id)
    return CreateInviteResponse(id=invite_id)


@router.get("", response_model=list[InviteListItem])
async def list_invites(
    principal: Principal = Depends(require_org_admin),
) -> list[InviteListItem]:
    async with engine.connect() as conn:
        # Lists `invites` (RLS) for the admin's verified org. The JOIN to `roles`
        # (no RLS) is unaffected.
        await service.set_org_guc(conn, principal.org_id)
        rows = (
            await conn.execute(
                text(
                    """
                    SELECT i.id, i.email, r.name AS role, i.status, i.expires_at, i.created_at
                    FROM invites i
                    JOIN roles r ON r.id = i.role_id
                    WHERE i.org_id = :org AND i.status = 'pending'
                    ORDER BY i.created_at DESC
                    """
                ),
                {"org": principal.org_id},
            )
        ).all()
    return [
        InviteListItem(
            id=str(r.id),
            email=r.email,
            role=r.role,
            status=r.status,
            expiresAt=iso_z(r.expires_at),
            createdAt=iso_z(r.created_at),
        )
        for r in rows
    ]


@router.delete(
    "/{invite_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(enforce_origin)],
)
async def revoke_invite(
    invite_id: str,
    response: Response,
    principal: Principal = Depends(require_org_admin),
) -> Response:
    async with engine.begin() as conn:
        # Updates `invites` + writes `audit_log` (both RLS) for the admin's org.
        await service.set_org_guc(conn, principal.org_id)
        # See create_invite: revoking a pending admin invite is the same
        # "grants/revokes power" class of action require_live_admin exists
        # for, not an ordinary read the stale JWT claim is fine for.
        await require_live_admin(conn, principal)
        result = await conn.execute(
            text(
                """
                UPDATE invites
                SET status = 'revoked'
                WHERE id = :id AND org_id = :org AND status = 'pending'
                """
            ),
            {"id": invite_id, "org": principal.org_id},
        )
        if result.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "invite not found")
        await service.write_audit(
            conn,
            org_id=principal.org_id,
            actor_id=principal.user_id,
            action="invite.revoked",
            target=invite_id,
        )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/verify", response_model=InviteVerifyResponse)
async def verify_invite(token: str = Query(...)) -> InviteVerifyResponse:
    token_hash = service.sha256_bytes(token)
    now = datetime.now(timezone.utc)
    async with engine.connect() as conn:
        # Pre-org-context: the invite (and its org name) is looked up by token
        # hash before the org is known. invites + orgs are both RLS, so this
        # unauthenticated lookup runs under bypass.
        await service.set_bypass_rls(conn)
        row = (
            await conn.execute(
                text(
                    """
                    SELECT i.email, i.status, i.expires_at, o.name AS org_name
                    FROM invites i
                    JOIN orgs o ON o.id = i.org_id
                    WHERE i.token_hash = :hash
                    """
                ),
                {"hash": token_hash},
            )
        ).first()
    if row is None or row.status != "pending" or row.expires_at <= now:
        return InviteVerifyResponse(valid=False)
    return InviteVerifyResponse(email=row.email, orgName=row.org_name, valid=True)


@router.post("/accept", response_model=SessionDTO, dependencies=[Depends(enforce_origin)])
async def accept_invite(
    body: AcceptInviteRequest, request: Request, response: Response
) -> SessionDTO | RedirectResponse:
    """Redeem an invite, wherever in the world its organisation lives.

    The site that serves this request is not necessarily the site that holds the
    org: an invite link is emailed and clicked from anywhere, and org data is
    never replicated. `accept_invite_tx` consults the shared routing directory
    first and raises InviteAtAnotherSite when the answer is elsewhere; the
    redirect is built HERE, by the same helper an org-mismatch uses, because
    building HTTP is the router's job and not the transaction's.
    """
    try:
        async with engine.begin() as conn:
            session, raw_refresh, user_id = await accept_invite_tx(conn, body, request)
            org_id = session.user.orgId
    except InviteAtAnotherSite as elsewhere:
        # 307, not 302: the redemption is a POST carrying a password, and a 302
        # would arrive at the far site as a GET with no body.
        redirect = enforce(
            RouteDecision(Route.REDIRECT, elsewhere.home_site),
            request,
            SiteEndpoints(settings.site_endpoint_map),
            key_kind="this invite",
        )
        assert redirect is not None  # a REDIRECT decision always yields one
        log.info("invite_redirected", home_site=elsewhere.home_site)
        return redirect

    set_refresh_cookie(response, raw_refresh)
    log.info("invite_accepted", user_id=user_id, org_id=org_id)
    return session
