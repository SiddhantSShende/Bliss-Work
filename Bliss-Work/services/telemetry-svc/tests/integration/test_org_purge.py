"""org.deleted must actually purge the org's telemetry rows.

Runs purge_org() against the REAL migrated schema — this is exactly what would
have caught activity_sessions being added by 0005_activity_sessions.sql without
ever being added to org_purge.py's _TABLES: unlike the sibling bugs this
mirrors (services/integrations-svc and services/task-svc's test_org_purge.py),
a MISSING table doesn't make the purge raise — it just silently never deletes
that table's rows, so the plaintext title/app_name/domain columns
0005_activity_sessions.sql documents (an indexed-lookup exception to this
service's usual encrypt-everything convention) would survive an org's
"deletion" forever, unprotected by the crypto-shred that covers every other
table here.

    TELEMETRY_DATABASE_URL=postgresql://taskboard:taskboard_dev_pw@postgres:5432/telemetrydb_scratch \\
        python -m pytest tests/integration/test_org_purge.py -q
"""
from __future__ import annotations

import os
import uuid

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="module")]

if not os.getenv("TELEMETRY_DATABASE_URL"):
    pytest.skip("needs a live Postgres (TELEMETRY_DATABASE_URL)", allow_module_level=True)

pytest_asyncio = pytest.importorskip("pytest_asyncio")

from sqlalchemy import text  # noqa: E402

from app.db import dispose_engine, init_engine, run_migrations  # noqa: E402

ORG = str(uuid.uuid4())


@pytest_asyncio.fixture(loop_scope="module", scope="module", autouse=True)
async def _migrated_db():
    init_engine()
    await run_migrations()
    yield
    await dispose_engine()


async def _seed_activity_session(org_id: str) -> str:
    from app.db import session, set_bypass_rls

    session_id = str(uuid.uuid4())
    async with session() as db:
        await set_bypass_rls(db)
        await db.execute(
            text(
                """
                INSERT INTO activity_sessions
                    (id, org_id, user_id, anchor_event_id, started_at, ended_at,
                     duration_ms, kind, app_name)
                VALUES
                    (:id, :org, gen_random_uuid(), gen_random_uuid(), now(), now(),
                     1000, 'app', 'Chrome')
                """
            ),
            {"id": session_id, "org": org_id},
        )
        await db.commit()
    return session_id


async def test_purge_org_removes_activity_sessions():
    from app.org_purge import purge_org
    from app.db import session, set_bypass_rls

    await _seed_activity_session(ORG)

    await purge_org(ORG)  # must not raise, and must not silently skip this table

    async with session() as db:
        await set_bypass_rls(db)
        remaining = (
            await db.execute(
                text("SELECT count(*) AS n FROM activity_sessions WHERE org_id = :o"),
                {"o": ORG},
            )
        ).one()
        assert remaining.n == 0


async def test_purge_org_is_idempotent_on_an_org_with_nothing_to_delete():
    from app.org_purge import purge_org

    # A redelivered org.deleted event, or one for an org with no telemetry data
    # at all, must be a harmless no-op — not an error.
    await purge_org(str(uuid.uuid4()))
