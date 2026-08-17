"""Quarantine for outbox rows that can never be published.

── Why this exists ──────────────────────────────────────────────────────────
Every outbox poller in the platform claimed `ORDER BY created_at LIMIT n` and
re-claimed the identical rows on the next tick whenever the produce failed.
That is exactly right for a transient failure — a broker restart, a leader
election — and catastrophic for a permanent one, because the claim is ordered:
a row the broker will never accept sits at the head of the queue and every
event behind it stops with it, for every organisation, indefinitely. Nothing
counted the retries and nothing alerted, so the only symptom was "events
stopped" pointing at whichever service consumed them.

The distinction the old code could not make is transient vs permanent, so this
module makes it two ways:

  * SIZE is checked before the row is ever offered to the producer. It is
    knowable from the payload's length, so there is no reason to learn it from
    failed round trips — and, decisively, a producer rejects the whole batch on
    one oversized message, so an unfiltered row would also block the healthy
    rows travelling with it.

  * EVERYTHING ELSE gets an attempt counter. A row that has failed
    MAX_PUBLISH_ATTEMPTS times is set aside so the queue can move, with the
    error recorded so a human can see what happened.

Rows are marked, never deleted: an event that failed to publish is the only
remaining copy of something a consumer was supposed to receive.
"""
from __future__ import annotations

from sqlalchemy import text

# The largest single event any poller will attempt.
#
# Kafka's default `message.max.bytes` is ~1 MiB and the broker rejects the
# produce request rather than the message, so this must stay at or below
# whatever the brokers are configured with. It is stated here rather than
# inherited from a client default so that raising the broker limit is a
# deliberate two-line change instead of a silent mismatch between what we
# accept from users and what the broker will take.
MAX_PUBLISH_BYTES = 1 << 20

# How many failed drains before a row is set aside. At one tick every 500 ms
# this is roughly five minutes of continuous failure — far longer than a broker
# restart, so a genuine outage drains normally once it clears.
MAX_PUBLISH_ATTEMPTS = 600

# Truncation for the recorded reason: this lands in a text column a human
# reads, and a broker error can carry a very long message.
_MAX_REASON = 500

_QUARANTINE_OVERSIZE = text(
    """
    UPDATE outbox
       SET dead_lettered_at = now(),
           publish_error = 'payload ' || octet_length(payload::text) ||
                           ' bytes exceeds the ' || :limit || ' byte publish limit'
     WHERE id = ANY(:ids)
    """
)

# ONE UPDATE per row, deciding both things at once via CASE.
#
# This was a two-CTE form — bump in the first, quarantine in the second —
# and it silently did nothing: Postgres will not modify the same row twice
# in a single statement, so the second UPDATE matched rows the first had
# already touched and skipped every one. The counter climbed forever and
# NOTHING was ever quarantined, which is the retry-forever wedge this module
# exists to end. Verified against Postgres 17; the two-CTE form reports 0.
#
# RETURNING sees the NEW row, so the count comes back from the same
# statement, and the outer SELECT only READS the CTE — nothing is written
# twice.
_RECORD_FAILURE = text(
    """
    WITH bumped AS (
        UPDATE outbox
           SET publish_attempts = publish_attempts + 1,
               publish_error    = :reason,
               dead_lettered_at = CASE
                   WHEN publish_attempts + 1 >= :max_attempts THEN now()
                   ELSE dead_lettered_at
               END
         WHERE id = ANY(:ids)
           AND published_at IS NULL
           AND dead_lettered_at IS NULL
     RETURNING dead_lettered_at
    )
    SELECT count(*) FROM bumped WHERE dead_lettered_at IS NOT NULL
    """
)


def payload_bytes(payload: object) -> int:
    """Size of a row's payload as the producer will send it.

    Measured on the ENCODED form, not on the Python object, because bytes are
    what the broker counts. A dict that looks small can serialise large.
    """
    import json

    if isinstance(payload, (bytes, bytearray)):
        return len(payload)
    if isinstance(payload, str):
        return len(payload.encode("utf-8"))
    return len(json.dumps(payload).encode("utf-8"))


async def quarantine_oversize(conn, ids: list) -> int:
    """Set aside rows too large to publish. Returns how many."""
    if not ids:
        return 0
    await conn.execute(_QUARANTINE_OVERSIZE, {"ids": ids, "limit": MAX_PUBLISH_BYTES})
    return len(ids)


async def record_publish_failure(conn, ids: list, cause: BaseException) -> int:
    """Count a failed publish and quarantine anything that has run out of tries.

    Returns how many rows this call quarantined.

    MUST run on a connection whose transaction will COMMIT. A counter written
    inside the rolled-back claim transaction would be discarded, leaving the row
    retrying forever with a permanently zero attempt count — which is the bug
    this module exists to remove, restored quietly.
    """
    if not ids:
        return 0
    reason = str(cause)[:_MAX_REASON]
    result = await conn.execute(
        _RECORD_FAILURE,
        {"ids": ids, "reason": reason, "max_attempts": MAX_PUBLISH_ATTEMPTS},
    )
    row = result.first()
    return int(row[0]) if row else 0
