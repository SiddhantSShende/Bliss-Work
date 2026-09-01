"""Service-to-service routes, authenticated by a shared secret rather than a
user's bearer token.

One caller: sticky-relay, the delivery watchdog. It asks for open pins nobody
has confirmed receiving, so it can nudge those users to re-fetch.
"""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Query
from internal_auth import internal_token_matches
from sqlalchemy import text

from ..config import settings
from ..db import session, set_bypass_rls
from ..schemas import UndeliveredPinDTO

router = APIRouter()

# The watchdog is a cross-org sweeper, so it asks for a bounded page rather than
# "everything undelivered" — an unbounded answer here would be an unbounded
# amount of nudging.
_MAX_LIMIT = 500


@router.get("/internal/pins/undelivered", response_model=list[UndeliveredPinDTO])
async def undelivered(
    older_than_s: int = Query(default=300, ge=0, le=86_400),
    limit: int = Query(default=100, ge=1, le=_MAX_LIMIT),
    internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> list[UndeliveredPinDTO]:
    """Open pins with no delivery confirmation, older than `older_than_s`.

    ── Why this CLAIMS the rows ─────────────────────────────────────────────────
    `delivery_attempts` is incremented as part of the same statement that
    returns the rows. Two things fall out of that, both necessary:

      * Two sweeper replicas cannot hand back the same pin and double-nudge a
        user, because the UPDATE serialises them.
      * The counter drives the caller's backoff, so a pin that has been nudged
        repeatedly without ever being acknowledged stops being nudged rather
        than becoming a permanent background job.

    It does mean a crashed sweeper "spends" an attempt without sending anything.
    That is the right way round: over-counting delays a nudge, under-counting
    would let a user be nudged forever.
    """
    # Constant-time — a stolen internal secret should not be discoverable by
    # timing this comparison. Fails closed when the expected value is unset.
    if not internal_token_matches(internal_token, settings.internal_token):
        raise HTTPException(status_code=403, detail="invalid internal token")

    async with session() as db:
        # A cross-org background sweeper, exactly the case set_bypass_rls exists
        # for. Never driven by request input: the caller chooses a page size and
        # an age, and nothing else.
        await set_bypass_rls(db)
        rows = (
            await db.execute(
                text(
                    "UPDATE sticky_pins SET delivery_attempts = delivery_attempts + 1 "
                    " WHERE (org_id, assignee_id, task_id) IN ("
                    "     SELECT org_id, assignee_id, task_id FROM sticky_pins"
                    "      WHERE status = 'OPEN'"
                    "        AND last_delivered_at IS NULL"
                    "        AND opened_at < now() - make_interval(secs => :age)"
                    "      ORDER BY opened_at ASC"
                    "      LIMIT :limit"
                    "      FOR UPDATE SKIP LOCKED"
                    " ) "
                    " RETURNING task_id, org_id, assignee_id, opened_at, delivery_attempts"
                ),
                {"age": older_than_s, "limit": limit},
            )
        ).all()
        await db.commit()

    return [
        UndeliveredPinDTO(
            taskId=str(r.task_id),
            orgId=str(r.org_id),
            assigneeId=str(r.assignee_id),
            openedAt=r.opened_at.isoformat().replace("+00:00", "Z"),
            deliveryAttempts=r.delivery_attempts,
        )
        for r in rows
    ]
