"""Transaction bodies for member administration (role, suspend, remove, leave).

Every function here assumes the caller has ALREADY scoped the transaction with
`service.set_org_guc(conn, org_id)` — `users`, `user_roles` and `audit_log` are
all RLS ENABLE+FORCE, so an unscoped call reads nothing and writes nothing. The
sole exception is `leave_org_tx`, which is cross-org by nature and says so.

Two invariants are enforced here rather than in the route layer, because both
need to hold across the read-then-write window inside one transaction:

  1. An org can never be left with zero active admins.
  2. The caller is still an org_admin *right now*, not merely according to a
     15-minute-old JWT claim.
"""
from __future__ import annotations

from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from .. import service
from ..events.outbox import TOPIC_AUTH, build_event, enqueue_event
from ..schemas import MemberDTO
from .invites_service import iso_z


def _iso_or_none(dt: datetime | None) -> str | None:
    return iso_z(dt) if dt is not None else None


async def _lock_org_admins(conn: AsyncConnection, org_id: str) -> None:
    """Serialize admin-set changes for one org (txn-scoped, released at commit).

    Without it, two admins demoting each other concurrently BOTH read
    "2 admins remain, safe to proceed" and both commit — leaving an org nobody
    can administer. Same idiom as `service.write_audit`'s audit-chain lock; the
    two keys are always taken in this order (admins, then audit) so they cannot
    deadlock against each other.
    """
    await conn.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:k)::bigint)"),
        {"k": f"org_admins:{org_id}"},
    )


async def _lock_identity(conn: AsyncConnection, identity_id: str) -> None:
    """Serialize one identity's membership changes across ALL orgs.

    `_lock_org_admins` is per-org and cannot cover this: somebody leaving orgs A
    and B in two tabs takes two DIFFERENT org locks, so both transactions read
    "two memberships, one of them will remain" and both commit — leaving an
    identity with no membership at all. That is the single state the only-org
    refusal exists to prevent, and the one nobody can undo from inside the
    product, because a re-invite has to come from a member of some org.

    Taken BEFORE the org lock wherever both are held, so the ordering that keeps
    `_lock_org_admins` and the audit-chain lock deadlock-free extends to three.
    """
    await conn.execute(
        text("SELECT pg_advisory_xact_lock(hashtext(:k)::bigint)"),
        {"k": f"identity:{identity_id}"},
    )


def would_orphan_org(active_admin_ids: set[str], target_id: str) -> bool:
    """True when acting on `target_id` would leave the org with zero admins.

    Pure so the invariant can be tested without a database. Subtraction rather
    than a count comparison because the target may or may not currently be an
    admin: demoting a plain member must not be blocked just because the org has
    exactly one admin, and demoting the only admin must always be.
    """
    return not (active_admin_ids - {target_id})


async def _active_admin_ids(conn: AsyncConnection, org_id: str) -> set[str]:
    rows = (
        await conn.execute(
            text(
                """
                SELECT u.id
                FROM users u
                JOIN user_roles ur ON ur.user_id = u.id
                JOIN roles r ON r.id = ur.role_id
                WHERE u.org_id = :org AND u.status = 'active' AND r.name = 'org_admin'
                """
            ),
            {"org": org_id},
        )
    ).all()
    return {str(r.id) for r in rows}


async def require_live_admin(conn: AsyncConnection, principal) -> None:
    """Re-verify the caller's admin role against the DATABASE, not the token.

    `require_org_admin` reads the JWT claim, which is minted for ~15 minutes and
    therefore survives a demotion. That staleness is documented and acceptable
    for ordinary reads; it is not acceptable for the endpoints that grant and
    revoke power, where a just-demoted admin would otherwise get one last
    quarter-hour of authority.
    """
    roles = await service.roles_for_user(conn, principal.user_id)
    if "org_admin" not in roles:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "org_admin role required")


async def load_member(conn: AsyncConnection, org_id: str, user_id: str) -> MemberDTO:
    """Fetch one member of `org_id`, or 404. RLS already confines the query to
    the org; the explicit org_id predicate mirrors the check in GET /auth/users
    and keeps the intent readable."""
    row = (
        await conn.execute(
            text(
                "SELECT id, username, status, email_verified, created_at, removed_at "
                "FROM users WHERE id = :id AND org_id = :org"
            ),
            {"id": user_id, "org": org_id},
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "member not found")
    dto = await service.user_dto(conn, user_id)
    if dto is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "member not found")
    return MemberDTO(
        id=dto.id,
        username=dto.username,
        displayName=dto.displayName,
        email=dto.email,
        roles=dto.roles,
        status=row.status,
        emailVerified=bool(row.email_verified),
        createdAt=iso_z(row.created_at),
        removedAt=_iso_or_none(row.removed_at),
        avatarUrl=dto.avatarUrl,
    )


