"""The outbox poller must survive a broker that isn't up yet.

Regression for the host-reboot crash-loop: compose `depends_on` only orders
`docker compose up`, so on a reboot this service raced Kafka's boot. The
producer connect used to live in ``start()``, which made the race fatal —
uvicorn logged "Application startup failed. Exiting." and the container
crash-looped (5-6 restarts observed in prod) until the broker came up.

The connect now happens lazily in ``_drain_once`` under the retry/backoff that
``_run`` already applies — via ``LazyKafkaProducer``
(services/shared/kafka_lazy_producer), whose own connect/discard/cache
behavior is tested once in that package's own suite, not duplicated here.
What's specific to THIS service is only: does the poller's own start()/stop()
avoid connecting eagerly. Pure-logic: no real Kafka, no DB.
"""
from __future__ import annotations

import asyncio

import pytest

outbox = pytest.importorskip(
    "app.events.poller",
    reason="auth-svc deps (aiokafka) not installed locally; CI installs requirements.txt.",
)


async def test_start_does_not_connect_to_kafka(monkeypatch):
    """start() must not touch the broker — that was the fatal call."""
    poller = outbox.OutboxPoller()
    monkeypatch.setattr(poller, "_run", lambda: asyncio.sleep(0))

    await poller.start()  # must not raise, and must not connect

    assert poller._lazy_producer._producer is None, "start() connected to Kafka; it should be lazy"


async def test_stop_is_safe_when_never_connected(monkeypatch):
    """stop() runs on a poller whose producer never came up (shutdown at boot)."""
    poller = outbox.OutboxPoller()
    monkeypatch.setattr(poller, "_run", lambda: asyncio.sleep(0))

    await poller.start()
    await poller.stop()  # must not raise when the lazy producer was never connected
