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
from .pins import _iso

router = APIRouter()

# The watchdog is a cross-org sweeper, so it asks for a bounded page rather than
# "everything undelivered" — an unbounded answer here would be an unbounded
# amount of nudging.
_MAX_LIMIT = 500

# ── Backoff ladder (DERIVED — sweep.go is canonical) ─────────────────────────
# services/sticky-relay/internal/sweep/sweep.go (BackoffLadder, MaxNudges) is
# the canonical definition of these values and of the reasoning behind them.
# This is a copy, not a shared import, because "is a nudge due" now has to be
# decided INSIDE the claim query below, in Postgres — sticky-relay's own
# client-side check runs too late to stop a sweep tick that isn't due from
# touching the row and spending an attempt on it. If sweep.go's ladder or
# MaxNudges ever change, update the CASE expression and _MAX_NUDGES below to
# match by hand.
#
# The CASE never looks up BackoffLadder[0] (1 minute): it computes the delay
# AFTER a nudge that was just claimed, indexed by the POST-increment
# delivery_attempts (always >= 1 here) — the same value sweep.go's isDue is
# actually called with, since sticky-svc reports attempts post-claim. Index 0
# (the delay before the very FIRST nudge) is never consulted for the same
# reason it barely matters in sweep.go either: that first delay is governed by
# `older_than_s` (StaleAfter), which is longer than a minute in every real
# deployment.
_MAX_NUDGES = 12


@router.get("/internal/pins/undelivered", response_model=list[UndeliveredPinDTO])
async def undelivered(
    older_than_s: int = Query(default=300, ge=0, le=86_400),
    limit: int = Query(default=100, ge=1, le=_MAX_LIMIT),
    internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> list[UndeliveredPinDTO]:
    """Open pins with no delivery confirmation, older than `older_than_s`, AND
    due for a nudge under the backoff ladder.

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

    ── Why `next_eligible_at` is ALSO a claim condition ────────────────────────
    Without it, this claims (and counts) every stale pin on every sweep tick,
    not only the ticks where sticky-relay's backoff ladder actually judged a
    nudge due — so `delivery_attempts` raced ahead of real nudges sent and hit
    MaxNudges from mere reclaiming, roughly 10 hours earlier than the ladder
    intends. The claim below only touches a row whose backoff window has
    elapsed, and advances `next_eligible_at` by that same ladder so the counter
    and the ladder stay in sync. See _MAX_NUDGES above for where the ladder
    itself is canonically defined.
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
                    "UPDATE sticky_pins SET "
                    "       delivery_attempts = delivery_attempts + 1, "
                    # `delivery_attempts` on the right-hand side is the OLD row
                    # value (every SET expression in one UPDATE sees the same
                    # pre-update row), so `+ 1` here is the POST-increment count
                    # this claim is about to record — see _MAX_NUDGES above.
                    "       next_eligible_at = now() + CASE "
                    "           WHEN delivery_attempts + 1 <= 1 THEN interval '5 minutes' "
                    "           WHEN delivery_attempts + 1 = 2 THEN interval '15 minutes' "
                    "           ELSE interval '60 minutes' "
                    "       END "
                    " WHERE (org_id, assignee_id, task_id) IN ("
                    "     SELECT org_id, assignee_id, task_id FROM sticky_pins"
                    "      WHERE status = 'OPEN'"
                    # An UNPINNED note is one the user deliberately took off
                    # their desktop: it is not "lost in transit", and nudging
                    # about it would be the service fighting the user.
                    "        AND pin_state = 'PINNED'"
                    "        AND last_delivered_at IS NULL"
                    "        AND opened_at < now() - make_interval(secs => :age)"
                    "        AND next_eligible_at <= now()"
                    "        AND delivery_attempts < :max_nudges"
                    "      ORDER BY opened_at ASC"
                    "      LIMIT :limit"
                    "      FOR UPDATE SKIP LOCKED"
                    " ) "
                    " RETURNING task_id, org_id, assignee_id, opened_at, delivery_attempts"
                ),
                {"age": older_than_s, "limit": limit, "max_nudges": _MAX_NUDGES},
            )
        ).all()
        await db.commit()

    return [
        UndeliveredPinDTO(
            taskId=str(r.task_id),
            orgId=str(r.org_id),
            assigneeId=str(r.assignee_id),
            openedAt=_iso(r.opened_at) or "",
            deliveryAttempts=r.delivery_attempts,
        )
        for r in rows
    ]
