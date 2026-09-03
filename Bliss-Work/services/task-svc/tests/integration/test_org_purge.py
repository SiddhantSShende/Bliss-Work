"""org.deleted must actually purge the org's task rows.

Runs purge_org() against the REAL migrated schema — this is exactly what would
have caught consumed_events being included in _TABLES despite having no
org_id column (003_rls.sql documents it as a global, unscoped table). That
stale reference made every purge_org() call raise (undefined column), rolling
back the whole transaction and leaving every org.deleted permanently
unprocessed: not one deleted org's tasks, assignees, or org_keys row was ever
actually removed. See services/integrations-svc/tests/integration/
test_org_purge.py for the sibling bug this mirrors.
"""
from __future__ import annotations

import uuid

from sqlalchemy import text

import pytest

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"


async def _seed_task(db_app) -> str:
    from app.db import session, set_bypass_rls

    task_id = str(uuid.uuid4())
    async with session() as db:
        await set_bypass_rls(db)
        await db.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, title_enc) "
                "VALUES (:t, :o, gen_random_uuid(), :enc)"
            ),
            {"t": task_id, "o": ORG, "enc": b"fake-ciphertext"},
        )
        await db.execute(
            text(
                "INSERT INTO task_assignees (task_id, org_id, assignee_id) "
                "VALUES (:t, :o, gen_random_uuid())"
            ),
            {"t": task_id, "o": ORG},
        )
        await db.commit()
    return task_id


async def test_purge_org_does_not_raise_and_removes_the_task(db_app):
    from app.org_purge import purge_org
    from app.db import session, set_bypass_rls

    task_id = await _seed_task(db_app)

    await purge_org(ORG)  # must not raise — see consumed_events above

    async with session() as db:
        await set_bypass_rls(db)
        remaining = (
            await db.execute(
                text("SELECT count(*) AS n FROM tasks WHERE org_id = :o"),
                {"o": ORG},
            )
        ).one()
        assert remaining.n == 0
        remaining_assignees = (
            await db.execute(
                text("SELECT count(*) AS n FROM task_assignees WHERE org_id = :o"),
                {"o": ORG},
            )
        ).one()
        assert remaining_assignees.n == 0


async def test_purge_org_is_idempotent_on_an_org_with_nothing_to_delete(db_app):
    from app.org_purge import purge_org

    # A redelivered org.deleted event, or one for an org with no task data at
    # all, must be a harmless no-op — not an error.
    await purge_org("99999999-9999-9999-9999-999999999999")
