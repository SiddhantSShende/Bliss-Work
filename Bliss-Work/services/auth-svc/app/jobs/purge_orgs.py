"""Destroy organizations whose deletion grace period has elapsed.

    python -m app.jobs.purge_orgs
    python -m app.jobs.purge_orgs --dry-run

Runs at 05:00 UTC — deliberately AFTER the 02:30 backup and after the telemetry
prune at 04:30. The backup ordering is the whole point: this job destroys data
across seven databases, so the most recent dump must predate it. If a deletion
was ever requested in error and not cancelled in time, there is a dump from
before it ran rather than one taken afterwards that faithfully records the loss.

WHY THIS IS A JOB AND NOT AN ENDPOINT
-------------------------------------
An irreversible, cross-service deletion should not be something an HTTP request
can complete. A request that times out halfway leaves nobody holding the
outcome; a job can be ordered against the backup, retried, and observed.

WHAT "PURGED" MEANS, IN TWO PARTS
---------------------------------
1. CRYPTO-SHRED — delete the org's `org_keys` row. This is the guarantee. Every
   `*_enc` column in every service becomes permanently unreadable in O(1), and
   it takes effect immediately whether or not a single consumer is running. A
   service that is down for an hour wakes up to ciphertext it can never decrypt,
   not to readable data. Read paths already tolerate this by design (see
   telemetry-svc's `_detail`, which returns None rather than 500 for an
   undecryptable blob).

2. HARD PURGE — the `org.deleted` event, which each service consumes to drop its
   own rows. This is the cleanup, and it covers what shred cannot: ids,
   timestamps, counts, and — critically — attachment BYTES ON DISK, which are
   not application-encrypted at all (messaging-svc's blob package says so
   outright: filesystem permissions are load-bearing there).

Shred first, then announce. The order matters: if the process dies between the
two, the data is already unreadable and the event is still in the outbox waiting
to be published.

THE AUDIT PROBLEM
-----------------
`audit_log` is hash-chained and lives INSIDE the org's own RLS-scoped data, so
purging an org destroys its own record of having been destroyed. Three things
mitigate that, and all three are used: the `deleted_orgs` tombstone (outside the
org, never purged), the Kafka events (which reach a separate immutable sink),
and the pre-purge backup.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import text

from ..db import engine
from ..events.outbox import TOPIC_AUTH, build_event, enqueue_event
from ..logging_config import log
from .. import service


# Auth-side deletion, in dependency order. Exposed as data rather than inlined
# so the ordering is reviewable and testable: nothing here has ON DELETE
# CASCADE, so this order is the only thing preventing a mid-purge failure on a
# dangling reference — and a half-purged org is worse than either outcome.
#
# `identities` is cleared, never deleted: one identity is the credential shared
# across every org a person belongs to.
PURGE_STATEMENTS: tuple[str, ...] = (
    "UPDATE identities SET last_user_id = NULL "
    "WHERE last_user_id IN (SELECT id FROM users WHERE org_id = :org)",
    "DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE org_id = :org)",
    "DELETE FROM user_tokens WHERE user_id IN (SELECT id FROM users WHERE org_id = :org)",
    # mfa_backup_codes/mfa_webauthn_credentials both REFERENCE users(id) with no
    # CASCADE (see migrations/0016_mfa.sql) — same reasoning as everything else
    # in this list, and skipping them means the final DELETE FROM users below
    # fails its FK check for any org with even one MFA-enrolled member.
    "DELETE FROM mfa_backup_codes WHERE user_id IN (SELECT id FROM users WHERE org_id = :org)",
    "DELETE FROM mfa_webauthn_credentials WHERE user_id IN (SELECT id FROM users WHERE org_id = :org)",
    "DELETE FROM user_roles WHERE org_id = :org",
    "DELETE FROM invites WHERE org_id = :org",
    "DELETE FROM audit_log WHERE org_id = :org",
    # Last of the user-referencing deletes: everything above reaches its rows
    # THROUGH users, so removing them first would orphan those rows permanently.
    "DELETE FROM users WHERE org_id = :org",
)


async def _due(conn) -> list[tuple[str, str | None, str | None]]:
    """Orgs past their grace period and not already purged, oldest-due first.

    `FOR UPDATE SKIP LOCKED` here is scoped to this SELECT's own short
    transaction (see `run()`, which commits it immediately after) — it is a
    cheap way to leave an org a concurrent run is already mid-purge on off
    this candidate list, not the actual claim. The real claim happens in
    `purge_one()`, which re-takes `FOR UPDATE SKIP LOCKED` on just that one
    org's row inside its own per-org transaction; that lock, not this one, is
    what stops two overlapping runs from purging the same org twice.
    """
    rows = (
        await conn.execute(
            text(
                """
                SELECT id, slug, delete_requested_by
                  FROM orgs
                 WHERE deleted_at IS NULL
                   AND purge_after IS NOT NULL
                   AND purge_after <= now()
                 ORDER BY purge_after
                 FOR UPDATE SKIP LOCKED
                """
            )
        )
    ).all()
    return [(str(r.id), r.slug, str(r.delete_requested_by) if r.delete_requested_by else None) for r in rows]


async def purge_one(conn, org_id: str, slug: str | None, requested_by: str | None) -> None:
    """Destroy one org's auth-side data and announce it. Caller owns the tx."""
    # Re-read under the row lock. A cancel that committed between _due() and
    # here must win: this job and POST /auth/org/delete/cancel genuinely race in
    # the final moments before purge_after, and the row is the arbiter.
    #
    # FOR UPDATE SKIP LOCKED: each org now purges in its own transaction (see
    # run()), so this lock — not _due()'s, long released by the time we get
    # here — is what stops two overlapping runs from purging the same org
    # twice. SKIP LOCKED means an org another run already claimed is silently
    # left to that run rather than waited on.
    still_due = (
        await conn.execute(
            text(
                "SELECT 1 FROM orgs WHERE id = :org AND deleted_at IS NULL "
                "AND purge_after IS NOT NULL AND purge_after <= now() "
                "FOR UPDATE SKIP LOCKED"
            ),
            {"org": org_id},
        )
    ).first()
    if still_due is None:
        log.info("org_purge_skipped_cancelled", org_id=org_id)
        return

    # Tombstone FIRST, while we still know the slug and the requester — after
    # the delete below there is nothing left to read them from.
    await conn.execute(
        text(
            "INSERT INTO deleted_orgs (org_id, slug, requested_by, requested_at) "
            "SELECT id, slug, delete_requested_by, delete_requested_at FROM orgs WHERE id = :org "
            "ON CONFLICT (org_id) DO NOTHING"
        ),
        {"org": org_id},
    )

    # Crypto-shred. Everything encrypted for this org is now unrecoverable,
    # everywhere, regardless of what the rest of this transaction does.
    await conn.execute(text("DELETE FROM org_keys WHERE org_id = :org"), {"org": org_id})

    # Auth-side hard purge. `identities` is NOT deleted — one identity spans
    # every org a person belongs to, and destroying it here would lock them out
    # of workspaces this org has no say over. Rows pointing INTO this org are
    # cleared instead.
    for stmt in PURGE_STATEMENTS:
        await conn.execute(text(stmt), {"org": org_id})

    # Mark, don't drop. The orgs row becomes a stub carrying deleted_at so a
    # stale JWT resolves to "this workspace is gone" rather than to nothing,
    # which is the difference between a clear error and a 500.
    await conn.execute(
        text(
            "UPDATE orgs SET deleted_at = now(), name = '(deleted)', "
            "delete_requested_by = NULL WHERE id = :org"
        ),
        {"org": org_id},
    )

    # Announce last, in the SAME transaction, so the event and the shred commit
    # together — no window where consumers purge an org that then rolls back.
    await enqueue_event(
        conn,
        topic=TOPIC_AUTH,
        kafka_key=org_id,
        event=build_event("org.deleted", org_id, slug=slug),
    )
    log.warning("org_purged", org_id=org_id, slug=slug, requested_by=requested_by)


