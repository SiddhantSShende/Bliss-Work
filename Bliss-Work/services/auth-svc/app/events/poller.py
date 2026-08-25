"""In-process background poller: drains the outbox to Kafka every ~500ms."""
from __future__ import annotations

import asyncio
import contextlib
import json

from aiokafka import AIOKafkaProducer
from opentelemetry import trace
from opentelemetry.trace import SpanKind
from sqlalchemy import text

from kafka_security import kafka_security_kwargs

from ..config import settings
from ..db import engine
from ..logging_config import log
from tracing import inject_headers
from .outbox import SECRET_EVENT_TYPES
from .outbox_dlq import (
    MAX_PUBLISH_ATTEMPTS,
    MAX_PUBLISH_BYTES,
    payload_bytes,
    quarantine_oversize,
    record_publish_failure,
)

_tracer = trace.get_tracer(__name__)

POLL_INTERVAL_SECONDS = 0.5
BATCH_LIMIT = 100

# Raw secret URL fields stripped from SECRET_EVENT_TYPES payloads before
# Kafka publish — email-worker pulls the secret back via an authenticated
# internal call instead (see auth-svc/app/routes/internal.py's outbox-events
# endpoint). See docs/AUTH_AUTHZ_REMEDIATION_PLAN.md, Phase 3.
_SECRET_URL_FIELDS = ("resetUrl", "verifyUrl", "inviteUrl")


def _redact_for_publish(row_id, payload):
    """Strip the raw secret URL from the three secret-bearing event types
    before they're published to Kafka, adding `outboxId` so email-worker can
    pull the secret back via GET /internal/outbox-events/{outboxId}. Every
    other event type (and the stored outbox row itself) is unaffected — the
    row keeps its full payload until the redact-on-expiry sweep removes it.
    """
    if not isinstance(payload, dict) or payload.get("type") not in SECRET_EVENT_TYPES:
        return payload
    redacted = {k: v for k, v in payload.items() if k not in _SECRET_URL_FIELDS}
    redacted["outboxId"] = str(row_id)
    return redacted

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
        # Deliberately does NOT connect to Kafka. compose `depends_on` ordering
        # only applies to `docker compose up` — on a host reboot the daemon
        # restarts containers by restart-policy alone and ignores it, so this
        # service races the broker's boot. Connecting here made that race fatal
        # ("Application startup failed. Exiting.") and crash-looped the
        # container until Kafka came up. The connect now happens on first drain,
        # under the backoff _run already applies.
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="outbox-poller")
        log.info("outbox_poller_started")

    async def _ensure_producer(self) -> AIOKafkaProducer:
        """Connect on first use. Failures propagate to _run's backoff."""
        if self._producer is not None:
            return self._producer
        producer = AIOKafkaProducer(
            bootstrap_servers=settings.kafka_brokers,
            # TLS/SASL when KAFKA_SECURITY_PROTOCOL asks for it; empty otherwise.
            **kafka_security_kwargs(),
            enable_idempotence=True,
            acks="all",
        )
        try:
            await producer.start()
        except Exception:
            # A producer whose start() failed is not reusable — discard it so
            # the next attempt builds a fresh one.
            with contextlib.suppress(Exception):
                await producer.stop()
            raise
        self._producer = producer
        log.info("outbox_producer_connected")
        return producer

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
        """Publish one batch.

        ── Why a publish failure is now classified ──────────────────────────
        This used to let any send exception propagate out of the `engine.begin()`
        block. The transaction rolled back, nothing was marked published, and the
        next tick re-claimed the identical rows — correct for a broker blip and
        fatal for a row the broker will never accept, because the claim is
        `ORDER BY created_at` and that row is therefore at the head of the queue
        on every tick, forever, with every event behind it.

        Size is checked up front (deterministic, and a producer refuses the whole
        batch over one oversized message); everything else gets an attempt
        counter. See app/events/outbox_dlq.py.
        """
        producer = await self._ensure_producer()
        failed_ids: list[str] = []
        failure: BaseException | None = None

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
                        WHERE published_at IS NULL AND dead_lettered_at IS NULL
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

            # Split before producing: an oversized row is knowable from its
            # length, so there is no reason to discover it from a failed round
            # trip — or to let it block the rows batched with it.
            oversize = [r for r in rows if payload_bytes(r.payload) > MAX_PUBLISH_BYTES]
            if oversize:
                await quarantine_oversize(conn, [str(r.id) for r in oversize])
                # ERROR, not warning: these are events a user's action produced
                # that no consumer will ever see. Nothing else reports it.
                log.error(
                    "outbox_dead_lettered_oversize",
                    count=len(oversize),
                    limit_bytes=MAX_PUBLISH_BYTES,
                    detail="events accepted but never published",
                )
            oversize_ids = {r.id for r in oversize}
            sendable = [r for r in rows if r.id not in oversize_ids]

            published_ids: list[str] = []
            for row in sendable:
                payload = _redact_for_publish(row.id, row.payload)
                if isinstance(payload, (dict, list)):
                    value = json.dumps(payload).encode("utf-8")
                else:
                    value = str(payload).encode("utf-8")
                try:
                    # PRODUCER span: inject the current trace context as W3C
                    # traceparent Kafka headers so the consumer continues the
                    # trace. No-op (global no-op tracer) when tracing is off.
                    with _tracer.start_as_current_span(
                        f"{row.topic} send", kind=SpanKind.PRODUCER
                    ):
                        await producer.send_and_wait(
                            topic=row.topic,
                            key=row.kafka_key.encode("utf-8"),
                            value=value,
                            headers=inject_headers(),
                        )
                except Exception as exc:  # noqa: BLE001 — classified below
                    # Stop at the first failure to preserve per-key ordering:
                    # publishing row N+1 after N failed would deliver a thread's
                    # events out of order. The prefix that DID succeed is still
                    # marked below, so progress is never lost.
                    failure = exc
                    failed_ids = [str(r.id) for r in sendable[len(published_ids):]]
                    break
                published_ids.append(str(row.id))

            if published_ids:
                await conn.execute(
                    text(
                        "UPDATE outbox SET published_at = now() WHERE id = ANY(:ids)"
                    ),
                    {"ids": published_ids},
                )
                log.info("outbox_published", count=len(published_ids))

        if failure is None:
            return

        # A SEPARATE transaction, deliberately. The counter has to be committed
        # even though the rows stay unpublished; recording it inside the block
        # above would tie it to the same commit as the successful prefix, and on
        # any path where that rolls back the counter would vanish — leaving the
        # row retrying forever with a permanently zero attempt count.
        async with engine.begin() as conn:
            quarantined = await record_publish_failure(conn, failed_ids, failure)
        if quarantined:
            log.error(
                "outbox_dead_lettered_after_retries",
                count=quarantined,
                attempts=MAX_PUBLISH_ATTEMPTS,
                error=str(failure)[:200],
                detail="events accepted but never published",
            )
        # Re-raised so _run applies its existing backoff: the common cause is a
        # broker that is down, and hammering it every 500 ms helps nobody.
        raise failure
