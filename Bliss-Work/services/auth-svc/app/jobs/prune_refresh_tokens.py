"""Delete refresh-token rows that have passed their expiry.

    python -m app.jobs.prune_refresh_tokens
    python -m app.jobs.prune_refresh_tokens --dry-run

WHY THIS EXISTS
---------------
`refresh_tokens` is the highest-write table in the platform, and the only one
whose load scales with CONCURRENT USERS rather than with what they are doing.
Every access-token expiry costs one /auth/refresh, and refresh rotates: a new row
in, the old one revoked. Nothing deleted any of them, so the table grew without
bound — one row per refresh, per user, for the life of the deployment.

That failure is slow and then sudden. The hot lookup is a UNIQUE index on
token_hash and stays a perfectly good index probe throughout; what degrades is
everything around it, as the index outgrows memory and autovacuum falls behind
the churn. The PostgresDeadTuplesHigh alert in infra/observability fires on
exactly this shape, which is a good signal and a late one.

WHERE THE RETENTION LINE IS, AND WHY IT IS EXPIRY
-------------------------------------------------
The obvious rule — "delete revoked rows" — is wrong, and quietly so.

A revoked row is not spent, it is EVIDENCE. Rotation revokes a token when it is
exchanged, and if that same token is presented again, finding the revoked row is
what identifies a replay and tears down the whole family. That is the theft
detection. Delete the row and the identical replay looks like an unknown token:
still refused, but no longer recognised as theft, so the attacker's other stolen
tokens in that family keep working.

Expiry is the honest line. Past `expires_at` a replay is refused on expiry
grounds whatever the row says, so the row has no remaining value — for detection
or anything else. This job deletes on that rule and nothing looser.

WHY IT DELETES IN BATCHES
-------------------------
One `DELETE ... WHERE expires_at < now()` against a table with hundreds of
millions of rows takes a long transaction and a lot of locks, on the table the
login path depends on. Bounded batches with a commit between them keep each
transaction short, so the prune competes with live traffic for milliseconds at a
time instead of minutes. It is slower overall and that is the correct trade for
a maintenance job.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import text

from ..db import engine
from ..logging_config import log

# How many rows one transaction deletes. Small enough that the lock is held
# briefly on a table serving the login path; large enough that a night's backlog
# clears in a reasonable number of round trips.
BATCH_SIZE = 10_000

# A safety margin past expiry before a row is eligible. Nothing depends on it —
# an expired token is already refused — but it keeps a just-expired row around
# long enough to appear in an investigation of a session that failed moments ago.
GRACE_HOURS = 24

# Stops a single run from monopolising the database if a long-neglected table has
# an enormous backlog. Whatever is left is taken by the next run.
MAX_BATCHES = 500


async def run(*, dry_run: bool = False) -> int:
    """Delete expired rows in batches. Returns how many were removed."""
    if dry_run:
        async with engine.begin() as conn:
            due = (
                await conn.execute(
                    text(
                        "SELECT count(*) AS n FROM refresh_tokens "
                        "WHERE expires_at < now() - make_interval(hours => :g)"
                    ),
                    {"g": GRACE_HOURS},
                )
            ).first()
            n = int(due.n) if due else 0
            log.info("refresh_prune_would_delete", rows=n, grace_hours=GRACE_HOURS)
            return n

    deleted = 0
    for batch in range(MAX_BATCHES):
        # One transaction per batch. The ctid subquery is what bounds it: a plain
        # DELETE with a LIMIT is not valid SQL, and deleting by a key range would
        # need an ordered scan of the very index this is trying to keep small.
        async with engine.begin() as conn:
            result = await conn.execute(
                text(
                    """
                    DELETE FROM refresh_tokens
                    WHERE ctid IN (
                        SELECT ctid FROM refresh_tokens
                        WHERE expires_at < now() - make_interval(hours => :g)
                        LIMIT :lim
                    )
                    """
                ),
                {"g": GRACE_HOURS, "lim": BATCH_SIZE},
            )
        n = result.rowcount or 0
        deleted += n
        if n < BATCH_SIZE:
            break
        # Yield between batches so the prune interleaves with live traffic rather
        # than running as a tight loop against the primary.
        await asyncio.sleep(0.1)
    else:
        log.warning(
            "refresh_prune_hit_batch_ceiling",
            deleted=deleted,
            max_batches=MAX_BATCHES,
            detail="backlog remains; the next run continues from here",
        )

    log.info("refresh_prune_done", deleted=deleted, grace_hours=GRACE_HOURS)
    return deleted


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Delete refresh-token rows past their expiry."
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="report how many rows are eligible, delete nothing",
    )
    args = ap.parse_args()
    try:
        count = asyncio.run(run(dry_run=args.dry_run))
    except Exception:  # pragma: no cover - operational entrypoint
        log.exception("refresh_prune_failed")
        sys.exit(1)
    print(f"{'would delete' if args.dry_run else 'deleted'} {count} refresh token(s)")


if __name__ == "__main__":
    main()