async def run(dry_run: bool = False) -> int:
    """Returns the number of orgs purged (or that would be, when dry).

    Each due org is purged in its OWN transaction, not one shared transaction
    for the whole batch. Otherwise a single org failing partway (this has
    happened: an FK from a table not yet added to PURGE_STATEMENTS) rolls back
    every org already purged earlier in the same run — and since the next run
    reselects the identical list in the identical order, everything behind the
    failing org in purge_after order never gets purged, silently, forever. A
    shared transaction also holds _due()'s row locks for the whole batch, so a
    concurrent /org/delete, /org/delete/cancel or /org/mfa request for ANY due
    org blocks until the whole run finishes rather than just its own org.
    """
    async with engine.begin() as conn:
        await service.set_bypass_rls(conn)
        due = await _due(conn)
    if not due:
        log.info("org_purge_nothing_due")
        return 0
    if dry_run:
        for org_id, slug, _ in due:
            log.info("org_purge_would_purge", org_id=org_id, slug=slug)
        return len(due)

    purged = 0
    for org_id, slug, requested_by in due:
        try:
            async with engine.begin() as conn:
                await service.set_bypass_rls(conn)
                await purge_one(conn, org_id, slug, requested_by)
            purged += 1
        except Exception:
            # Log and move on to the next due org rather than aborting the
            # whole run: one org's failure must not undo the orgs already
            # purged before it, nor block the orgs still due after it.
            log.exception("org_purge_failed", org_id=org_id, slug=slug)
    return purged


def main() -> None:
    ap = argparse.ArgumentParser(description="Purge organizations past their deletion grace period.")
    ap.add_argument("--dry-run", action="store_true", help="report what would be purged, delete nothing")
    args = ap.parse_args()
    try:
        count = asyncio.run(run(dry_run=args.dry_run))
    except Exception:
        # Non-zero so the systemd unit / CronJob goes red. A swallowed failure
        # here is indistinguishable from "nothing was due", and the difference
        # matters: one means the erasure request was honoured and the other
        # means it silently was not.
        log.exception("org_purge_failed")
        sys.exit(1)
    print(f"{'would purge' if args.dry_run else 'purged'}: {count} org(s)")


if __name__ == "__main__":
    main()
