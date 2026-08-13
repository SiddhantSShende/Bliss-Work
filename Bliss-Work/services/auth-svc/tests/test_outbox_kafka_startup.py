"""The outbox poller must survive a broker that isn't up yet.

Regression for the host-reboot crash-loop: compose `depends_on` only orders
`docker compose up`, so on a reboot this service raced Kafka's boot. The
producer connect used to live in ``start()``, which made the race fatal —
uvicorn logged "Application startup failed. Exiting." and the container
crash-looped (5-6 restarts observed in prod) until the broker came up.

The connect now happens lazily in ``_drain_once`` under the retry/backoff that
``_run`` already applies. Pure-logic: no real Kafka, no DB.
"""
from __future__ import annotations

import asyncio

import pytest

outbox = pytest.importorskip(
    "app.events.poller",
    reason="auth-svc deps (aiokafka) not installed locally; CI installs requirements.txt.",
)


class _FakeProducer:
    """Stands in for AIOKafkaProducer; fails ``start()`` a set number of times."""

    instances: list["_FakeProducer"] = []

    def __init__(self, fail_times: int = 0, **kwargs) -> None:
        self.kwargs = kwargs
        self.fail_times = fail_times
        self.started = False
        self.stopped = False
        _FakeProducer.instances.append(self)

    async def start(self) -> None:
        if len(_FakeProducer.instances) <= self.fail_times:
            raise OSError("broker not up yet")
        self.started = True

    async def stop(self) -> None:
        self.stopped = True


@pytest.fixture(autouse=True)
def _reset_instances():
    _FakeProducer.instances.clear()
    yield
    _FakeProducer.instances.clear()


def _patch_producer(monkeypatch, fail_times: int) -> None:
    monkeypatch.setattr(
        outbox,
        "AIOKafkaProducer",
        lambda **kw: _FakeProducer(fail_times=fail_times, **kw),
    )


async def test_start_does_not_connect_to_kafka(monkeypatch):
    """start() must not touch the broker — that was the fatal call."""
    _patch_producer(monkeypatch, fail_times=99)
    poller = outbox.OutboxPoller()
    monkeypatch.setattr(poller, "_run", lambda: asyncio.sleep(0))

    await poller.start()  # must not raise even though every connect fails

    assert _FakeProducer.instances == [], "start() built a producer; it should be lazy"
    assert poller._producer is None


async def test_ensure_producer_retries_with_a_fresh_producer(monkeypatch):
    """A producer whose start() failed is discarded, not reused."""
    _patch_producer(monkeypatch, fail_times=2)
    poller = outbox.OutboxPoller()

    for _ in range(2):
        with pytest.raises(OSError):
            await poller._ensure_producer()
        assert poller._producer is None, "failed producer must not be cached"

    produced = await poller._ensure_producer()
    assert produced.started
    assert poller._producer is produced
    # Three distinct producer objects: two failed attempts, then the good one.
    assert len(_FakeProducer.instances) == 3
    assert all(p.stopped for p in _FakeProducer.instances[:2])


async def test_ensure_producer_is_cached_after_success(monkeypatch):
    _patch_producer(monkeypatch, fail_times=0)
    poller = outbox.OutboxPoller()

    first = await poller._ensure_producer()
    second = await poller._ensure_producer()

    assert first is second
    assert len(_FakeProducer.instances) == 1


async def test_stop_is_safe_when_never_connected(monkeypatch):
    """stop() runs on a poller whose producer never came up (shutdown at boot)."""
    _patch_producer(monkeypatch, fail_times=99)
    poller = outbox.OutboxPoller()
    monkeypatch.setattr(poller, "_run", lambda: asyncio.sleep(0))

    await poller.start()
    await poller.stop()  # must not raise on the None producer
