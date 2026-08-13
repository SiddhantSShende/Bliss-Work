"""Member administration: list, change role, suspend, reactivate, remove.

Deliberately membership-scoped. None of these endpoints touch `identities` —
one identity row is the credential shared across every org that person belongs
to, so letting org A's admin disable it would lock the user out of org B. An
admin governs their own workspace and nothing beyond it. Full account deletion
stays with the account owner (routes/account_service.py) or a support runbook.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import text

from .. import service
from ..db import engine
from ..logging_config import log
from ..schemas import (
    AuditEntryDTO,
    AuditPage,
    ChangeRoleRequest,
    MemberDTO,
)
from ..security.auth_dep import Principal, require_org_admin
from ..security.origin import enforce_origin
from .invites_service import iso_z
from .members_service import change_role_tx, load_member, set_status_tx

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
    principal: Principal = Depends(require_org_admin),
) -> list[MemberDTO]:
    """Every membership in the org INCLUDING suspended and removed ones — this
    is the screen from which they are reactivated, so hiding them would strand
    them."""
    async with engine.connect() as conn:
        await service.set_org_guc(conn, principal.org_id)
        rows = (
            await conn.execute(
                text(
                    "SELECT id FROM users WHERE org_id = :org "
                    "ORDER BY (status = 'active') DESC, username"
                ),
                {"org": principal.org_id},
            )
        ).all()
        return [
            await load_member(conn, principal.org_id, str(r.id)) for r in rows
        ]


@router.patch(
    "/members/{user_id}/role",
    response_model=MemberDTO,
    dependencies=[Depends(enforce_origin)],
)
async def change_role(
    user_id: str,
    body: ChangeRoleRequest,
    principal: Principal = Depends(require_org_admin),
) -> MemberDTO:
    _reject_self(principal, user_id)
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        member = await change_role_tx(conn, principal, user_id, body.role)
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
    user_id: str, principal: Principal = Depends(require_org_admin)
) -> MemberDTO:
    """Suspend: the membership survives, every session dies, login is refused
    with a message that names the reason. Fully reversible."""
    _reject_self(principal, user_id)
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        member = await set_status_tx(conn, principal, user_id, "suspended")
    log.info("member_deactivated", org_id=principal.org_id, user_id=user_id)
    return member


@router.post(
    "/members/{user_id}/reactivate",
    response_model=MemberDTO,
    dependencies=[Depends(enforce_origin)],
)
async def reactivate_member(
    user_id: str, principal: Principal = Depends(require_org_admin)
) -> MemberDTO:
    _reject_self(principal, user_id)
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        member = await set_status_tx(conn, principal, user_id, "active")
    log.info("member_reactivated", org_id=principal.org_id, user_id=user_id)
    return member


@router.delete(
    "/members/{user_id}",
    response_model=MemberDTO,
    dependencies=[Depends(enforce_origin)],
)
async def remove_member(
    user_id: str, principal: Principal = Depends(require_org_admin)
) -> MemberDTO:
    """Remove from the workspace. A soft revoke, never a DELETE: their messages,
    tasks, channel rows and audit entries all reference this user_id, and the
    history has to keep rendering their name. Re-invitable afterwards."""
    _reject_self(principal, user_id)
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        member = await set_status_tx(conn, principal, user_id, "removed")
    log.info("member_removed", org_id=principal.org_id, user_id=user_id)
    return member


@router.get("/audit", response_model=AuditPage)
async def list_audit(
    before: int | None = Query(default=None, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
    action: str | None = Query(default=None, max_length=64),
    targetId: str | None = Query(default=None, max_length=64),
    principal: Principal = Depends(require_org_admin),
) -> AuditPage:
    """The org's audit trail, newest first.

    The hash-chained `audit_log` has existed since 0004 with a verifier and no
    way to read it — every entry written since was invisible outside psql. This
    is that read path. Keyset-paginated on the bigserial id (`before`), which
    the existing (org_id, id) chain index already serves.
    """
    async with engine.connect() as conn:
        await service.set_org_guc(conn, principal.org_id)
        rows = (
            await conn.execute(
                text(
                    """
                    SELECT id, actor_id, action, target, meta, at
                    FROM audit_log
                    WHERE org_id = :org
                      AND (:before IS NULL OR id < :before)
                      AND (:action IS NULL OR action = :action)
                      AND (:target IS NULL OR target = :target)
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
                id=int(r.id),
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
        nextCursor=int(page[-1].id) if len(rows) > limit and page else None,
    )
