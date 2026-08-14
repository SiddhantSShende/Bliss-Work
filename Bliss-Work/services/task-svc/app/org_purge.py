"""Drop every trace of a deleted organization from taskdb.

Driven by `org.deleted` from auth-svc. The org's encryption key is already
destroyed by the time this runs, so `title_enc` / `description_enc` /
`review_enc` are unreadable ciphertext — this removes the rows themselves.

Idempotent: the event can be redelivered after a rebalance, and re-running
these deletes over an org that is already gone is a no-op.
"""
from __future__ import annotations

from sqlalchemy import text

from .db import session, set_bypass_rls
from .logging_setup import log

# Child tables before parents: task_assignees references tasks. Reviews are
# columns ON task_assignees (004_task_reviews.sql), not a table of their own,
# so they go with it.
_TABLES = (
    "task_assignees",
    "tasks",
    "availability_hidden",
    "user_projection",
    "idempotency_keys",
    "consumed_events",
    # Last: see the note in telemetry-svc/app/org_purge.py.
    "org_keys",
)


async def purge_org(org_id: str) -> None:
    async with session() as db:
        # Acting on one org we were TOLD about rather than one derived from a
        # request, so there is no request org to scope to. Without the bypass
        # every delete below matches zero rows.
        await set_bypass_rls(db)
        deleted: dict[str, int] = {}
        for table in _TABLES:
            result = await db.execute(
                text(f"DELETE FROM {table} WHERE org_id = :org"),  # noqa: S608 — fixed table list
                {"org": org_id},
            )
            if result.rowcount:
                deleted[table] = result.rowcount
        await db.commit()
    log.warning("org_purged", org_id=org_id, deleted=deleted)
