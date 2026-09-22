"""Batched fetch and acknowledgement.

This consumer subscribes to messaging.events.v1 — the highest-volume topic in
the platform — and acts on exactly one event type from it. The old loop still
committed the offset after every single message, synchronously, including the
overwhelming majority it had just decided to ignore: a round trip to the group
coordinator per event, to record that nothing happened.

Batching moves that to one commit per fetch. The handlers are deliberately
untouched — each still owns its session, its dedup claim and its commit — so
these tests are about what the batch commit can break: how many commits happen,
and what a FAILED handler does to the offset. It must never be committed past —
the batch is rewound and retried — while a message that can never succeed is
given up on after a bounded number of attempts rather than blocking its
partition.

Pure-logic: no real Kafka, no DB.
"""
from __future__ import annotations

import pytest

consumer_mod = pytest.importorskip(
    "app.consumer",
    reason="task-svc deps (aiokafka) not installed locally; CI installs requirements.txt.",
)


class _Msg:
    """The ConsumerRecord attributes the loop actually reads."""

    def __init__(self, value, offset=0, topic="messaging.events.v1", partition=0):
        self.value = value
        self.offset = offset
        self.topic = topic
        self.partition = partition
        self.headers = ()


def _batch(*values):
    """One fetch on one partition, in offset order."""
    return {"tp": [_Msg(v, offset=i) for i, v in enumerate(values)]}


def test_malformed_kafka_bytes_are_skippable():
    assert consumer_mod._deserialize_event(b"{") is None
    assert consumer_mod._deserialize_event(b'{"type":"ok"}') == {"type": "ok"}


async def test_a_failing_handler_stops_the_batch_and_reports_failure(monkeypatch):
    """The batch must not be treated as done when one handler failed.

    This used to log and `continue`, so the caller committed the whole fetch and
    the failed event was skipped for good. Stopping at the failure is what lets
    the caller rewind to it, and keeps events in order while it is retried.
    """
    seen: list[str] = []

    async def _handle(event):
        seen.append(event["type"])
        if event["type"] == "boom":
            raise RuntimeError("handler blew up")

    c = consumer_mod.TaskSvcConsumer()
    monkeypatch.setattr(c, "_handle", _handle)

    ok = await c._process_batch(_batch({"type": "first"}, {"type": "boom"}, {"type": "third"}))

    assert ok is False, "a failed handler must not let the offsets advance"
    assert seen == ["first", "boom"], "nothing after the failure is attempted this pass"


async def test_a_failed_batch_is_rewound_and_retried_and_only_then_committed(monkeypatch):
    """The trap: not committing is not enough, because the fetch position has
    already moved on — the NEXT batch's commit would carry the offset past the
    failed message. The loop has to seek back to it."""
    monkeypatch.setattr(consumer_mod, "_RETRY_BACKOFF", 0)
    events: list[str] = []
    failures = {"boom": 1}  # fails once, then succeeds

    async def _handle(event):
        events.append(event["type"])
        if failures.get(event["type"], 0) > 0:
            failures[event["type"]] -= 1
            raise RuntimeError("transient")

    fake = _SeekableConsumer([_Msg({"type": t}, offset=i) for i, t in enumerate(["a", "boom", "c"])])
    c = consumer_mod.TaskSvcConsumer()
    fake.on_done = c._stop.set
    monkeypatch.setattr(c, "_handle", _handle)

    await c._consume_loop(fake)

    assert fake.seeks == [("tp", 0)], "rewound to the first message of the failed batch"
    assert events == ["a", "boom", "a", "boom", "c"], "the whole batch is re-run, in order"
    assert fake.commits == 1, "committed once, after the retry succeeded — never after the failure"


async def test_a_message_that_always_fails_is_dropped_after_the_limit_not_left_blocking(monkeypatch):
    """Retrying forever would stall the partition — and every other org's
    events behind the poison one. Past the limit it is skipped (and logged)."""
    monkeypatch.setattr(consumer_mod, "_RETRY_BACKOFF", 0)
    attempts_on_poison = 0
    handled_after: list[str] = []

    async def _handle(event):
        nonlocal attempts_on_poison
        if event["type"] == "poison":
            attempts_on_poison += 1
            raise RuntimeError("can never succeed")
        if attempts_on_poison:
            handled_after.append(event["type"])

    fake = _SeekableConsumer([_Msg({"type": t}, offset=i) for i, t in enumerate(["poison", "next"])])
    c = consumer_mod.TaskSvcConsumer()
    fake.on_done = c._stop.set
    monkeypatch.setattr(c, "_handle", _handle)

    await c._consume_loop(fake)

    assert attempts_on_poison == consumer_mod._MAX_HANDLER_ATTEMPTS
    assert "next" in handled_after, "the message behind the poison one is still processed"
    assert fake.commits >= 1
    assert c._attempts == {}, "the ledger holds only messages that are currently failing"


