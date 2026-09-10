"""Batched fetch and acknowledgement.

This consumer subscribes to messaging.events.v1 — the highest-volume topic in
the platform — and acts on exactly one event type from it. The old loop still
committed the offset after every single message, synchronously, including the
overwhelming majority it had just decided to ignore: a round trip to the group
coordinator per event, to record that nothing happened.

Batching moves that to one commit per fetch. The handlers are deliberately
untouched — each still owns its session, its dedup claim and its commit — so
these tests are about the two things the change could plausibly break: how many
commits happen, and whether one bad message can now take its neighbours down
with it.

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

    def __init__(self, value, offset=0, topic="messaging.events.v1"):
        self.value = value
        self.offset = offset
        self.topic = topic
        self.headers = ()


def _batch(*values):
    """One fetch on one partition, in offset order."""
    return {"tp": [_Msg(v, offset=i) for i, v in enumerate(values)]}


async def test_a_failing_handler_does_not_abandon_the_rest_of_the_batch(monkeypatch):
    """One bad event must cost one event, not the fetch.

    Per message this was already true — the loop logged and continued. Batching
    is what makes it worth asserting: a `return` instead of a `continue` in the
    new loop would silently drop up to 199 healthy events every time one
    handler raised, and nothing else in the suite would notice.
    """
    seen: list[str] = []

    async def _handle(event):
        seen.append(event["type"])
        if event["type"] == "boom":
            raise RuntimeError("handler blew up")

    c = consumer_mod.TaskSvcConsumer()
    monkeypatch.setattr(c, "_handle", _handle)

    await c._process_batch(
        _batch({"type": "first"}, {"type": "boom"}, {"type": "third"})
    )

    assert seen == ["first", "boom", "third"], "the batch must continue past a failure"


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
