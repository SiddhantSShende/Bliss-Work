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

from fastapi import APIRouter, Depends, Request, Response

from ..auth import Principal, require_principal
from ..db import session, set_org_context
from ..ingest import ActivityRow, clamp_occurred_at, insert_events
from ..logging_setup import log
from ..rate_limit import limiter
from ..schemas import Beacon, BeaconAck
from ..sessionizer import sessionize_inserted
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
        session_id = await sess.open_or_touch(
            db,
            session_id=body.sessionId,
            org_id=principal.org_id,
            user_id=principal.user_id,
            source=body.source,
            at=now,
            active_ms=body.activeMs,
            idle_ms=body.idleMs,
            user_agent=ua,
            ip=ip,
        )

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
            )
            for e in body.events
        ]
        inserted = await insert_events(db, rows)
        # Web beacons carry app/site rows only rarely (see _CLIENT_CATEGORIES —
        # the desktop and browser agents are the usual source, via the OTHER
        # route below), but when they do, the same correlation applies.
        await sessionize_inserted(db, inserted)

        if body.ended:
            # The client said goodbye (pagehide / sign-out). Close precisely
            # rather than leaving it for the sweeper three minutes later.
            await sess.close(
                db, session_id=session_id, org_id=principal.org_id,
                user_id=principal.user_id, reason="disconnect", at=now,
            )
        await db.commit()

    return BeaconAck(sessionId=session_id, accepted=len(inserted))


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