async def test_the_retry_pause_grows_with_repeated_failures_and_is_capped(monkeypatch):
    """A flat pause would burn through the attempt limit in seconds — less than
    an ordinary database blip. It doubles per failed attempt, up to a cap."""
    monkeypatch.setattr(consumer_mod, "_RETRY_BACKOFF", 1.0)
    monkeypatch.setattr(consumer_mod, "_RETRY_BACKOFF_MAX", 30.0)
    monkeypatch.setattr(consumer_mod, "_MAX_HANDLER_ATTEMPTS", 100)
    pauses: list[float] = []

    async def _fail(_event):
        raise RuntimeError("database down")

    c = consumer_mod.TaskSvcConsumer()

    async def _record_pause(delay):
        pauses.append(delay)
        if len(pauses) == 8:
            c._stop.set()

    monkeypatch.setattr(c, "_handle", _fail)
    monkeypatch.setattr(c, "_sleep_or_stop", _record_pause)

    await c._consume_loop(_SeekableConsumer([_Msg({"type": "x"}, offset=0)]))

    assert pauses == [1.0, 2.0, 4.0, 8.0, 16.0, 30.0, 30.0, 30.0]


async def test_success_clears_a_messages_failure_count(monkeypatch):
    calls = 0

    async def _handle(_event):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("transient")

    c = consumer_mod.TaskSvcConsumer()
    monkeypatch.setattr(c, "_handle", _handle)
    batch = _batch({"type": "x"})

    assert await c._process_batch(batch) is False
    assert c._attempts, "the failure is remembered"
    assert await c._process_batch(batch) is True
    assert c._attempts == {}, "and forgotten once it succeeds"


async def test_one_commit_per_fetch_not_one_per_message(monkeypatch):
    """The whole point of the change.

    Three messages used to mean three synchronous offset commits. They should
    now mean one.
    """
    fake = _DrainingConsumer(_batch({"type": "a"}, {"type": "b"}, {"type": "c"}))

    c = consumer_mod.TaskSvcConsumer()
    fake.on_drained = c._stop.set
    monkeypatch.setattr(c, "_handle", _noop)

    await c._consume_loop(fake)

    assert fake.handled == 3, "every message still has to be handled"
    assert fake.committed == 1, "three messages must cost ONE offset commit"


async def test_an_empty_fetch_commits_nothing(monkeypatch):
    """A poll that returns no messages must not commit.

    Committing on an idle poll would turn a quiet topic into a steady stream of
    pointless coordinator traffic — the exact cost this change exists to remove.
    """
    fake = _DrainingConsumer({})

    c = consumer_mod.TaskSvcConsumer()
    fake.on_drained = c._stop.set
    monkeypatch.setattr(c, "_handle", _noop)

    await c._consume_loop(fake)

    assert fake.committed == 0


async def test_a_stop_mid_batch_abandons_the_remaining_messages(monkeypatch):
    """Shutdown must not be delayed by a full batch.

    A fetch can hold 200 messages and shutdown has a 5s budget, so the loop
    checks the stop event between messages rather than only between fetches.
    The offsets for what was already handled are left uncommitted, which is
    safe: every handler is dedup-claimed, so redelivery re-runs them cleanly.
    """
    handled: list[str] = []

    c = consumer_mod.TaskSvcConsumer()

    async def _handle(event):
        handled.append(event["type"])
        c._stop.set()  # shutdown arrives while the batch is in flight

    monkeypatch.setattr(c, "_handle", _handle)

    await c._process_batch(_batch({"type": "a"}, {"type": "b"}, {"type": "c"}))

    assert handled == ["a"], "the loop should stop at the first opportunity"


async def _noop(_event):
    return None


class _DrainingConsumer:
    """Serves one fetch, then reports the stream finished.

    Mirrors the fake in test_consumer_kafka_startup: a drained fetch is not a
    stop signal to the real loop, so the test supplies one via ``on_drained``.
    """

    def __init__(self, batch):
        self._batch = batch
        self.on_drained = None
        self.committed = 0
        self.handled = 0
        self._served = False

    async def getmany(self, timeout_ms=0, max_records=None):
        if self._served or not self._batch:
            if self.on_drained is not None:
                self.on_drained()
            return {}
        self._served = True
        self.handled = sum(len(v) for v in self._batch.values())
        return self._batch

    async def commit(self):
        self.committed += 1

    def seek(self, partition, offset):
        pass


class _SeekableConsumer:
    """One partition. getmany() serves everything from the current position and
    moves it to the end (like a real fetch); seek() puts it back."""

    def __init__(self, messages):
        self.messages = messages
        self.pos = 0
        self.commits = 0
        self.seeks: list[tuple[str, int]] = []
        self.on_done = None

    async def getmany(self, timeout_ms=0, max_records=None):
        if self.pos >= len(self.messages):
            if self.on_done is not None:
                self.on_done()
            return {}
        batch = {"tp": self.messages[self.pos :]}
        self.pos = len(self.messages)
        return batch

    async def commit(self):
        self.commits += 1

    def seek(self, partition, offset):
        self.seeks.append((partition, offset))
        self.pos = offset