async def change_role_tx(conn: AsyncConnection, principal, user_id: str, role: str) -> MemberDTO:
    await _lock_org_admins(conn, principal.org_id)
    await require_live_admin(conn, principal)
    member = await load_member(conn, principal.org_id, user_id)
    if member.status != "active":
        raise HTTPException(
            status.HTTP_409_CONFLICT, "reactivate this member before changing their role"
        )
    current = set(member.roles)
    if role in current and len(current) == 1:
        return member  # already exactly this role — idempotent no-op

    if role != "org_admin":
        admins = await _active_admin_ids(conn, principal.org_id)
        if would_orphan_org(admins, user_id):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "this is the last admin — promote someone else first",
            )

    rid = await service.role_id(conn, role)
    await conn.execute(
        text("DELETE FROM user_roles WHERE user_id = :uid"), {"uid": user_id}
    )
    await conn.execute(
        text(
            "INSERT INTO user_roles (user_id, role_id, org_id) VALUES (:uid, :rid, :org)"
        ),
        {"uid": user_id, "rid": rid, "org": principal.org_id},
    )

    # Roles live INSIDE the access token, so the change is invisible until the
    # target's next refresh. Revoking every family forces that refresh to fail,
    # which the client treats as terminal and turns into a clean re-login with
    # freshly minted claims.
    await service.revoke_all_user_tokens(conn, user_id)
    await _emit(
        conn, principal.org_id, principal.user_id, "user.role_changed", user_id, roles=[role]
    )
    await service.write_audit(
        conn,
        org_id=principal.org_id,
        actor_id=principal.user_id,
        action="member.role_changed",
        target=user_id,
        meta={"from": sorted(current), "to": role},
    )
    return await load_member(conn, principal.org_id, user_id)


async def _apply_status(
    conn: AsyncConnection, org_id: str, user_id: str, new_status: str
) -> None:
    """Flip `users.status` and apply the side effects the new value implies.

    Shared by an admin changing someone else's status and by a member leaving of
    their own accord: what it means for a `users` row to become `removed` does
    not depend on who asked for it.
    """
    await conn.execute(
        text(
            "UPDATE users SET status = :s, "
            "removed_at = CASE WHEN :s = 'removed' THEN now() ELSE NULL END "
            "WHERE id = :id AND org_id = :org"
        ),
        {"s": new_status, "id": user_id, "org": org_id},
    )

    if new_status == "removed":
        # Drop the role grant so a re-invite starts from a clean slate, and stop
        # `last_user_id` pointing at a membership that can no longer be opened —
        # otherwise the next login lands on a dead org before falling back.
        await conn.execute(
            text("DELETE FROM user_roles WHERE user_id = :uid"), {"uid": user_id}
        )
        await conn.execute(
            text(
                "UPDATE identities SET last_user_id = NULL WHERE last_user_id = :uid"
            ),
            {"uid": user_id},
        )

    if new_status == "active":
        # Reactivating a REMOVED member restores the default role: the grant was
        # dropped on removal, and a member with no role would pass every
        # is-admin check by absence rather than by intent.
        existing = await service.roles_for_user(conn, user_id)
        if not existing:
            rid = await service.role_id(conn, "member")
            await conn.execute(
                text(
                    "INSERT INTO user_roles (user_id, role_id, org_id) "
                    "VALUES (:uid, :rid, :org)"
                ),
                {"uid": user_id, "rid": rid, "org": org_id},
            )
    else:
        await service.revoke_all_user_tokens(conn, user_id)


async def set_status_tx(
    conn: AsyncConnection, principal, user_id: str, new_status: str
) -> MemberDTO:
    """Suspend, reactivate, or remove. All three are the same shape: flip
    `users.status`, kill every live session, emit, audit."""
    await _lock_org_admins(conn, principal.org_id)
    await require_live_admin(conn, principal)
    member = await load_member(conn, principal.org_id, user_id)
    if member.status == new_status:
        return member  # idempotent

    if new_status != "active":
        admins = await _active_admin_ids(conn, principal.org_id)
        if would_orphan_org(admins, user_id):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "this is the last admin — promote someone else first",
            )

    await _apply_status(conn, principal.org_id, user_id, new_status)

    event, action = {
        "suspended": ("user.deactivated", "member.deactivated"),
        "removed": ("user.removed", "member.removed"),
        "active": ("user.reactivated", "member.reactivated"),
    }[new_status]
    await _emit(conn, principal.org_id, principal.user_id, event, user_id)
    await service.write_audit(
        conn,
        org_id=principal.org_id,
        actor_id=principal.user_id,
        action=action,
        target=user_id,
        meta={"from": member.status, "to": new_status},
    )
    await _note_if_orphaned(conn, principal.org_id, principal.user_id)
    return await load_member(conn, principal.org_id, user_id)


