"""Drop every trace of a deleted organization from taskdb.

Driven by `org.deleted` from auth-svc. The org's encryption key is already
destroyed by the time this runs, so `title_enc` / `description_enc` /
`review_enc` are unreadable ciphertext — this removes the rows themselves.

Idempotent: the event can be redelivered after a rebalance, and re-running
these deletes over an org that is already gone is a no-op.
"""
from __future__ import annotations

from org_purge_tables import purge_org_tables

from .db import session, set_bypass_rls
from .logging_setup import log

# Child tables before parents: task_assignees references tasks. Reviews are
# columns ON task_assignees (004_task_reviews.sql), not a table of their own,
# so they go with it.
#
# consumed_events is NOT here: it has no org_id column (003_rls.sql — a global
# event-id dedup table, not an org-scoped one), so a stale reference here made
# every purge_org() call raise (undefined column), rolling back the WHOLE
# transaction and leaving every org.deleted permanently unprocessed — the same
# failure integrations-svc's org_consumer.py hit with connection_verifications.
_TABLES = (
    "task_assignees",
    "task_channels",
    "tasks",
    "task_schedules",
    "projects",
    "availability_hidden",
    "user_projection",
    "idempotency_keys",
    # Last: see the note in telemetry-svc/app/org_purge.py.
    "org_keys",
)


async def purge_org(org_id: str) -> None:
    await purge_org_tables(session, set_bypass_rls, log, org_id, _TABLES)
