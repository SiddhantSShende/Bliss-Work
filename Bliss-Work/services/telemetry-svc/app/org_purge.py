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

from org_purge_tables import purge_org_tables

from .db import session, set_bypass_rls
from .logging_setup import log

# Ordered so nothing is deleted while something else still references it. In
# practice these tables are independent (every one is keyed by org_id, and
# activity_events is partitioned by day rather than joined), but the order is
# written down so adding a table later has an obvious place to go.
#
# activity_events is day-partitioned, so its DELETE is a parent-table one
# rather than a DROP: slower than the retention prune's partition drop, but
# correct for an arbitrary org spanning arbitrary days, and an org's share of
# any one day is small.
#
# activity_sessions holds `app_name`/`domain` in the CLEAR (see
# 0005_activity_sessions.sql — an indexed-lookup exception to this service's
# usual encrypt-everything convention, still true for these two columns), so
# unlike every other table here the crypto-shred (org_keys, below) does
# nothing to protect THOSE fields: this DELETE is the only thing that ever
# removes them. `title` itself is no longer part of that exception — as of
# 0008_encrypt_activity_session_title.sql it is written encrypted
# (title_enc), going forward; this DELETE still removes both title_enc and
# any residual pre-migration plaintext `title`, same as it always removed
# the whole row.
_TABLES = (
    "activity_events",
    "activity_sessions",
    "user_sessions",
    "activity_daily",
    "app_usage_daily",
    "site_usage_daily",
    "ingest_tokens",
    "beacon_batches",
    "client_event_claims",
    # Last. Once this row is gone the org's encrypted columns are unreadable,
    # so deleting it before the rows above would only make a partial failure
    # harder to reason about.
    "org_keys",
)


async def purge_org(org_id: str) -> None:
    await purge_org_tables(session, set_bypass_rls, log, org_id, _TABLES)
