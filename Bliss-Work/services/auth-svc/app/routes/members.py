"""Member administration: list, change role, suspend, reactivate, remove.

Deliberately membership-scoped. None of these endpoints touch `identities` —
one identity row is the credential shared across every org that person belongs
to, so letting org A's admin disable it would lock the user out of org B. An
admin governs their own workspace and nothing beyond it. Full account deletion
stays with the account owner (routes/account_service.py) or a support runbook.
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import text

from .. import service
from ..db import engine
from ..logging_config import log
from ..net import request_context
from ..schemas import (
    ActiveSessionDTO,
    AuditEntryDTO,
    AuditPage,
    ChangeRoleRequest,
    MemberDTO,
)
from ..security.auth_dep import Principal, require_org_admin
from ..security.origin import enforce_origin
from . import session_events
from .invites_service import iso_z
from .members_service import change_role_tx, load_member, load_members_for_org, set_status_tx
from .session_presentation import device_label, ip_prefix, session_origins

router = APIRouter(prefix="/auth", tags=["members"])

# Acting on yourself is refused outright rather than merely guarded. It is not a
# safety net that needs to be clever: every self-action an admin might attempt
# here — demote, suspend, remove — either locks them out of the workspace they
# were administering or is better expressed as "ask another admin". Refusing all
# three also subsumes the last-admin case with a message that says what to do.
_SELF_ACTION = "you cannot do this to your own account — ask another admin"


def _reject_self(principal: Principal, user_id: str) -> None:
    if user_id == principal.user_id:
        raise HTTPException(status.HTTP_409_CONFLICT, _SELF_ACTION)


@router.get("/members", response_model=list[MemberDTO])
async def list_members(
    limit: int | None = Query(default=None, ge=1, le=2000),
    principal: Principal = Depends(require_org_admin),
) -> list[MemberDTO]:
    """Every membership in the org INCLUDING suspended and removed ones — this
    is the screen from which they are reactivated, so hiding them would strand
    them.

    Used to be a `SELECT id` plus one `load_member()` round trip per row — 3+
    queries per member, unbounded. `load_members_for_org` answers this in two
    queries total regardless of member count (see its docstring).

    `limit` is optional and not sent by the current SPA (`packages/app/src/
    routes/MemberDetail.tsx`, via `client.ts`'s `listMembers()`), which still
    expects a bare array of every member; omitting it preserves that exact
    response. A caller that does not need the whole roster can pass it to cap
    the result. Real keyset
    pagination like `list_audit`'s below is left for whoever next wires the
    frontend to consume it — this endpoint's order (active first, then
    alphabetical) is not a single monotonic key the way `audit_log.id` is, so
    a cursor would need to encode both.
    """
    async with engine.connect() as conn:
        await service.set_org_guc(conn, principal.org_id)
        return await load_members_for_org(conn, principal.org_id, limit=limit)


@router.patch(
    "/members/{user_id}/role",
    response_model=MemberDTO,
    dependencies=[Depends(enforce_origin)],
)
async def change_role(
    request: Request,
    user_id: str,
    body: ChangeRoleRequest,
    principal: Principal = Depends(require_org_admin),
) -> MemberDTO:
    _reject_self(principal, user_id)
    ip, user_agent, request_id = request_context(request)
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        member = await change_role_tx(
            conn, principal, user_id, body.role,
            ip=ip, user_agent=user_agent, request_id=request_id,
        )
    log.info(
        "member_role_changed",
        org_id=principal.org_id,
        actor_id=principal.user_id,
        user_id=user_id,
        role=body.role,
    )
    return member


@router.post(
    "/members/{user_id}/deactivate",
    response_model=MemberDTO,
    dependencies=[Depends(enforce_origin)],
)
async def deactivate_member(
    request: Request,
    user_id: str, principal: Principal = Depends(require_org_admin)
) -> MemberDTO:
    """Suspend: the membership survives, every session dies, login is refused
    with a message that names the reason. Fully reversible."""
    _reject_self(principal, user_id)
    ip, user_agent, request_id = request_context(request)
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        member = await set_status_tx(
            conn, principal, user_id, "suspended",
            ip=ip, user_agent=user_agent, request_id=request_id,
        )
    log.info("member_deactivated", org_id=principal.org_id, user_id=user_id)
    return member


@router.post(
    "/members/{user_id}/reactivate",
    response_model=MemberDTO,
    dependencies=[Depends(enforce_origin)],
)
async def reactivate_member(
    request: Request,
    user_id: str, principal: Principal = Depends(require_org_admin)
) -> MemberDTO:
    _reject_self(principal, user_id)
    ip, user_agent, request_id = request_context(request)
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        member = await set_status_tx(
            conn, principal, user_id, "active",
            ip=ip, user_agent=user_agent, request_id=request_id,
        )
    log.info("member_reactivated", org_id=principal.org_id, user_id=user_id)
    return member


@router.delete(
    "/members/{user_id}",
    response_model=MemberDTO,
    dependencies=[Depends(enforce_origin)],
)
async def remove_member(
    request: Request,
    user_id: str, principal: Principal = Depends(require_org_admin)
) -> MemberDTO:
    """Remove from the workspace. A soft revoke, never a DELETE: their messages,
    tasks, channel rows and audit entries all reference this user_id, and the
    history has to keep rendering their name. Re-invitable afterwards."""
    _reject_self(principal, user_id)
    ip, user_agent, request_id = request_context(request)
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        member = await set_status_tx(
            conn, principal, user_id, "removed",
            ip=ip, user_agent=user_agent, request_id=request_id,
        )
    log.info("member_removed", org_id=principal.org_id, user_id=user_id)
    return member


@router.get("/members/{user_id}/sessions", response_model=list[ActiveSessionDTO])
async def list_member_sessions(
    user_id: str, principal: Principal = Depends(require_org_admin)
) -> list[ActiveSessionDTO]:
    """A member's active sessions, for an org admin. Identical shape to the
    self-service GET /auth/sessions — ActiveSessionDTO carries no
    "is this my session" marker at all (see its own doc comment), so there's
    nothing here to omit or get wrong: this is simply never the admin's own
    session either way.

    `load_member` 404s if `user_id` is not a member of the ADMIN'S org, which
    is what keeps this from leaking another org's sessions: `user_id` values
    are globally unique but each belongs to exactly one org, and an admin who
    guesses a foreign user_id gets the same 404 as a nonexistent one.
    """
    async with engine.connect() as conn:
        await service.set_org_guc(conn, principal.org_id)
        await load_member(conn, principal.org_id, user_id)
        families = await service.list_active_sessions(conn, user_id)
        if not families:
            return []
        origins = await session_origins(
            conn, principal.org_id, [f["familyId"] for f in families]
        )
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
    "/members/{user_id}/sessions/{family_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(enforce_origin)],
)
async def revoke_member_session(
    user_id: str, family_id: str, request: Request, principal: Principal = Depends(require_org_admin)
):
    """Revoke one of a member's sessions. Refused on yourself — same reasoning
    as every other self-action in this file (`_reject_self`): use the
    self-service DELETE /auth/sessions/{id} instead, which doesn't require
    the org_admin role.

    `load_member` confines `user_id` to the admin's own org (same as the GET
    above) BEFORE the revoke runs, so `service.revoke_family_by_id` — which
    only checks `family_id AND user_id` — cannot be pointed at a family that
    happens to share an id with one in another org: the id space is a UUID,
    but the org check here is what makes a guess unreachable, not luck.
    """
    _reject_self(principal, user_id)
    ip, user_agent, request_id = request_context(request)
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        await load_member(conn, principal.org_id, user_id)
        revoked = await service.revoke_family_by_id(conn, user_id, family_id)
        if revoked:
            await session_events.session_revoked(
                conn,
                principal.org_id,
                user_id,
                session_id=family_id,
                actor_id=principal.user_id,
                by="admin",
                ip=ip,
                user_agent=user_agent,
                request_id=request_id,
            )
    if not revoked:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found")
    log.info(
        "session_revoked",
        org_id=principal.org_id,
        actor_id=principal.user_id,
        user_id=user_id,
        family_id=family_id,
        by="admin",
    )


@router.get("/audit", response_model=AuditPage)
async def list_audit(
    before: str | None = Query(default=None, max_length=64),
    limit: int = Query(default=50, ge=1, le=200),
    action: str | None = Query(default=None, max_length=64),
    targetId: str | None = Query(default=None, max_length=64),
    principal: Principal = Depends(require_org_admin),
) -> AuditPage:
    """The org's audit trail, newest first.

    The hash-chained `audit_log` has existed since 0004 with a verifier and no
    way to read it — every entry written since was invisible outside psql. This
    is that read path. Keyset-paginated on id (`before`) — a UUIDv7 as of
    migrations/0018_audit_log_uuid_id.sql, still time-ordered, so the existing
    (org_id, id) chain index still serves this exactly as it did for the old
    bigserial id.
    """
    if before is not None:
        try:
            before = str(UUID(before))
        except ValueError:
            # Same idiom as directory_service.parse_user_ids: reject a
            # malformed cursor here rather than let it reach the CAST below,
            # which raises a raw asyncpg error the generic handler turns into
            # an unhelpful 500 for what is plainly bad client input.
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "before must be a valid uuid"
            ) from None
    async with engine.connect() as conn:
        await service.set_org_guc(conn, principal.org_id)
        rows = (
            await conn.execute(
                text(
                    """
                    SELECT id, actor_id, action, target, meta, at
                    FROM audit_log
                    WHERE org_id = :org
                      -- CAST: on the first page (and on every call without a
                      -- filter) these are NULL, and asyncpg cannot infer a
                      -- type for a parameter that only ever appears against
                      -- NULL (see telemetry-svc's timeline endpoint for the
                      -- same idiom). Without the CAST on action/target this
                      -- raised AmbiguousParameterError on every call that
                      -- didn't pass them — which is every call today, since
                      -- no caller sends either filter yet.
                      AND (CAST(:before AS uuid) IS NULL OR id < CAST(:before AS uuid))
                      AND (CAST(:action AS text) IS NULL OR action = CAST(:action AS text))
                      AND (CAST(:target AS text) IS NULL OR target = CAST(:target AS text))
                    ORDER BY id DESC
                    LIMIT :lim
                    """
                ),
                {
                    "org": principal.org_id,
                    "before": before,
                    "action": action,
                    "target": targetId,
                    "lim": limit + 1,
                },
            )
        ).all()
    page = rows[:limit]
    return AuditPage(
        entries=[
            AuditEntryDTO(
                id=str(r.id),
                actorId=str(r.actor_id) if r.actor_id else None,
                action=r.action,
                target=r.target,
                meta=r.meta,
                at=iso_z(r.at),
            )
            for r in page
        ],
        # One extra row was fetched purely to answer "is there more?" without a
        # second COUNT query over a table that only grows.
        nextCursor=str(page[-1].id) if len(rows) > limit and page else None,
    )
