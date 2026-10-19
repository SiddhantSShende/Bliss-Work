"""Active session management: list and revoke one's own sessions.

A "session" here is exactly a refresh-token family (service.build_session
mints one per login/switch/MFA-verify; rotation keeps it alive; reuse
detection and every existing revoke path already operate on it). This module
adds no new session concept — it is a read/revoke surface over the one that
already exists, per docs/AUTH_AUTHZ_REMEDIATION_PLAN.md and the three
existing revocation tiers (one family / all of a membership's / all of an
identity's, in service.py). Admin-facing session management for a member of
one's own org lives in members.py, reusing the same `service.revoke_family_by_id`
primitive and the presentation helpers in session_presentation.py.
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status

from .. import service
from ..db import engine
from ..logging_config import log
from ..net import request_context
from ..schemas import ActiveSessionDTO, RevokeOtherSessionsRequest
from ..security.auth_dep import Principal, get_principal
from ..security.origin import enforce_origin
from . import session_events
from ..dates import iso_z
from .session_presentation import device_label, ip_prefix, session_origins

router = APIRouter(prefix="/auth/sessions", tags=["sessions"])


@router.get("", response_model=list[ActiveSessionDTO])
async def list_sessions(
    principal: Principal = Depends(get_principal),
) -> list[ActiveSessionDTO]:
    """The caller's own active sessions in their CURRENT org membership.

    Scoped implicitly: refresh_tokens.user_id is one org membership (see
    service.py's note on `users` being per-membership, not per-person), so
    this never needs a cross-org query or an extra org_id filter to stay
    within the caller's own data — switching org switches which family_ids
    even exist under this user_id.

    No "is this my current session" marker here — see ActiveSessionDTO's own
    doc comment for why that's a client-side concern (decode the access
    token's own `sid` claim) rather than something the server can answer
    correctly on every platform.
    """
    async with engine.connect() as conn:
        families = await service.list_active_sessions(conn, principal.user_id)
        if not families:
            return []
        family_ids = [f["familyId"] for f in families]
        await service.set_org_guc(conn, principal.org_id)
        origins = await session_origins(conn, principal.org_id, family_ids)

    return [
        ActiveSessionDTO(
            id=f["familyId"],
            createdAt=iso_z(f["createdAt"]),
            lastSeenAt=iso_z(f["lastSeenAt"]),
            device=device_label(origins.get(f["familyId"], {}).get("userAgent")),
            approxLocation=ip_prefix(origins.get(f["familyId"], {}).get("ip")),
        )
        for f in families
    ]


@router.delete(
    "/{family_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(enforce_origin)],
)
async def revoke_session(
    family_id: str,
    request: Request,
    principal: Principal = Depends(get_principal),
):
    """Revoke one of the caller's own sessions.

    404 (not 403) whether the family belongs to someone else or does not
    exist at all — see service.revoke_family_by_id for why that ambiguity is
    deliberate (IDOR: a revoke attempt must not be usable to probe whether
    another user's family id exists). Revokes the refresh-token family only;
    an already-issued access token for that session keeps working until its
    own 5-minute TTL expires, exactly as every other revoke path in this
    service already behaves (see config.py's note on why access tokens are
    not denylisted) — the live WebSocket disconnect (ws-gateway, driven by the
    session.revoked event emitted below) is the additional enforcement layer
    for that gap, not this endpoint.
    """
    ip, user_agent, request_id = request_context(request)
    async with engine.begin() as conn:
        # revoke_family_by_id itself needs no org context (refresh_tokens has
        # no RLS), but the audit write inside session_revoked() below is a
        # write to audit_log, which is RLS ENABLE+FORCE and needs it.
        await service.set_org_guc(conn, principal.org_id)
        revoked = await service.revoke_family_by_id(conn, principal.user_id, family_id)
        if revoked:
            await session_events.session_revoked(
                conn,
                principal.org_id,
                principal.user_id,
                session_id=family_id,
                actor_id=principal.user_id,
                by="self",
                ip=ip,
                user_agent=user_agent,
                request_id=request_id,
            )
    if not revoked:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found")
    log.info("session_revoked", user_id=principal.user_id, family_id=family_id, by="self")


@router.post(
    "/revoke-others",
    response_model=list[str],
    dependencies=[Depends(enforce_origin)],
)
async def revoke_other_sessions(
    body: RevokeOtherSessionsRequest,
    request: Request,
    principal: Principal = Depends(get_principal),
) -> list[str]:
    """Revoke every one of the caller's OTHER sessions in one call — the
    atomic counterpart to looping DELETE /auth/sessions/{id} once per row,
    which is what the "sign out of all other sessions" UI action did before
    this existed (N round trips, not atomic, and unable to correctly exclude
    "this device" on desktop/mobile — see ActiveSessionDTO's doc comment).

    `currentSessionId` is trusted from the request body with no server-side
    verification (unlike a raw refresh token, which is always verified by
    hash lookup) — safe specifically because this whole action is already
    scoped to the verified principal's own user_id via
    service.revoke_other_sessions: a caller can only ever misname one of ITS
    OWN sessions, never another user's. Omitted, it revokes literally every
    session, including whichever one made this call ("sign out everywhere").

    Returns the family ids actually revoked (may be empty — nothing to do is
    not an error).
    """
    keep = body.currentSessionId
    if keep is not None:
        try:
            keep = str(UUID(keep))
        except ValueError:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "currentSessionId must be a valid uuid"
            ) from None

    ip, user_agent, request_id = request_context(request)
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        revoked_ids = await service.revoke_other_sessions(conn, principal.user_id, keep)
        for family_id in revoked_ids:
            await session_events.session_revoked(
                conn,
                principal.org_id,
                principal.user_id,
                session_id=family_id,
                actor_id=principal.user_id,
                by="self",
                ip=ip,
                user_agent=user_agent,
                request_id=request_id,
            )
    log.info(
        "sessions_revoked_bulk",
        user_id=principal.user_id,
        count=len(revoked_ids),
        kept=keep,
    )
    return revoked_ids
