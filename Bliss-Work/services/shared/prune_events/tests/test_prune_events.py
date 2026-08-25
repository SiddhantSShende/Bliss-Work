"""Unit tests for ``prune_events``.

Exercises the batching/dry-run/error-aggregation logic against a fake engine
that implements just enough of SQLAlchemy's async engine protocol to drive
`prune_target`/`run` — no real Postgres needed. What matters here is the
CONTROL FLOW (batch ceiling reporting, one-target-fails-others-continue), not
the SQL itself.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from prune_events import Target, prune_target, run


@dataclass
class FakeResult:
    rowcount: int = 0
    _scalar: int = 0

    def scalar_one(self) -> int:
        return self._scalar


class FakeConn:
    def __init__(self, batches: list[int]):
        self._batches = batches
        self.executed = 0

    async def execute(self, _stmt, _params=None):
        n = self._batches[min(self.executed, len(self._batches) - 1)]
        self.executed += 1
        return FakeResult(rowcount=n, _scalar=sum(self._batches))


class _CtxWrapper:
    def __init__(self, conn: FakeConn):
        self._conn = conn

    async def __aenter__(self) -> FakeConn:
        return self._conn

    async def __aexit__(self, *exc) -> None:
        return None


@dataclass
class FakeEngine:
    """`batches` is the rowcount each successive DELETE returns; the run stops
    the first time a batch comes back smaller than BATCH_SIZE."""

    batches: list[int] = field(default_factory=list)
    disposed: bool = False
    conn: FakeConn = field(init=False)

    def __post_init__(self) -> None:
        self.conn = FakeConn(self.batches)

    def begin(self) -> _CtxWrapper:
        return _CtxWrapper(self.conn)

    def connect(self) -> _CtxWrapper:
        return _CtxWrapper(self.conn)

    async def dispose(self) -> None:
        self.disposed = True


class RecordingLogger:
    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    def info(self, event, **kw):
        self.events.append(("info", event, kw))

    def warning(self, event, **kw):
        self.events.append(("warning", event, kw))

    def exception(self, event, **kw):
        self.events.append(("exception", event, kw))


TARGET = Target(
    table="outbox",
    where="published_at < now()",
    retention_seconds=7 * 24 * 60 * 60,
    why="test target",
)


async def test_dry_run_reports_without_deleting():
    engine = FakeEngine(batches=[42])
    log = RecordingLogger()
    await prune_target(engine, log, TARGET, dry_run=True)
    assert engine.conn.executed == 1
    assert log.events[0][:2] == ("info", "prune_would_delete")


async def test_stops_once_a_batch_is_under_batch_size():
    from prune_events import BATCH_SIZE

    engine = FakeEngine(batches=[BATCH_SIZE, BATCH_SIZE, 3])
    log = RecordingLogger()
    await prune_target(engine, log, TARGET, dry_run=False)
    assert engine.conn.executed == 3
    done = [e for e in log.events if e[1] == "prune_done"]
    assert done and done[0][2]["deleted"] == BATCH_SIZE * 2 + 3


async def test_hitting_max_batches_warns_instead_of_silently_stopping():
    from prune_events import BATCH_SIZE, MAX_BATCHES

    engine = FakeEngine(batches=[BATCH_SIZE])  # never drops below BATCH_SIZE
    log = RecordingLogger()
    await prune_target(engine, log, TARGET, dry_run=False)
    assert engine.conn.executed == MAX_BATCHES
    ceiling = [e for e in log.events if e[1] == "prune_hit_batch_ceiling"]
    assert len(ceiling) == 1


async def test_run_disposes_engine_and_returns_zero_on_success():
    engine = FakeEngine(batches=[0])
    log = RecordingLogger()
    code = await run(engine, log, (TARGET,), dry_run=False)
    assert code == 0
    assert engine.disposed is True


async def test_run_continues_past_a_failing_target_and_reports_failure():
    class ExplodingEngine(FakeEngine):
        def begin(self):
            raise RuntimeError("boom")

    engine = ExplodingEngine(batches=[0])
    log = RecordingLogger()
    code = await run(engine, log, (TARGET,), dry_run=False)
    assert code == 1
    assert any(e[1] == "prune_failed" for e in log.events)
    assert engine.disposed is True


async def test_cli_dry_run_flag(monkeypatch):
    from prune_events import cli

    monkeypatch.setattr("sys.argv", ["prog", "--dry-run"])
    assert cli("test job") is True

    monkeypatch.setattr("sys.argv", ["prog"])
    assert cli("test job") is False
