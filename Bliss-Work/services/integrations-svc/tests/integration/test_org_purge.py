"""org.deleted must actually purge the org's integration rows.

Runs purge_org() against the REAL migrated schema — this is exactly what would
have caught connection_verifications being dropped by 0009 while org_consumer.py
still tried to DELETE FROM it on every purge, permanently breaking every org
deletion (the whole transaction rolled back, so nothing was ever purged; the
Kafka offset never committed, so it retried forever).
"""
from __future__ import annotations

from sqlalchemy import text

import pytest

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
USER = "22222222-2222-2222-2222-222222222222"


async def _seed_connection(db_app) -> None:
    from crypto import cryptor
    from app.db import session, set_org_context

    async with session() as db:
        await set_org_context(db, ORG)
        access_enc = await cryptor().encrypt(db, ORG, "fake-access-token")
        await db.execute(
            text(
                """
                INSERT INTO integration_connections
                    (id, org_id, owner_user_id, created_by, scope_kind, provider,
                     status, display_label, access_token_enc)
                VALUES
                    (gen_random_uuid(), :o, :u, :u, 'user', 'outlook',
                     'connected', 'work outlook', :a)
                """
            ),
            {"o": ORG, "u": USER, "a": access_enc},
        )
        await db.execute(
            text(
                """
                INSERT INTO mail_send_attempts (mail_id, org_id, status)
                VALUES (gen_random_uuid(), :o, 'sending')
                """
            ),
            {"o": ORG},
        )
        await db.execute(
            text(
                """
                INSERT INTO message_send_attempts (message_id, org_id, status)
                VALUES (gen_random_uuid(), :o, 'sending')
                """
            ),
            {"o": ORG},
        )
        await db.commit()


async def test_purge_org_does_not_raise_and_removes_the_connection(db_app):
    from app.org_consumer import purge_org
    from app.db import session, set_bypass_rls

    await _seed_connection(db_app)

    await purge_org(ORG)  # must not raise — see connection_verifications above

    async with session() as db:
        await set_bypass_rls(db)
        remaining = (
            await db.execute(
                text("SELECT count(*) AS n FROM integration_connections WHERE org_id = :o"),
                {"o": ORG},
            )
        ).one()
        assert remaining.n == 0
        mail_attempts = (
            await db.execute(
                text("SELECT count(*) AS n FROM mail_send_attempts WHERE org_id = :o"),
                {"o": ORG},
            )
        ).one()
        message_attempts = (
            await db.execute(
                text("SELECT count(*) AS n FROM message_send_attempts WHERE org_id = :o"),
                {"o": ORG},
            )
        ).one()
        assert mail_attempts.n == 0
        assert message_attempts.n == 0


async def test_purge_org_is_idempotent_on_an_org_with_nothing_to_delete(db_app):
    from app.org_consumer import purge_org

    # A redelivered org.deleted event, or one for an org with no integrations
    # data at all, must be a harmless no-op — not an error.
    await purge_org("99999999-9999-9999-9999-999999999999")
