"""Kafka offset commits vs. handler failures.

`StickyConsumer._consume_loop` must never let `consumer.commit()` run past a
message that `handle()` failed to apply. Before the fix here, a `handle()`
exception (a DB hiccup, a lock timeout) was caught inline, logged, and the
batch was committed anyway — the event was acknowledged to Kafka despite
never having been written, so the pin update was gone for good instead of
being redelivered. That is the task-svc-flavoured version of "the note never
leaves the desktop".

The fix mirrors telemetry-svc/app/consumer.py: a handler failure aborts the
rest of the fetch uncommitted, and `_consume_loop` seeks every partition back
to the start of that fetch and retries, instead of committing past it.

PURE LOGIC: Kafka is a fake and `handle` is stubbed per test; what's being
exercised is the offset-commit decision, not the SQL `handle` runs — that is
covered by the integration suite against a real Postgres.
"""

from __future__ import annotations

import pytest
from sqlalchemy.exc import DataError, DBAPIError, IntegrityError, OperationalError

import app.consumer as consumer_module
from app.consumer import StickyConsumer


class _Msg:
    """The handful of ConsumerRecord attributes the loop actually reads."""

    def __init__(self, value, offset=0):
        self.value = value
        self.offset = offset


def _event(**kw):
    base = {
        "eventId": "11111111-1111-1111-1111-111111111111",
        "orgId": "org-1",
        "type": "task.assigned",
        "taskId": "task-1",
        "assigneeId": "user-1",
        "statusVersion": 1,
    }
    base.update(kw)
    return base


def _batch(*messages):
    """One fetch on one partition, in offset order."""
    return {"tp": [_Msg(m, offset=i) for i, m in enumerate(messages)]}


def test_malformed_kafka_bytes_are_skippable():
    assert consumer_module._deserialize_event(b"[") is None
    assert consumer_module._deserialize_event(b'{"type":"ok"}') == {"type": "ok"}


# ── _process_batch: the offset decision ─────────────────────────────────────


@pytest.mark.asyncio
async def test_a_handler_failure_does_not_advance_the_offset():
    """A DB hiccup or lock timeout in `handle()` must abort the batch.

    This is the regression test for the bug directly: `_process_batch` must
    report failure rather than swallow the exception and let the caller
    commit past it.
    """
    c = StickyConsumer()

    async def _handle(_event):
        raise RuntimeError("db is gone")

    c.handle = _handle

    ok = await c._process_batch(_batch(_event()))

    assert ok is False, "a handler failure must not let the offset advance"


@pytest.mark.asyncio
async def test_a_failure_stops_before_later_messages_in_the_fetch():
    """Once a message fails, later messages in the fetch are not attempted.

    Applying them anyway would let a later event's write land before the
    earlier, failed one is ever retried.
    """
    c = StickyConsumer()
    seen: list[str] = []

    async def _handle(event):
        seen.append(event["eventId"])
        if event["eventId"] == "bad":
            raise RuntimeError("boom")

    c.handle = _handle

    ok = await c._process_batch(_batch(_event(eventId="bad"), _event(eventId="good")))

    assert ok is False
    assert seen == ["bad"], "processing must stop at the failed message"


@pytest.mark.asyncio
async def test_a_successful_batch_may_commit():
    c = StickyConsumer()
    calls = []

    async def _handle(event):
        calls.append(event["eventId"])

    c.handle = _handle

    ok = await c._process_batch(_batch(_event(eventId="a"), _event(eventId="b")))

    assert ok is True
    assert calls == ["a", "b"]


# ── _consume_loop: the end-to-end proof ─────────────────────────────────────


class _FakeConsumer:
    """Serves the same one-message batch twice, then stops the loop.

    Records every `commit()` and `seek()` call so the test can tell whether a
    failed fetch was ever acknowledged to Kafka.
    """

    def __init__(self, batch, stop_event):
        self._batch = batch
        self._stop_event = stop_event
        self.calls = 0
        self.commits = 0
        self.seeks: list[tuple] = []

    async def getmany(self, timeout_ms=None, max_records=None):
        self.calls += 1
        if self.calls > 2:
            self._stop_event.set()
            return {}
        return self._batch

    async def commit(self):
        self.commits += 1

    def seek(self, tp, offset):
        self.seeks.append((tp, offset))


@pytest.mark.asyncio
async def test_consume_loop_seeks_back_and_retries_instead_of_committing(monkeypatch):
    """Drives the real `_consume_loop`, not just `_process_batch`.

    This is the test that would have caught the original bug even if only
    `_process_batch` had been "fixed" while the caller kept committing
    unconditionally: it asserts on what the fake Kafka consumer actually saw.
    """
    monkeypatch.setattr(consumer_module, "_RETRY_BACKOFF", 0.0, raising=False)

    c = StickyConsumer()
    attempts = {"n": 0}

    async def _handle(_event):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise RuntimeError("db is gone")

    c.handle = _handle

    fake = _FakeConsumer(_batch(_event()), c._stop)

    await c._consume_loop(fake)

    assert attempts["n"] == 2, "the failed message must be retried, not skipped"
    assert fake.seeks == [("tp", 0)], "the failed fetch must be rewound to its first offset"
    assert fake.commits == 1, "only the retried, successful fetch may commit"


