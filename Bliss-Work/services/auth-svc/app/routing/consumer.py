"""Keeping this site's routing directory in step with every other site.

One Kafka consumer on the bridged routing topic. Everything it needs — same
topic name at every site, at-least-once delivery, dedupe by event id, and the
loop guard that stops a replicated event being re-exported — is already provided
by the region bridge, so none of it is re-implemented here.

What IS here is the part the bridge cannot do: applying an event to a table in a
way that survives being handed the same event twice, or out of order. Both are
normal under at-least-once delivery, and both are handled by treating
`occurredAt` as a version rather than by trying to make delivery exactly-once.
"""
from __future__ import annotations

import asyncio
import json

from aiokafka import AIOKafkaConsumer

from ..config import settings
from ..db import engine
from ..kafka_security import kafka_security_kwargs
from ..logging_config import log
from . import directory
from .events import TOPIC_ROUTING, CapacityReport, DirectoryUpsert, parse

# Backoff between reconnect attempts. The consumer must survive Kafka being
# unavailable at startup: compose ordering does not apply on a host reboot, and a
# consumer that exited on a connection failure would leave this site's directory
# frozen at whatever it knew an hour ago.
_RETRY_SECONDS = 5.0


class RoutingConsumer:
    """Applies `routing.*` and `site.capacity.*` events to the local tables."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="routing-consumer")
        log.info("routing_consumer_started", topic=TOPIC_ROUTING)

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        log.info("routing_consumer_stopped")

    async def _run(self) -> None:
        while not self._stop.is_set():
            consumer: AIOKafkaConsumer | None = None
            try:
                consumer = AIOKafkaConsumer(
                    TOPIC_ROUTING,
                    bootstrap_servers=settings.kafka_brokers,
                    **kafka_security_kwargs(),
                    # Per-site group: every site must receive EVERY routing
                    # event, so the groups must not be shared across sites — two
                    # sites in one group would split the directory between them
                    # and each would answer "retry" for half the world.
                    group_id=f"auth-routing-{settings.site_id}",
                    enable_auto_commit=False,
                    auto_offset_reset="earliest",
                )
                await consumer.start()
                await self._consume(consumer)
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 — one bad poll must not end the loop
                log.warning("routing_consumer_error", err=str(err))
                await asyncio.sleep(_RETRY_SECONDS)
            finally:
                if consumer is not None:
                    try:
                        await consumer.stop()
                    except Exception:  # noqa: BLE001
                        pass

    async def _consume(self, consumer: AIOKafkaConsumer) -> None:
        async for message in consumer:
            if self._stop.is_set():
                return
            try:
                await self._apply(json.loads(message.value))
            except Exception as err:  # noqa: BLE001
                # Skip and carry on. A single unparseable event must not stop the
                # directory converging — the cost of dropping one is a stale key
                # that answers "retry"; the cost of stopping is every key at this
                # site going stale at once.
                log.warning("routing_event_skipped", err=str(err), offset=message.offset)
            # Committed AFTER the write. A crash between the two replays the
            # event, which the version check makes a no-op.
            await consumer.commit()

    async def _apply(self, payload: dict) -> None:
        decoded = parse(payload)
        if decoded is None:
            return
        async with engine.begin() as conn:
            # routing_directory and site_capacity carry no org policy (see
            # migration 0012) but the connection is fresh, so the bypass is set
            # explicitly rather than relied upon by omission.
            from .. import service

            await service.set_bypass_rls(conn)
            if isinstance(decoded, CapacityReport):
                await directory.apply_capacity(conn, decoded)
            elif isinstance(decoded, DirectoryUpsert):
                await directory.apply_event(conn, decoded)
