"""Drop every trace of a deleted organization from telemetrydb.

Driven by `org.deleted` from auth-svc. By the time this runs the org's
encryption key is already destroyed, so any `*_enc` column here is unreadable
ciphertext — this removes the rows themselves: the ids, timestamps and counts
that a shred cannot touch.

Idempotent, and must stay that way. The event can be redelivered after a
consumer-group rebalance, and running these deletes over an org that is already
gone is a no-op rather than an error.
"""
from __future__ import annotations

from sqlalchemy import text

from .db import session, set_bypass_rls
from .logging_setup import log

# Ordered so nothing is deleted while something else still references it. In
# practice these tables are independent (every one is keyed by org_id, and
# activity_events is partitioned by day rather than joined), but the order is
# written down so adding a table later has an obvious place to go.
_TABLES = (
    "activity_events",
    "user_sessions",
    "activity_daily",
    "app_usage_daily",
    "site_usage_daily",
    "ingest_tokens",
    # Last. Once this row is gone the org's encrypted columns are unreadable,
    # so deleting it before the rows above would only make a partial failure
    # harder to reason about.
    "org_keys",
)


async def purge_org(org_id: str) -> None:
    async with session() as db:
        # Cross-org background worker acting on one org it was TOLD about, not
        # one derived from a request. Bypass RLS or every delete below silently
        # matches zero rows.
        await set_bypass_rls(db)
        deleted: dict[str, int] = {}
        for table in _TABLES:
            # activity_events is day-partitioned, so this is a parent-table
            # DELETE rather than a DROP: slower than the retention prune's
            # partition drop, but correct for an arbitrary org spanning
            # arbitrary days, and an org's share of any one day is small.
            result = await db.execute(
                text(f"DELETE FROM {table} WHERE org_id = :org"),  # noqa: S608 — fixed table list
                {"org": org_id},
            )
            if result.rowcount:
                deleted[table] = result.rowcount
        await db.commit()
    log.warning("org_purged", org_id=org_id, deleted=deleted)
