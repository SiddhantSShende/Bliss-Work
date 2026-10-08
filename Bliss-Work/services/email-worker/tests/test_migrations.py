"""Concurrent email-worker startup uses one locked migration application."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import types

from app import migrations, relay_consumer
from app.relay_consumer import RelayConsumer


class _FakeDatabase:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.applied: dict[str, str] = {}
        self.migration_runs: list[str] = []

    @asynccontextmanager
    async def acquire(self):
        yield _FakeConnection(self)


class _FakeConnection:
    def __init__(self, database: _FakeDatabase) -> None:
        self.database = database
        self._owns_lock = False

    @asynccontextmanager
    async def transaction(self):
        try:
            yield
        finally:
            if self._owns_lock:
                self.database.lock.release()
                self._owns_lock = False

    async def execute(self, sql: str, *args):
        normalized = " ".join(sql.split())
        if normalized.startswith("SELECT pg_advisory_xact_lock"):
            await self.database.lock.acquire()
            self._owns_lock = True
        elif normalized.startswith("INSERT INTO schema_migrations"):
            self.database.applied[args[0]] = args[1]
        elif normalized.startswith("SELECT 'migration"):
            self.database.migration_runs.append(normalized)

    async def fetch(self, sql: str):
        assert "FROM schema_migrations" in sql
        return [
            {"filename": filename, "checksum": checksum}
            for filename, checksum in self.database.applied.items()
        ]


async def test_concurrent_startup_serializes_and_applies_each_migration_once(
    monkeypatch, tmp_path
) -> None:
    (tmp_path / "0001_first.sql").write_text("SELECT 'migration first';")
    (tmp_path / "0002_second.sql").write_text("SELECT 'migration second';")
    monkeypatch.setattr(migrations, "MIGRATIONS_DIR", tmp_path)
    database = _FakeDatabase()

    await asyncio.gather(
        migrations.run_migrations(database),  # type: ignore[arg-type]
        migrations.run_migrations(database),  # type: ignore[arg-type]
    )

    assert len(database.migration_runs) == 2
    assert set(database.applied) == {"0001_first.sql", "0002_second.sql"}


async def test_steady_state_startup_skips_unchanged_migrations(monkeypatch, tmp_path) -> None:
    (tmp_path / "0001_first.sql").write_text("SELECT 'migration first';")
    monkeypatch.setattr(migrations, "MIGRATIONS_DIR", tmp_path)
    database = _FakeDatabase()

    await migrations.run_migrations(database)  # type: ignore[arg-type]
    await migrations.run_migrations(database)  # type: ignore[arg-type]

    assert len(database.migration_runs) == 1


async def test_relay_startup_delegates_to_the_locked_migration_runner(monkeypatch) -> None:
    settings = types.SimpleNamespace(
        smtp_host="mailpit",
        smtp_port=1025,
        smtp_from="no-reply@test.local",
        smtp_username="",
        smtp_password="",
        smtp_starttls=False,
        relay_max_concurrency=2,
    )
    consumer = RelayConsumer(settings)
    pool = object()
    consumer._db = pool  # type: ignore[assignment]
    calls: list[object] = []

    async def run(pool_arg: object) -> None:
        calls.append(pool_arg)

    monkeypatch.setattr(relay_consumer, "run_migrations", run)

    await consumer._apply_migrations()

    assert calls == [pool]
