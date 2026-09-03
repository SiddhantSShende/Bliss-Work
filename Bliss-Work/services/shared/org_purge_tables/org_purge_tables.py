"""Shared body of every `org.deleted` consumer: delete one org's rows from a
fixed list of that service's own tables.

Three services (integrations-svc, telemetry-svc, task-svc) each react to
auth-svc's org-deletion job by wiping their own org-scoped tables, and until
now each carried its own copy of the same loop — bypass RLS, `DELETE FROM
{table} WHERE org_id = :org` per table, log what was actually removed. Only
the table list differs per service, so that is the one thing callers supply.
"""

from __future__ import annotations

from typing import Awaitable, Callable, Protocol

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


class Logger(Protocol):
    """The subset of structlog's bound-logger interface this module needs —
    every service's `log` object already satisfies this structurally."""

    def warning(self, event: str, **kw: object) -> None: ...


async def purge_org_tables(
    session: Callable[[], AsyncSession],
    set_bypass_rls: Callable[[AsyncSession], Awaitable[None]],
    log: Logger,
    org_id: str,
    tables: tuple[str, ...],
) -> None:
    """Delete `org_id`'s rows from each of `tables`, in the given order, in one
    transaction, and log which tables actually had rows removed.

    Idempotent: re-running this for an org that is already gone — a redelivery
    after a consumer-group rebalance — is a harmless no-op DELETE per table.
    """
    async with session() as db:
        # Acting on an org we were TOLD about rather than one derived from a
        # request, so there is no request org to scope to — bypass, or every
        # delete below silently matches zero rows.
        await set_bypass_rls(db)
        deleted: dict[str, int] = {}
        for table in tables:
            result = await db.execute(
                text(f"DELETE FROM {table} WHERE org_id = :org"),  # noqa: S608 — fixed table list
                {"org": org_id},
            )
            if result.rowcount:
                deleted[table] = result.rowcount
        await db.commit()
    log.warning("org_purged", org_id=org_id, deleted=deleted)
