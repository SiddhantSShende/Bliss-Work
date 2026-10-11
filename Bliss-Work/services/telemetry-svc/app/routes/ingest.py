"""Client beacon ingest.

Every row written here is SELF-REPORTED. The JWT proves who is speaking; nothing
proves that what they say is true. That is why `source` is stored on every row
and rendered distinctly in the UI and the export — a Kafka-derived row is
evidence, a beacon row is a claim, and anyone using this screen to make a
decision about a person deserves to be able to tell them apart.

Consequently the handler trusts nothing from the body beyond its shape: the
timestamp is clamped, the org and user come from the verified token (never the
payload), and the batch size and every field length are bounded by the schema.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import text

from ..audit_forward import AuditForwardError, file_audit_event, forward_file_events
from ..auth import Principal, require_principal
from ..db import session, set_org_context
from ..ingest import SECURITY_MIRROR_ACTIONS, ActivityRow, clamp_occurred_at, insert_events, security_mirror_of
from ..logging_setup import log
from ..rate_limit import limiter
from ..schemas import Beacon, BeaconAck
from .. import sessions as sess

router = APIRouter(prefix="/telemetry", tags=["ingest"])

# Categories a CLIENT may claim. 'server' is reserved for Kafka-derived rows and
# 'auth' for auth-svc's own events — a client asserting either would be putting
# unforgeable-looking rows into the record.
#
# 'security' is where a client reports a control it enforced locally, and today
# that means one thing: a refused screen-capture attempt (see
# packages/app/src/lib/screenGuard.ts). It is self-reported like everything else
# here, and the row's `source` says so — a screenshot is taken by the operating
# system from pixels on the user's own machine, so no server can witness one.
# The record is therefore evidence that the CLIENT saw and refused an attempt,
# never proof that no capture occurred, and the UI must not imply otherwise.
_CLIENT_CATEGORIES = {"navigation", "engagement", "app", "site", "security"}


@router.post("/beacon", response_model=BeaconAck)
@limiter.limit("120/minute")
async def beacon(
    request: Request,
    response: Response,  # required by slowapi (headers_enabled) to inject rate-limit headers
    body: Beacon,
    principal: Principal = Depends(require_principal),
) -> BeaconAck:
    """Accept one batch from a client instance and advance its session."""
    now = sess.utcnow()
    ua = request.headers.get("user-agent")
    ip = _client_ip(request)

    async with session() as db:
        await set_org_context(db, principal.org_id)

        # Claim this batch's activeMs/idleMs delta before accruing it — a
        # retry of the exact same batch (same clientEventId, see
        # telemetryQueue.ts's pendingRetry) must not add the same time twice.
        # No clientEventId (an older client) means no claim to make, so the
        # accrual always applies, same as before this existed. See
        # migrations/0009_beacon_batch_idempotency.sql.
        active_ms, idle_ms = body.activeMs, body.idleMs
        if body.clientEventId:
            claimed = await db.execute(
                text(
                    "INSERT INTO beacon_batches (org_id, user_id, client_event_id) "
                    "VALUES (:org, :uid, :ceid) ON CONFLICT DO NOTHING"
                ),
                {"org": principal.org_id, "uid": principal.user_id, "ceid": body.clientEventId},
            )
            if not claimed.rowcount:
                log.info("beacon_batch_duplicate_skipped", client_event_id=body.clientEventId)
                active_ms, idle_ms = 0, 0

        session_id = await sess.open_or_touch(
            db,
            session_id=body.sessionId,
            org_id=principal.org_id,
            user_id=principal.user_id,
            source=body.source,
            at=now,
            active_ms=active_ms,
            idle_ms=idle_ms,
            user_agent=ua,
            ip=ip,
        )

        # The file security actions are derived below, never accepted: see
        # ingest.security_mirror_of. A client naming one is dropped, not trusted.
        offered = [e for e in body.events if e.action not in SECURITY_MIRROR_ACTIONS]
        if len(offered) != len(body.events):
            log.info("beacon_reserved_action_dropped", dropped=len(body.events) - len(offered))
        rows = [
            ActivityRow(
                org_id=principal.org_id,
                user_id=principal.user_id,
                session_id=session_id,
                occurred_at=clamp_occurred_at(_parse(e.occurredAt), now),
                source=body.source,
                category=e.category if e.category in _CLIENT_CATEGORIES else "navigation",
                action=e.action,
                surface=e.surface,
                target_kind=e.targetKind,
                target_id=e.targetId,
                duration_ms=e.durationMs,
                detail=dict(e.detail or {}),
                client_event_id=e.clientEventId,
            )
            for e in offered
        ]
        # One security row per file open/download, written in the SAME call so the
        # pair lands (or is skipped as a retry) together.
        mirrors = [m for m in (security_mirror_of(r) for r in rows) if m is not None]
        inserted = await insert_events(db, rows + mirrors)
        # `accepted` is what the client OFFERED that landed; the derived rows are
        # ours and must not make a 1-event batch report 2.
        offered_ids = {id(r) for r in rows}
        accepted = sum(1 for i in inserted if id(i.row) in offered_ids)

        if body.ended:
            # The client said goodbye (pagehide / sign-out). Close precisely
            # rather than leaving it for the sweeper three minutes later.
            await sess.close(
                db, session_id=session_id, org_id=principal.org_id,
                user_id=principal.user_id, reason="disconnect", at=now,
            )
        await db.commit()

    # Every file act is ALSO reported to auth-svc's audit log (the member-detail
    # Security tab). After the commit, so a failed audit call cannot roll back
    # the activity rows; and a failure fails the beacon, so the client resends
    # the batch and the report is retried (auth-svc writes one row per eventId).
    inserted_ids = {id(i.row): i.id for i in inserted}
    audit_events = [
        file_audit_event(
            m,
            event_id,
            auth_session_id=principal.session_id,
            ip=ip,
            user_agent=ua,
            request_id=request.headers.get("x-request-id"),
        )
        for m in mirrors
        if (event_id := m.client_event_id or inserted_ids.get(id(m)))
    ]
    try:
        await forward_file_events(principal.org_id, audit_events)
    except AuditForwardError:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "audit record unavailable, retry"
        ) from None

    return BeaconAck(sessionId=session_id, accepted=accepted)


def _client_ip(request: Request) -> str | None:
    """The caller's address as seen past our own proxy.

    Reads the LAST X-Forwarded-For entry, not the first: everything before it was
    supplied by the client and is trivially spoofable, while the last hop is the
    one our own edge appended. Falls back to the socket peer when the header is
    absent (direct connection in dev).
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        parts = [p.strip() for p in xff.split(",") if p.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else None


def _parse(value: str | None):
    from datetime import datetime

    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        log.info("beacon_bad_timestamp", value=value[:40])
        return None
