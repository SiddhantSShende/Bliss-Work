"""Session lifecycle signals: the audit row and the bus event for each.

Until now `/auth/login`, `/auth/refresh` and `/auth/logout` wrote NOTHING —
no audit entry, no event, no timestamp. "When did this person last sign in"
was unanswerable from the data, which is the gap the member activity record
exists to close.

Two destinations, and they are not interchangeable:

  * `audit_log` — hash-chained, tamper-evident, org-scoped, never pruned. The
    security record: who signed in, who failed, who switched org.
  * `auth.events` on Kafka — consumed by telemetry-svc to build the activity
    timeline. Retained 90 days.

Both writes happen inside the caller's transaction, so a session that was
issued is always a session that was recorded.

Deliberately NOT emitted on `/auth/refresh`: that fires roughly four times an
hour per device and carries no information the heartbeat does not already have.
Recording it would quadruple the volume of the auth stream to say "still signed
in", which the session row already says.
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from .. import service
from ..events.outbox import TOPIC_AUTH, build_event, enqueue_event


async def session_started(conn: AsyncConnection, org_id: str, user_id: str) -> None:
    await _emit(conn, "user.session.started", org_id, user_id)
    await service.write_audit(
        conn, org_id=org_id, actor_id=user_id, action="auth.login", target=user_id
    )


async def session_ended(
    conn: AsyncConnection, org_id: str, user_id: str, *, audit: bool = True
) -> None:
    """`audit=False` emits the bus event without an audit row.

    Used by the org switch, which ends a session in one org and starts one in
    another inside a SINGLE transaction. `write_audit` takes a per-org advisory
    lock, so auditing both would have this transaction hold locks on two orgs at
    once — and a member switching A→B concurrently with another switching B→A
    would take them in opposite orders and deadlock. One audit row, written for
    the org being entered and naming the org being left, records the same fact
    with one lock.
    """
    await _emit(conn, "user.session.ended", org_id, user_id)
    if audit:
        await service.write_audit(
            conn, org_id=org_id, actor_id=user_id, action="auth.logout", target=user_id
        )


async def org_switched(
    conn: AsyncConnection, org_id: str, user_id: str, from_org_id: str
) -> None:
    """A switch ENDS the activity session in the org being left and STARTS one
    in the org being entered — `user_sessions.org_id` makes them two different
    rows, and a single "switched" event would leave the first one open forever."""
    await _emit(conn, "user.org_switched", org_id, user_id, fromOrgId=from_org_id)
    await service.write_audit(
        conn, org_id=org_id, actor_id=user_id, action="auth.org_switched",
        target=user_id, meta={"from": from_org_id},
    )


async def login_failed(conn: AsyncConnection, identity_id: str) -> None:
    """Record a failed sign-in against the identity's home org.

    A failed login has no org context — the caller never got far enough to pick
    one — so this resolves the identity's most recent membership and attributes
    it there. An identity with no membership at all is not recorded: there is no
    tenant whose audit trail it belongs in, and inventing one would put a
    stranger's failed attempt into somebody's compliance record.

    Runs in the login transaction, which is already under `bypass_rls` for the
    cross-org identity lookup — that is what lets it write an audit row for an
    org the request was never scoped to.
    """
    org_id = (
        await conn.execute(
            text(
                "SELECT org_id FROM users WHERE identity_id = :iid "
                "ORDER BY (status = 'active') DESC, created_at ASC LIMIT 1"
            ),
            {"iid": identity_id},
        )
    ).scalar()
    if org_id is None:
        return
    await service.write_audit(
        conn, org_id=str(org_id), actor_id=None, action="auth.login_failed",
        target=None, meta={"identityId": identity_id},
    )


async def _emit(conn: AsyncConnection, event_type: str, org_id: str, user_id: str, **extra) -> None:
    await enqueue_event(
        conn,
        topic=TOPIC_AUTH,
        kafka_key=user_id,
        event=build_event(event_type, org_id, userId=user_id, **extra),
    )