async def leave_org_tx(conn: AsyncConnection, identity_id: str, org_id: str) -> str:
    """Give up the caller's OWN membership in `org_id`, returning the users row
    that was left. The self-service twin of `set_status_tx(..., "removed")`.

    The one function in this module that expects `service.set_bypass_rls` rather
    than `set_org_guc`, and it has to be: somebody can leave a workspace they are
    not currently signed in to, and whether they may leave at all depends on the
    memberships their identity holds in OTHER orgs. Every write below is still
    confined to `org_id` by an explicit predicate.

    Two refusals, each because the alternative strands somebody:

      * the last active admin leaving would leave the workspace with nobody able
        to administer it — the same invariant `set_status_tx` enforces, reached
        from the other side;
      * leaving the only remaining membership would leave the identity with
        nowhere to sign in, and no in-product way back: an invitation has to come
        from a member of some org, and there would no longer be one. Giving up
        the last workspace is deleting it (routes/org_lifecycle.py) or deleting
        the account, both of which say so plainly.
    """
    await _lock_identity(conn, identity_id)
    await _lock_org_admins(conn, org_id)
    memberships = await service.memberships_for_identity(conn, identity_id)
    leaving = next((m for m in memberships if m["orgId"] == org_id), None)
    if leaving is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "not a member of that organization"
        )
    if len(memberships) == 1:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "this is your only organization — you cannot leave it",
        )

    user_id = str(leaving["userId"])
    admins = await _active_admin_ids(conn, org_id)
    if would_orphan_org(admins, user_id):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "you are the last admin — promote someone else before leaving",
        )

    await _apply_status(conn, org_id, user_id, "removed")
    # `user.removed`, not a new `user.left`: to every consumer of the projection
    # this IS a removal, and a second event type would mean teaching each one to
    # treat the two identically.
    await _emit(conn, org_id, user_id, "user.removed", user_id)
    await service.write_audit(
        conn,
        org_id=org_id,
        actor_id=user_id,
        action="member.left",
        target=user_id,
        meta={"from": "active", "to": "removed"},
    )
    await _note_if_orphaned(conn, org_id, user_id)
    return user_id


async def _note_if_orphaned(conn: AsyncConnection, org_id: str, actor_id: str) -> None:
    """Record — and only record — that an org has no active members left.

    A DETECTOR, not an actor. The QA report asked for the org to be deleted
    automatically at this point; routes/org_lifecycle.py explains at length why
    that is the wrong shape, the short version being that removal is reversible
    and destruction is not.

    In practice `would_orphan_org` means this is nearly unreachable: the last
    admin can neither remove themselves, be removed, nor leave. It can still
    happen —
    an org whose only members are non-admins, all removed by an admin who was
    then suspended by another — and when it does, someone should be able to see
    it in the audit trail rather than discover it as a support ticket.
    """
    remaining = (
        await conn.execute(
            text("SELECT count(*) FROM users WHERE org_id = :org AND status = 'active'"),
            {"org": org_id},
        )
    ).scalar_one()
    if remaining:
        return
    await service.write_audit(
        conn,
        org_id=org_id,
        actor_id=actor_id,
        action="org.orphaned",
        target=org_id,
        meta={"activeMembers": 0},
    )


async def _emit(
    conn: AsyncConnection,
    org_id: str,
    actor_id: str,
    event_type: str,
    user_id: str,
    **extra,
) -> None:
    """Publish to `auth.events` from the same transaction as the state change.

    messaging-svc and task-svc keep `user_projection` mirrors that until now only
    ever learned about `user.created`; these are what let them mark a departed
    member inactive instead of showing them forever.
    """
    await enqueue_event(
        conn,
        topic=TOPIC_AUTH,
        kafka_key=user_id,
        event=build_event(
            event_type, org_id, userId=user_id, actorId=actor_id, **extra
        ),
    )
