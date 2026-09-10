"""org.deleted must actually purge the org's sticky_pins rows.

Runs purge_org() against the REAL migrated schema, and drives it through the
consumer's own handle() too — this service previously had NO reaction to
org.deleted at all (it only ever subscribed to task.events.v1), so a deleted
org's pins lived forever. See the sibling test_org_purge.py files in
integrations-svc, task-svc and telemetry-svc for the same bug in other shapes.
"""
from __future__ import annotations

import uuid

from sqlalchemy import text

import pytest

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"


async def _seed_pin(org_id: str) -> None:
    from app.db import session, set_bypass_rls

    async with session() as db:
        await set_bypass_rls(db)
        await db.execute(
            text(
                "INSERT INTO sticky_pins (org_id, assignee_id, task_id) "
                "VALUES (:o, gen_random_uuid(), gen_random_uuid())"
            ),
            {"o": org_id},
        )
        await db.commit()


async def test_purge_org_does_not_raise_and_removes_the_pin(db_app):
    from app.org_purge import purge_org
    from app.db import session, set_bypass_rls

    await _seed_pin(ORG)

    await purge_org(ORG)

    async with session() as db:
        await set_bypass_rls(db)
        remaining = (
            await db.execute(
                text("SELECT count(*) AS n FROM sticky_pins WHERE org_id = :o"),
                {"o": ORG},
            )
        ).one()
        assert remaining.n == 0


async def test_purge_org_is_idempotent_on_an_org_with_nothing_to_delete(db_app):
    from app.org_purge import purge_org

    await purge_org(str(uuid.uuid4()))


async def test_consumer_handle_routes_org_deleted_to_purge_org(db_app):
    """The bug itself: before this fix, StickyConsumer never subscribed to
    auth.events at all, so an org.deleted event landing here (e.g. after the
    subscription is added but handle() forgot to route it) would silently
    fall through the task-event field checks and do nothing."""
    from app.consumer import StickyConsumer
    from app.db import session, set_bypass_rls

    await _seed_pin(ORG)

    await StickyConsumer().handle({"type": "org.deleted", "orgId": ORG})

    async with session() as db:
        await set_bypass_rls(db)
        remaining = (
            await db.execute(
                text("SELECT count(*) AS n FROM sticky_pins WHERE org_id = :o"),
                {"o": ORG},
            )
        ).one()
        assert remaining.n == 0
