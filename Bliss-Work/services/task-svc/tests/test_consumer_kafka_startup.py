"""The event consumer must survive a broker that isn't up yet, and reconnect.

Same host-reboot race as test_outbox_kafka_startup, plus a second failure mode:
``_run`` used to consume the ``async for`` exactly once, so a mid-life broker
blip killed the task silently — events stopped projecting while the service
still reported healthy. ``_run`` now reconnects for the life of the process.

Pure-logic: no real Kafka, no DB.
"""
from __future__ import annotations

import asyncio

import pytest

consumer_mod = pytest.importorskip(
    "app.consumer",
    reason="task-svc deps (aiokafka) not installed locally; CI installs requirements.txt.",
)


class _FakeConsumer:
    """Stands in for AIOKafkaConsumer.

    Models ``getmany``, not ``async for``: the consumer loop fetches in batches
    so that it can pay ONE offset commit per fetch rather than one per message
    (see the batch-sizing note in app/consumer.py).

    ``getmany`` hands over every message on the first call and returns nothing
    afterwards, which is how a real fetch behaves once a partition is drained.
    Because a drained fetch is not a signal to stop — the real loop just waits
    for more — the test says when the stream is finished via ``on_drained``.
    Without that the loop would spin forever waiting for messages that a fake
    is never going to produce.
    """

    instances: list["_FakeConsumer"] = []

    def __init__(
        self, fail_times: int = 0, messages=None, raise_mid_loop=False, on_drained=None
    ) -> None:
        self.fail_times = fail_times
        self.messages = list(messages or [])
        self.raise_mid_loop = raise_mid_loop
        self.on_drained = on_drained
        self.started = False
        self.stopped = False
        self.committed = 0
        self.seeks: list[tuple[object, int]] = []
        self._served = False
        _FakeConsumer.instances.append(self)

    async def start(self) -> None:
        if len(_FakeConsumer.instances) <= self.fail_times:
            raise OSError("broker not up yet")
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def commit(self) -> None:
        self.committed += 1

    def seek(self, partition, offset) -> None:
        self.seeks.append((partition, offset))

    async def getmany(self, timeout_ms=0, max_records=None):
        if self.raise_mid_loop:
            raise OSError("connection lost mid-loop")
        if self._served or not self.messages:
            if self.on_drained is not None:
                self.on_drained()
            return {}
        self._served = True
        return {"tp": list(self.messages)}


@pytest.fixture(autouse=True)
def _reset_instances():
    _FakeConsumer.instances.clear()
    yield
    _FakeConsumer.instances.clear()


async def test_start_does_not_connect_to_kafka(monkeypatch):
    """start() must not touch the broker — that was the fatal call."""
    monkeypatch.setattr(
        consumer_mod.TaskSvcConsumer,
        "_build_consumer",
        lambda self: _FakeConsumer(fail_times=99),
    )
    c = consumer_mod.TaskSvcConsumer()
    monkeypatch.setattr(c, "_run", lambda: asyncio.sleep(0))

    await c.start()  # must not raise even though every connect fails

    assert _FakeConsumer.instances == [], "start() connected; it should be lazy"
    assert c._consumer is None


async def test_run_retries_connect_then_consumes(monkeypatch):
    """Two refused connects, then a successful one — with backoff, not a crash."""
    monkeypatch.setattr(
        consumer_mod.TaskSvcConsumer,
        "_build_consumer",
        lambda self: _FakeConsumer(fail_times=2),
    )
    slept: list[float] = []

    c = consumer_mod.TaskSvcConsumer()

    async def _fake_sleep(delay: float) -> None:
        slept.append(delay)
        # Let the third consumer connect and drain, then end the loop.
        if len(slept) >= 2:
            pass

    monkeypatch.setattr(c, "_sleep_or_stop", _fake_sleep)

    async def _consume_loop(consumer):
        c._stop.set()  # one successful pass, then shut down

    monkeypatch.setattr(c, "_consume_loop", _consume_loop)

    await c._run()

    assert len(_FakeConsumer.instances) == 3, "each attempt needs a fresh consumer"
    assert slept == [1.0, 2.0], "backoff must double between attempts"
    assert _FakeConsumer.instances[-1].started
    assert all(i.stopped for i in _FakeConsumer.instances)


async def test_run_reconnects_after_a_mid_loop_failure(monkeypatch):
    """A broker blip mid-consume reconnects instead of killing the task."""
    calls = {"n": 0}

    def _build(self):
        calls["n"] += 1
        # First consumer dies mid-loop; the second drains and shuts the runner
        # down — `self` here is the TaskSvcConsumer, so draining can end its
        # batch loop the same way a real shutdown would.
        return _FakeConsumer(
            raise_mid_loop=calls["n"] == 1, on_drained=self._stop.set
        )

    monkeypatch.setattr(consumer_mod.TaskSvcConsumer, "_build_consumer", _build)
    c = consumer_mod.TaskSvcConsumer()

    original = c._consume_loop

    async def _consume_loop(consumer):
        await original(consumer)
        if not consumer.raise_mid_loop:
            c._stop.set()

    monkeypatch.setattr(c, "_consume_loop", _consume_loop)
    monkeypatch.setattr(c, "_sleep_or_stop", lambda delay: asyncio.sleep(0))

    await c._run()  # must return normally, not propagate the OSError

    assert calls["n"] == 2, "the runner should have reconnected once"
    assert c._consumer is None


async def test_stop_is_safe_when_never_connected(monkeypatch):
    monkeypatch.setattr(
        consumer_mod.TaskSvcConsumer,
        "_build_consumer",
        lambda self: _FakeConsumer(fail_times=99),
    )
    c = consumer_mod.TaskSvcConsumer()
    monkeypatch.setattr(c, "_run", lambda: asyncio.sleep(0))

    await c.start()
    await c.stop()  # must not raise on the None consumer
