"""Drop every trace of a deleted organization from stickydb.

Driven by `org.deleted` from auth-svc. sticky_pins carries no encrypted
content (see the Dockerfile's note: task titles/descriptions live in task-svc
under its own DEK, never duplicated here), so there is no crypto-shred half —
this removes the rows themselves: the org/assignee/task ids and delivery
status that a shred would have nothing to do with anyway.

Idempotent: the event can be redelivered after a rebalance, and re-running
this delete over an org that is already gone is a no-op.
"""
from __future__ import annotations

from org_purge_tables import purge_org_tables

from .db import session, set_bypass_rls
from .logging_setup import log

_TABLES = ("sticky_pins",)


async def purge_org(org_id: str) -> None:
    await purge_org_tables(session, set_bypass_rls, log, org_id, _TABLES)