# ── poison events: permanent failures are skipped, transient ones are not ───

_UUID = "11111111-1111-4111-8111-111111111111"


def _uuid_event(**kw):
    return _event(
        orgId=_UUID,
        taskId="22222222-2222-4222-8222-222222222222",
        assigneeId="33333333-3333-4333-8333-333333333333",
        **kw,
    )


def _skipped(reason):
    return consumer_module.SKIPPED.labels(reason=reason)._value.get()


@pytest.mark.asyncio
@pytest.mark.parametrize("sender", ["not-a-uuid", "", 12345, ["x"]])
async def test_a_malformed_sender_id_is_skipped_before_any_db_work(monkeypatch, sender):
    """senderId was the one id bound into a uuid column without validation, so
    a bad one raised DataError on every retry. It must be skipped up front."""

    def _no_db():
        raise AssertionError("a malformed event must not reach the database")

    monkeypatch.setattr(consumer_module, "session", _no_db)
    before = _skipped("id_not_a_uuid")

    await StickyConsumer().handle(_uuid_event(senderId=sender))

    assert _skipped("id_not_a_uuid") == before + 1


@pytest.mark.asyncio
async def test_a_missing_sender_id_is_still_accepted(monkeypatch):
    """senderId is optional (nullable column): absence must not be skipped."""

    class _Reached(Exception):
        pass

    def _session():
        raise _Reached

    monkeypatch.setattr(consumer_module, "session", _session)

    with pytest.raises(_Reached):
        await StickyConsumer().handle(_uuid_event())  # no senderId
    with pytest.raises(_Reached):
        await StickyConsumer().handle(_uuid_event(senderId=None))
    with pytest.raises(_Reached):
        await StickyConsumer().handle(_uuid_event(senderId=_UUID))


def _db_error(cls):
    return cls("INSERT ...", {}, Exception("rejected"))


@pytest.mark.asyncio
@pytest.mark.parametrize("exc_cls", [DataError, IntegrityError])
async def test_a_db_rejected_event_is_skipped_and_the_batch_continues(exc_cls):
    """A DataError/IntegrityError can never succeed on retry; with no attempt
    cap, treating it as transient wedged the consumer forever."""
    c = StickyConsumer()
    seen: list[str] = []

    async def _handle(event):
        seen.append(event["eventId"])
        if event["eventId"] == "poison":
            raise _db_error(exc_cls)

    c.handle = _handle
    before = _skipped("rejected_by_db")

    ok = await c._process_batch(
        _batch(_event(eventId="a"), _event(eventId="poison"), _event(eventId="b"))
    )

    assert ok is True, "the poison event must not block the offset"
    assert seen == ["a", "poison", "b"], "events after the poison one still run"
    assert _skipped("rejected_by_db") == before + 1


@pytest.mark.asyncio
async def test_a_transient_db_error_is_still_retried_not_skipped():
    c = StickyConsumer()

    async def _handle(_event):
        raise _db_error(OperationalError)

    c.handle = _handle
    before = _skipped("rejected_by_db")

    assert await c._process_batch(_batch(_event())) is False
    assert _skipped("rejected_by_db") == before


@pytest.mark.asyncio
async def test_retry_backoff_grows_while_failing_and_resets_after_success(monkeypatch):
    monkeypatch.setattr(consumer_module, "_RETRY_BACKOFF", 1.0)
    monkeypatch.setattr(consumer_module, "_RETRY_BACKOFF_MAX", 4.0)
    c = StickyConsumer()
    outcomes = iter([False, False, False, False, True, False])
    delays: list[float] = []

    async def _process(_batches):
        return next(outcomes)

    async def _sleep(delay):
        delays.append(delay)

    c._process_batch = _process
    c._sleep_or_stop = _sleep

    class _Fake(_FakeConsumer):
        async def getmany(self, timeout_ms=None, max_records=None):
            self.calls += 1
            if self.calls > 6:
                self._stop_event.set()
                return {}
            return self._batch

    await c._consume_loop(_Fake(_batch(_event()), c._stop))

    assert delays == [1.0, 2.0, 4.0, 4.0, 1.0], "doubles to the cap, resets on success"


class _PgOrig(Exception):
    def __init__(self, sqlstate):
        super().__init__(sqlstate)
        self.sqlstate = sqlstate


@pytest.mark.parametrize(
    ("sqlstate", "permanent"),
    [
        ("22P02", True),  # invalid text representation (bad uuid literal)
        ("22000", True),  # asyncpg client-side encode error
        ("23514", True),  # check violation
        ("40P01", False),  # deadlock: retry
        ("57014", False),  # statement timeout: retry
        ("08006", False),  # connection failure: retry
        (None, False),
    ],
)
def test_asyncpg_errors_are_classified_by_sqlstate(sqlstate, permanent):
    """With asyncpg, SQLAlchemy surfaces data errors as a bare DBAPIError, so
    classifying on DataError/IntegrityError alone would miss the real poison."""
    exc = DBAPIError("SELECT 1", {}, _PgOrig(sqlstate))
    assert consumer_module._is_permanent_db_error(exc) is permanent
    assert consumer_module._is_permanent_db_error(RuntimeError("x")) is False
