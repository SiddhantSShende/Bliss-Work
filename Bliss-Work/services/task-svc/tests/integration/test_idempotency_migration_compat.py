from __future__ import annotations

import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
import pytest_asyncio
import asyncpg
from sqlalchemy import text
from testcontainers.postgres import PostgresContainer

pytestmark = pytest.mark.integration

SERVICE_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = SERVICE_ROOT / "migrations"


@pytest_asyncio.fixture
async def legacy_migration_database(tmp_path):
    from app import db
    from app.config import settings

    container = PostgresContainer("postgres:17-alpine")
    container.start()
    previous_url = settings.task_database_url
    previous_migrations = db.MIGRATIONS_DIR
    await db.dispose_engine()

    legacy_dir = tmp_path / "legacy-migrations"
    legacy_dir.mkdir()
    for migration in sorted(MIGRATIONS.glob("*.sql")):
        if migration.name >= "014_idempotency_actor_fingerprint.sql":
            continue
        shutil.copy2(migration, legacy_dir / migration.name)

    settings.task_database_url = (
        f"postgresql://{container.username}:{container.password}"
        f"@{container.get_container_host_ip()}:{container.get_exposed_port(5432)}"
        f"/{container.dbname}"
    )
    db.MIGRATIONS_DIR = legacy_dir
    db.init_engine()
    try:
        await db.run_migrations()
        yield db, legacy_dir
    finally:
        await db.dispose_engine()
        settings.task_database_url = previous_url
        db.MIGRATIONS_DIR = previous_migrations
        container.stop()


async def test_migration_014_cleans_only_expired_orphans_and_keeps_old_writes_compatible(
    legacy_migration_database, tmp_path
):
    from app.db import get_engine

    db, _ = legacy_migration_database
    expired_orphan = str(uuid.uuid4())
    active_orphan = str(uuid.uuid4())
    retained_task = str(uuid.uuid4())
    retained_expired_task = str(uuid.uuid4())
    sender = str(uuid.uuid4())
    org = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, title_enc, description_enc) "
                "VALUES (:id, :org, :sender, decode('01', 'hex'), decode('02', 'hex'))"
            ),
            {"id": retained_task, "org": org, "sender": sender},
        )
        await conn.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, title_enc, description_enc) "
                "VALUES (:id, :org, :sender, decode('03', 'hex'), decode('04', 'hex'))"
            ),
            {"id": retained_expired_task, "org": org, "sender": sender},
        )
        await conn.execute(
            text(
                "INSERT INTO idempotency_keys (org_id, key, task_id, created_at) "
                "VALUES (:org, :expired, :expired_task, :expired_at), "
                "(:org, :active, :active_task, :active_at), "
                "(:org, 'retained-current', :task, :current_at), "
                "(:org, 'retained-expired-valid', :old_task, :old_at)"
            ),
            {
                "org": org,
                "expired": expired_orphan,
                "expired_task": expired_orphan,
                "expired_at": now - timedelta(days=2),
                "active": active_orphan,
                "active_task": active_orphan,
                "active_at": now - timedelta(hours=12),
                "task": retained_task,
                "current_at": now,
                "old_task": retained_expired_task,
                "old_at": now - timedelta(days=2),
            },
        )

    release_dir = tmp_path / "release-migrations"
    release_dir.mkdir()
    for migration in sorted(MIGRATIONS.glob("*.sql")):
        shutil.copy2(migration, release_dir / migration.name)
    db.MIGRATIONS_DIR = release_dir

    with pytest.raises(asyncpg.exceptions.RaiseError, match="migration 014 blocked") as failure:
        await db.run_migrations()
    assert "restore those task rows" in str(failure.value)

    async with get_engine().connect() as conn:
        columns = (
            await conn.execute(
                text(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = 'idempotency_keys'"
                )
            )
        ).scalars().all()
        keys = (
            await conn.execute(
                text("SELECT key FROM idempotency_keys ORDER BY key")
            )
        ).scalars().all()
        applied = (
            await conn.execute(
                text(
                    "SELECT filename FROM schema_migrations "
                    "WHERE filename >= '014_idempotency_actor_fingerprint.sql'"
                )
            )
        ).scalars().all()
    assert "sender_id" not in columns
    assert "request_fingerprint" not in columns
    assert set(keys) == {
        expired_orphan,
        active_orphan,
        "retained-current",
        "retained-expired-valid",
    }
    assert applied == []

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, title_enc, description_enc) "
                "VALUES (:id, :org, :sender, decode('05', 'hex'), decode('06', 'hex'))"
            ),
            {"id": active_orphan, "org": org, "sender": sender},
        )

    await db.run_migrations()

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        rows = (
            await conn.execute(
                text(
                    "SELECT key, sender_id, request_fingerprint FROM idempotency_keys "
                    "WHERE org_id = :org ORDER BY key"
                ),
                {"org": org},
            )
        ).all()
        pkey = (
            await conn.execute(
                text(
                    "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                    "WHERE conrelid = 'idempotency_keys'::regclass AND contype = 'p'"
                )
            )
        ).scalar_one()
        await conn.execute(
            text(
                "INSERT INTO idempotency_keys (org_id, key, task_id) "
                "VALUES (:org, 'old-image-write', :task)"
            ),
            {"org": org, "task": retained_task},
        )
        migration_order = (
            await conn.execute(
                text(
                    "SELECT filename FROM schema_migrations WHERE filename >= "
                    "'014_idempotency_actor_fingerprint.sql' ORDER BY filename"
                )
            )
        ).scalars().all()
        project_table = (
            await conn.execute(
                text(
                    "SELECT to_regclass('public.projects') IS NOT NULL"
                )
            )
        ).scalar_one()
        projection_column = (
            await conn.execute(
                text(
                    "SELECT EXISTS (SELECT 1 FROM information_schema.columns "
                    "WHERE table_schema='public' AND table_name='user_projection' "
                    "AND column_name='source_occurred_at')"
                )
            )
        ).scalar_one()

    assert expired_orphan not in {row.key for row in rows}
    assert {row.key for row in rows} == {
        active_orphan,
        "retained-current",
        "retained-expired-valid",
    }
    assert all(str(row.sender_id) == sender for row in rows)
    assert all(row.request_fingerprint is None for row in rows)
    assert pkey == "PRIMARY KEY (org_id, key)"
    assert migration_order == [
        "014_idempotency_actor_fingerprint.sql",
        "015_user_projection_event_order.sql",
        "016_projects.sql",
    ]
    assert project_table is True
    assert projection_column is True

    async with get_engine().connect() as conn:
        legacy_write = (
            await conn.execute(
                text(
                    "SELECT sender_id, request_fingerprint FROM idempotency_keys "
                    "WHERE org_id = :org AND key = 'old-image-write'"
                ),
                {"org": org},
            )
        ).one()
    assert legacy_write.sender_id is None
    assert legacy_write.request_fingerprint is None
