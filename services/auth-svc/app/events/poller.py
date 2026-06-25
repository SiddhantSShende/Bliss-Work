"""In-process background poller: drains the outbox to Kafka every ~500ms."""
from __future__ import annotations

import asyncio
import json

from aiokafka import AIOKafkaProducer
from opentelemetry import trace
from opentelemetry.trace import SpanKind
from sqlalchemy import text

from ..config import settings
from ..db import engine
from ..logging_config import log
from ..tracing import inject_headers

_tracer = trace.get_tracer(__name__)

POLL_INTERVAL_SECONDS = 0.5
BATCH_LIMIT = 100

# Backoff applied on consecutive drain failures (e.g. broker down) so we stop
# hammering Kafka / flooding logs. Doubles from POLL_INTERVAL up to the cap.
BACKOFF_CAP_SECONDS = 60.0
# After the first failure log, only re-log every Nth consecutive failure.
FAILURE_LOG_EVERY = 10


class OutboxPoller:
    def __init__(self) -> None:
        self._producer: AIOKafkaProducer | None = None
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        self._producer = AIOKafkaProducer(
            bootstrap_servers=settings.kafka_brokers,
            enable_idempotence=True,
            acks="all",
        )
        await self._producer.start()
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="outbox-poller")
        log.info("outbox_poller_started")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except asyncio.TimeoutError:
                self._task.cancel()
        if self._producer is not None:
            await self._producer.stop()
        log.info("outbox_poller_stopped")

    async def _run(self) -> None:
        consecutive_failures = 0
        while not self._stop.is_set():
            try:
                await self._drain_once()
                consecutive_failures = 0
                sleep_for = POLL_INTERVAL_SECONDS
            except Exception as exc:  # noqa: BLE001 - keep the loop alive
                consecutive_failures += 1
                # Log the first failure, then suppress repeats: only re-log
                # every FAILURE_LOG_EVERY consecutive failures to avoid flooding.
                if consecutive_failures == 1 or consecutive_failures % FAILURE_LOG_EVERY == 0:
                    log.warning(
                        "outbox_drain_error",
                        error=str(exc),
                        consecutive_failures=consecutive_failures,
                    )
                # Exponential backoff (POLL_INTERVAL, 2x, 4x, ...) capped at
                # BACKOFF_CAP_SECONDS so a down broker is retried calmly.
                sleep_for = min(
                    POLL_INTERVAL_SECONDS * (2 ** (consecutive_failures - 1)),
                    BACKOFF_CAP_SECONDS,
                )
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=sleep_for)
            except asyncio.TimeoutError:
                pass

    async def _drain_once(self) -> None:
        assert self._producer is not None
        async with engine.begin() as conn:
            # Cross-org background worker: drains every org's events from the
            # shared `outbox`. outbox itself has no RLS, but set bypass so this
            # poller is never silently fenced if an RLS table is ever read here.
            await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
            rows = (
                await conn.execute(
                    text(
                        """
                        SELECT id, topic, kafka_key, payload
                        FROM outbox
                        WHERE published_at IS NULL
                        ORDER BY created_at
                        LIMIT :limit
                        FOR UPDATE SKIP LOCKED
                        """
                    ),
                    {"limit": BATCH_LIMIT},
                )
            ).all()

            if not rows:
                return

            published_ids: list[str] = []
            for row in rows:
                payload = row.payload
                if isinstance(payload, (dict, list)):
                    value = json.dumps(payload).encode("utf-8")
                else:
                    value = str(payload).encode("utf-8")
                # PRODUCER span: inject the current trace context as W3C
                # traceparent Kafka headers so the consumer continues the
                # trace. No-op (global no-op tracer) when tracing is off.
                with _tracer.start_as_current_span(
                    f"{row.topic} send", kind=SpanKind.PRODUCER
                ):
                    await self._producer.send_and_wait(
                        topic=row.topic,
                        key=row.kafka_key.encode("utf-8"),
                        value=value,
                        headers=inject_headers(),
                    )
                published_ids.append(str(row.id))

            await conn.execute(
                text(
                    "UPDATE outbox SET published_at = now() WHERE id = ANY(:ids)"
                ),
                {"ids": published_ids},
            )
            log.info("outbox_published", count=len(published_ids))
