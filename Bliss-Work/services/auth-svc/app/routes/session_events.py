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

── ip / user_agent / request_id / session_id (Phase 9) ──────────────────────
Folded into the existing `meta` dict rather than new bare columns on
audit_log: `_audit_entry_hash` hashes exactly six fixed positional fields
(one of which is `meta_json`), so routing new context through `meta` is
automatically covered by the existing tamper-evidence and needs no change to
the hash function or verify_audit_chain — a historical row simply lacks
these keys. `session_id` is the refresh-token family id `build_session`
already generates, not a new concept. `ip`/`user_agent` come from the
caller's `Request` via `app/net.py`'s `client_ip` (the same trusted-proxy
model rate limiting already uses — never re-derive this a second way).
`request_id` is read from the same `X-Request-Id` header
`rate_limit.py`'s handler already reads. NEVER put a password, raw token, or
JWT into this data. See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 9.
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from .. import service
from ..events.outbox import TOPIC_AUTH, build_event, enqueue_event


def context_meta(
    *,
    session_id: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
    request_id: str | None = None,
    **extra: object,
) -> dict:
    """Build the audit `meta` dict, omitting any field the caller didn't have
    (a request-less internal call, or a request missing the header) rather
    than writing null placeholders."""
    meta: dict[str, object] = dict(extra)
    if session_id:
        meta["sessionId"] = session_id
    if ip:
        meta["ip"] = ip
    if user_agent:
        meta["userAgent"] = user_agent
    if request_id:
        meta["requestId"] = request_id
    return meta


async def session_started(
    conn: AsyncConnection,
    org_id: str,
    user_id: str,
    *,
    session_id: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
    request_id: str | None = None,
) -> None:
    await _emit(conn, "user.session.started", org_id, user_id)
    await service.write_audit(
        conn,
        org_id=org_id,
        actor_id=user_id,
        action="auth.login",
        target=user_id,
        meta=context_meta(
            session_id=session_id, ip=ip, user_agent=user_agent, request_id=request_id
        ),
    )


async def session_ended(
    conn: AsyncConnection,
    org_id: str,
    user_id: str,
    *,
    audit: bool = True,
    session_id: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
    request_id: str | None = None,
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
            conn,
            org_id=org_id,
            actor_id=user_id,
            action="auth.logout",
            target=user_id,
            meta=context_meta(
                session_id=session_id, ip=ip, user_agent=user_agent, request_id=request_id
            ),
        )


async def session_revoked(
    conn: AsyncConnection,
    org_id: str,
    user_id: str,
    *,
    session_id: str,
    actor_id: str,
    by: str,
    ip: str | None = None,
    user_agent: str | None = None,
    request_id: str | None = None,
) -> None:
    """A specific session (refresh-token family) was revoked outside the
    ordinary logout flow — via routes/sessions.py (self-service, `by="self"`,
    `actor_id == user_id`) or routes/members.py's admin variant (`by="admin"`,
    `actor_id` is the ADMIN, distinct from `user_id`, the session's owner).
    Unlike `session_ended` (fired only by /auth/logout, where the caller's OWN
    active session just ended) this fires for revoking ANY session, including
    ones that are not the caller's current one.

    The `session.revoked` event is what lets a live WebSocket be closed
    promptly instead of waiting out its access token's TTL or the next ping's
    expiry check — see services/ws-gateway/internal/events. That is an
    ADDITIONAL enforcement layer, not the source of truth: the revoke itself
    (refresh_tokens.revoked, already committed by the caller before this runs)
    is what actually stops the session; this event only shortens how long an
    already-open socket stays connected after that. `userId` on the event is
    always the session's OWNER (`user_id`), never the admin — that is whose
    socket ws-gateway needs to find.
    """
    await _emit(conn, "session.revoked", org_id, user_id, sessionId=session_id, by=by)
    await service.write_audit(
        conn,
        org_id=org_id,
        actor_id=actor_id,
        action="auth.session_revoked",
        target=user_id,
        meta=context_meta(
            session_id=session_id, ip=ip, user_agent=user_agent, request_id=request_id, by=by
        ),
    )


async def org_switched(
    conn: AsyncConnection,
    org_id: str,
    user_id: str,
    from_org_id: str,
    *,
    session_id: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
    request_id: str | None = None,
) -> None:
    """A switch ENDS the activity session in the org being left and STARTS one
    in the org being entered — `user_sessions.org_id` makes them two different
    rows, and a single "switched" event would leave the first one open forever."""
    await _emit(conn, "user.org_switched", org_id, user_id, fromOrgId=from_org_id)
    await service.write_audit(
        conn,
        org_id=org_id,
        actor_id=user_id,
        action="auth.org_switched",
        target=user_id,
        meta=context_meta(
            session_id=session_id,
            ip=ip,
            user_agent=user_agent,
            request_id=request_id,
            **{"from": from_org_id},
        ),
    )


async def login_failed(
    conn: AsyncConnection,
    identity_id: str,
    *,
    ip: str | None = None,
    user_agent: str | None = None,
    request_id: str | None = None,
) -> None:
    """Record a failed sign-in against the identity's home org.

    A failed login has no org context — the caller never got far enough to pick
    one — so this resolves the identity's most recent membership and attributes
    it there. An identity with no membership at all is not recorded: there is no
    tenant whose audit trail it belongs in, and inventing one would put a
    stranger's failed attempt into somebody's compliance record.

    Runs in the login transaction, which is already under `bypass_rls` for the
    cross-org identity lookup — that is what lets it write an audit row for an
    org the request was never scoped to. No `session_id` — a failed login never
    reaches build_session, so there is no family id to attribute it to.
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
        conn,
        org_id=str(org_id),
        actor_id=None,
        action="auth.login_failed",
        target=None,
        meta=context_meta(
            ip=ip,
            user_agent=user_agent,
            request_id=request_id,
            **{"identityId": identity_id},
        ),
    )


async def _emit(conn: AsyncConnection, event_type: str, org_id: str, user_id: str, **extra) -> None:
    await enqueue_event(
        conn,
        topic=TOPIC_AUTH,
        kafka_key=user_id,
        event=build_event(event_type, org_id, userId=user_id, **extra),
    )
