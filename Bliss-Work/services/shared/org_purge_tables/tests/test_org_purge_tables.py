"""Unit tests for ``org_purge_tables``.

Exercises the delete-per-table/log-what-was-removed loop against a fake
session — no real Postgres needed. What matters here is that every table in
the list gets a scoped DELETE, only tables with rows actually removed are
logged, and bypass is set before anything is deleted.
"""

from __future__ import annotations

from org_purge_tables import purge_org_tables


class FakeResult:
    def __init__(self, rowcount: int = 0):
        self.rowcount = rowcount


class FakeSession:
    def __init__(self, rowcounts: dict[str, int]):
        self._rowcounts = rowcounts
        self.executed: list[str] = []
        self.committed = False

    async def execute(self, stmt, params=None):
        # `text(f"DELETE FROM {table} WHERE org_id = :org")` — table name is
        # the third whitespace-separated token.
        table = str(stmt).split()[2]
        self.executed.append(table)
        return FakeResult(rowcount=self._rowcounts.get(table, 0))

    async def commit(self) -> None:
        self.committed = True


class _CtxWrapper:
    def __init__(self, db: FakeSession):
        self._db = db

    async def __aenter__(self) -> FakeSession:
        return self._db

    async def __aexit__(self, *exc) -> None:
        return None


class RecordingLogger:
    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    def warning(self, event, **kw):
        self.events.append((event, kw))


async def test_deletes_every_table_and_logs_only_nonzero_counts():
    db = FakeSession({"a": 3, "b": 0, "c": 1})
    log = RecordingLogger()
    bypassed = []

    async def set_bypass_rls(conn):
        bypassed.append(conn)

    await purge_org_tables(lambda: _CtxWrapper(db), set_bypass_rls, log, "org-1", ("a", "b", "c"))

    assert db.executed == ["a", "b", "c"]
    assert db.committed is True
    assert bypassed == [db]
    assert log.events == [("org_purged", {"org_id": "org-1", "deleted": {"a": 3, "c": 1}})]


async def test_no_rows_anywhere_is_a_harmless_no_op():
    db = FakeSession({})
    log = RecordingLogger()

    async def set_bypass_rls(conn):
        return None

    await purge_org_tables(lambda: _CtxWrapper(db), set_bypass_rls, log, "org-2", ("a", "b"))

    assert log.events == [("org_purged", {"org_id": "org-2", "deleted": {}})]
