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
