"""Organization deletion: request, cancel, and read the pending state.

The QA report asked for an org to be auto-deleted once its last member is
removed. That is not what this implements, deliberately, and the reasoning is
worth having in one place:

  * The state is unreachable by construction. `members.py::_reject_self` stops
    an admin acting on their own account and `would_orphan_org` refuses any
    change leaving zero active admins, so reaching "no members" means removing
    the invariant that keeps an org administerable.
  * Removal is REVERSIBLE. It is a soft revoke that reactivation undoes
    (`set_status_tx`), so an admin who removes their last colleague has said
    nothing at all about wanting the workspace destroyed.
  * It would be a denial-of-service primitive: one compromised admin account
    could erase a workspace's entire history in two clicks, with no second
    party and no delay.

So destruction is explicit, typed-confirmed, delayed and cancellable. The
"everyone is gone" case is still detected — `set_status_tx` writes an
`org.orphaned` audit entry — it simply does not act on it.

The purge itself is NOT here. It runs from `app/jobs/purge_orgs.py` on a timer,
because an irreversible cross-service deletion should not be something an HTTP
request can complete: a request that times out halfway leaves nobody holding
the outcome, and a scheduled job can be ordered after the nightly backup.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text

from .. import service
from ..config import settings
from ..db import engine
from ..events.outbox import TOPIC_AUTH, build_event, enqueue_event
from ..logging_config import log
from ..schemas import DeleteOrgRequest, OrgLifecycleDTO, OrgMfaSettingsDTO, OrgMfaSettingsRequest
from ..security.auth_dep import Principal, require_org_admin
from ..security.origin import enforce_origin
from .invites_service import iso_z
from .members_service import require_live_admin

router = APIRouter(prefix="/auth", tags=["org"])


async def _load(conn, org_id: str) -> OrgLifecycleDTO:
    row = (
        await conn.execute(
            text(
                "SELECT id, name, slug, delete_requested_at, purge_after, deleted_at "
                "FROM orgs WHERE id = :org"
            ),
            {"org": org_id},
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "organization not found")
    return OrgLifecycleDTO(
        id=str(row.id),
        name=row.name,
        slug=row.slug,
        deleteRequestedAt=iso_z(row.delete_requested_at) if row.delete_requested_at else None,
        purgeAfter=iso_z(row.purge_after) if row.purge_after else None,
        deletedAt=iso_z(row.deleted_at) if row.deleted_at else None,
    )


@router.get("/org", response_model=OrgLifecycleDTO)
async def get_org(principal: Principal = Depends(require_org_admin)) -> OrgLifecycleDTO:
    """The current org plus any pending deletion, for the countdown banner."""
    async with engine.connect() as conn:
        await service.set_org_guc(conn, principal.org_id)
        return await _load(conn, principal.org_id)


@router.post(
    "/org/delete",
    response_model=OrgLifecycleDTO,
    dependencies=[Depends(enforce_origin)],
)
async def request_delete(
    body: DeleteOrgRequest,
    principal: Principal = Depends(require_org_admin),
) -> OrgLifecycleDTO:
    """Schedule this organization for destruction after a grace period.

    Three guards, and each earns its place:

    `require_live_admin` re-reads the role from the DATABASE. The JWT claim
    survives a demotion for a full JWT_ACCESS_TTL_SECONDS — an hour, since that
    was raised from 900 to 3600 to cut auth-svc's refresh write rate — which is
    tolerable for ordinary reads and not tolerable for the single most
    consequential endpoint in the product. Raising the TTL made this guard
    matter four times as much, not less.

    The body must echo the org's slug. Typed confirmation is friction on
    purpose; an action with no undo after the grace period should not be one
    click from a misplaced cursor.

    Every token in the org is revoked immediately, so the workspace stops being
    usable the moment deletion is requested rather than appearing to work right
    up until the data vanishes.
    """
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        await require_live_admin(conn, principal)
        org = await _load(conn, principal.org_id)

        if org.deletedAt:
            raise HTTPException(status.HTTP_409_CONFLICT, "organization is already deleted")
        if org.purgeAfter:
            return org  # idempotent: already scheduled, same answer

        if body.slug.strip() != (org.slug or ""):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "type the organization's slug exactly to confirm deletion",
            )

        purge_after = datetime.now(timezone.utc) + timedelta(
            days=settings.org_delete_grace_days
        )
        await conn.execute(
            text(
                "UPDATE orgs SET delete_requested_at = now(), delete_requested_by = :by, "
                "purge_after = :after WHERE id = :org"
            ),
            {"by": principal.user_id, "after": purge_after, "org": principal.org_id},
        )

        # Sign everyone out now. Leaving sessions alive would let members keep
        # writing into a workspace that is scheduled to be destroyed, and every
        # one of those writes is data someone will later be surprised to lose.
        await conn.execute(
            text(
                "UPDATE refresh_tokens SET revoked_at = now() "
                "WHERE revoked_at IS NULL AND user_id IN "
                "(SELECT id FROM users WHERE org_id = :org)"
            ),
            {"org": principal.org_id},
        )

        await enqueue_event(
            conn,
            topic=TOPIC_AUTH,
            kafka_key=principal.org_id,
            event=build_event(
                "org.delete_requested",
                principal.org_id,
                actorId=principal.user_id,
                purgeAfter=iso_z(purge_after),
            ),
        )
        await service.write_audit(
            conn,
            org_id=principal.org_id,
            actor_id=principal.user_id,
            action="org.delete_requested",
            target=principal.org_id,
            meta={"purgeAfter": iso_z(purge_after)},
        )
        log.warning(
            "org_delete_requested",
            org_id=principal.org_id,
            actor_id=principal.user_id,
            purge_after=iso_z(purge_after),
        )
        return await _load(conn, principal.org_id)


@router.post(
    "/org/delete/cancel",
    response_model=OrgLifecycleDTO,
    dependencies=[Depends(enforce_origin)],
)
async def cancel_delete(
    principal: Principal = Depends(require_org_admin),
) -> OrgLifecycleDTO:
    """Call off a scheduled deletion. Valid right up until the purge runs.

    Note the ordering problem this cannot solve: the purge job and this endpoint
    race in the last moments before `purge_after`. The job re-reads the row
    inside its own transaction, so a cancel that COMMITS first wins cleanly and
    one that loses the race returns 409 below on the next read. What must never
    happen is a cancel that appears to succeed against an org already purged,
    which is why `deleted_at` is checked rather than assumed.
    """
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        await require_live_admin(conn, principal)
        org = await _load(conn, principal.org_id)

        if org.deletedAt:
            raise HTTPException(status.HTTP_409_CONFLICT, "organization is already deleted")
        if not org.purgeAfter:
            return org  # idempotent: nothing scheduled

        await conn.execute(
            text(
                "UPDATE orgs SET delete_requested_at = NULL, delete_requested_by = NULL, "
                "purge_after = NULL WHERE id = :org AND deleted_at IS NULL"
            ),
            {"org": principal.org_id},
        )
        await enqueue_event(
            conn,
            topic=TOPIC_AUTH,
            kafka_key=principal.org_id,
            event=build_event(
                "org.delete_cancelled", principal.org_id, actorId=principal.user_id
            ),
        )
        await service.write_audit(
            conn,
            org_id=principal.org_id,
            actor_id=principal.user_id,
            action="org.delete_cancelled",
            target=principal.org_id,
            meta=None,
        )
        log.info("org_delete_cancelled", org_id=principal.org_id, actor_id=principal.user_id)
        return await _load(conn, principal.org_id)


async def _load_mfa_settings(conn, org_id: str) -> OrgMfaSettingsDTO:
    row = (
        await conn.execute(
            text("SELECT require_mfa_for_admins, mfa_grace_period_ends_at FROM orgs WHERE id = :org"),
            {"org": org_id},
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "organization not found")
    return OrgMfaSettingsDTO(
        requireMfaForAdmins=bool(row.require_mfa_for_admins),
        mfaGracePeriodEndsAt=iso_z(row.mfa_grace_period_ends_at) if row.mfa_grace_period_ends_at else None,
    )


@router.get("/org/mfa", response_model=OrgMfaSettingsDTO)
async def get_mfa_settings(principal: Principal = Depends(require_org_admin)) -> OrgMfaSettingsDTO:
    """The mandatory-MFA-for-admins policy + grace-period deadline, for the
    settings screen (see docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 7)."""
    async with engine.connect() as conn:
        await service.set_org_guc(conn, principal.org_id)
        return await _load_mfa_settings(conn, principal.org_id)


@router.post(
    "/org/mfa",
    response_model=OrgMfaSettingsDTO,
    dependencies=[Depends(enforce_origin)],
)
async def set_mfa_settings(
    body: OrgMfaSettingsRequest, principal: Principal = Depends(require_org_admin)
) -> OrgMfaSettingsDTO:
    """Toggle the mandatory-MFA-for-admins policy.

    Turning it ON stamps a fresh grace-period deadline (mfa_grace_period_days
    out) — non-enrolled admins see a banner during the window and are blocked
    at the password step only once it passes (see mfa_service.mfa_gate).
    Turning it OFF clears the deadline outright: a policy that is off again
    should not leave a stale future date around for the next time it's
    switched back on.
    """
    async with engine.begin() as conn:
        await service.set_org_guc(conn, principal.org_id)
        await require_live_admin(conn, principal)
        grace_ends = (
            datetime.now(timezone.utc) + timedelta(days=settings.mfa_grace_period_days)
            if body.requireMfaForAdmins
            else None
        )
        await conn.execute(
            text(
                "UPDATE orgs SET require_mfa_for_admins = :req, mfa_grace_period_ends_at = :ends "
                "WHERE id = :org"
            ),
            {"req": body.requireMfaForAdmins, "ends": grace_ends, "org": principal.org_id},
        )
        await service.write_audit(
            conn,
            org_id=principal.org_id,
            actor_id=principal.user_id,
            action="org.mfa_policy_changed",
            target=principal.org_id,
            meta={"requireMfaForAdmins": body.requireMfaForAdmins},
        )
        log.info(
            "org_mfa_policy_changed",
            org_id=principal.org_id,
            actor_id=principal.user_id,
            require_mfa_for_admins=body.requireMfaForAdmins,
        )
        return await _load_mfa_settings(conn, principal.org_id)
