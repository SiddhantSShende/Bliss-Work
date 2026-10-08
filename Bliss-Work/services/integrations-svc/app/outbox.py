from __future__ import annotations

import asyncio
import json

from aiokafka import AIOKafkaProducer
from opentelemetry import trace
from opentelemetry.trace import SpanKind
from sqlalchemy import text
from kafka_lazy_producer import LazyKafkaProducer
from kafka_security import kafka_security_kwargs

from .config import settings
from .db import session, set_bypass_rls
from .logging_setup import log
from .outbox_dlq import (
    MAX_PUBLISH_ATTEMPTS,
    MAX_PUBLISH_BYTES,
    payload_bytes,
    quarantine_oversize,
    record_publish_failure,
)
from tracing import inject_headers

_tracer = trace.get_tracer(__name__)

_POLL_INTERVAL = 0.5  # seconds
_BACKOFF_CAP = 30.0  # seconds — max wait between retries after a publish failure
# After the first failure, only re-log every Nth consecutive one.
_FAILURE_LOG_EVERY = 10

# One replica drains at a time. Hashed to the bigint advisory-lock key (same
# technique as MIGRATION_LOCK_KEY in db.py); service-specific so a shared
# database would show up as contention rather than as two services skipping
# each other's cycles.
_DRAIN_LOCK_KEY = "taskboard:integrations:outbox-drain"


class OutboxPoller:
    """In-process transactional-outbox publisher.

    Loops every ~500ms, selects unpublished rows, produces each payload to its
    topic with its key, then marks the row published. This is the ONLY path
    that emits events to Kafka.
    """

    def __init__(self) -> None:
        self._lazy_producer = LazyKafkaProducer(
            bootstrap_servers=settings.kafka_brokers,
            security_kwargs=kafka_security_kwargs(),
            value_serializer=lambda v: json.dumps(v).encode("utf-8"),
            key_serializer=lambda k: k.encode("utf-8") if k is not None else None,
        )
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        # Deliberately does NOT connect to Kafka. compose `depends_on` ordering
        # only applies to `docker compose up` — on a host reboot the daemon
        # restarts containers by restart-policy alone and ignores it, so this
        # service races the broker's boot. Connecting here made that race fatal
        # ("Application startup failed. Exiting.") and crash-looped the
        # container until Kafka came up. The connect now happens on first drain,
        # under the backoff _run already applies. See
        # services/shared/kafka_lazy_producer/kafka_lazy_producer.py.
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="outbox-poller")
        log.info("outbox_poller_started")

    async def _ensure_producer(self) -> AIOKafkaProducer:
        """Connect on first use. Failures propagate to _run's backoff."""
        return await self._lazy_producer.ensure(
            on_connected=lambda: log.info("outbox_producer_connected")
        )

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except asyncio.TimeoutError:
                self._task.cancel()
        await self._lazy_producer.stop()
        log.info("outbox_poller_stopped")

    async def _run(self) -> None:
        # Backoff grows on consecutive Kafka publish failures (capped) so a
        # broker outage doesn't hammer it every 0.5s; resets on any success.
        backoff = _POLL_INTERVAL
        consecutive_failures = 0
        while not self._stop.is_set():
            try:
                published = await self._drain_once()
                if consecutive_failures:
                    log.info("outbox_poll_recovered", after_failures=consecutive_failures)
                    consecutive_failures = 0
                backoff = _POLL_INTERVAL
                if published == 0:
                    await asyncio.wait_for(self._stop.wait(), timeout=_POLL_INTERVAL)
            except asyncio.TimeoutError:
                continue
            except Exception as exc:  # noqa: BLE001 — keep the poller alive
                consecutive_failures += 1
                # Full traceback ONCE, then suppress to a one-line warning every
                # _FAILURE_LOG_EVERY-th repeat. A broker outage otherwise emits a
                # multi-line traceback per backoff tick — the same error storm
                # the backoff itself exists to prevent, and the thing a real
                # incident would have to be spotted in.
                if consecutive_failures == 1:
                    log.exception("outbox_poll_error", backoff=backoff, consecutive_failures=1)
                elif consecutive_failures % _FAILURE_LOG_EVERY == 0:
                    log.warning(
                        "outbox_poll_error",
                        error=str(exc),
                        backoff=backoff,
                        consecutive_failures=consecutive_failures,
                    )
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=backoff)
                except asyncio.TimeoutError:
                    pass
                backoff = min(backoff * 2, _BACKOFF_CAP)

    async def _drain_once(self) -> int:
        producer = await self._ensure_producer()
        async with session() as db:
            # Cross-org background worker. The outbox table itself carries no
            # org_id (not RLS-protected), but we bypass RLS for this trusted
            # transaction so the poller drains every org's events and stays
            # correct if it ever has to touch an org-scoped table. Set FIRST.
            await set_bypass_rls(db)
            # Serialise drains across replicas, per-key ordering depends on it.
            # SKIP LOCKED alone lets replica B claim and publish the NEWER rows
            # of a key while replica A is still sending (or retrying) that
            # key's OLDER ones, so a consumer can see e.g. a deactivation before
            # the creation. A transaction-level advisory lock means only one
            # replica drains at a time and the other skips this cycle (it polls
            # again in _POLL_INTERVAL). Released automatically at commit,
            # rollback, or if this process or its connection dies, and held
            # no longer than one drain: publishing is bounded by the producer's
            # request timeout and stops at the first failure. SKIP LOCKED below
            # stays as a harmless belt-and-braces.
            if not (
                await db.execute(
                    text("SELECT pg_try_advisory_xact_lock(hashtext(:k)::bigint)"),
                    {"k": _DRAIN_LOCK_KEY},
                )
            ).scalar_one():
                return 0
            rows = (
                await db.execute(
                    text(
                        # FOR UPDATE SKIP LOCKED so a second replica claims a
                        # different batch rather than racing this one. See the
                        # note in task-svc/app/outbox.py — same poller, same
                        # reasoning, same 100-row batch bound.
                        "SELECT id, topic, kafka_key, payload FROM outbox "
                        "WHERE published_at IS NULL AND dead_lettered_at IS NULL "
                        "ORDER BY created_at LIMIT 100 "
                        "FOR UPDATE SKIP LOCKED"
                    )
                )
            ).all()

            if not rows:
                return 0

            # Split before producing. An oversized row is knowable from its
            # length, so there is no reason to discover it from a failed round
            # trip — and a producer that refuses one message refuses the request
            # it travelled in, so an unfiltered row blocks healthy rows too.
            oversize = [r for r in rows if payload_bytes(r.payload) > MAX_PUBLISH_BYTES]
            if oversize:
                # On THIS session, deliberately — not a second one. `db` holds
                # FOR UPDATE row locks on every row of the batch, so a second
                # connection UPDATEing the oversized rows would wait on them
                # until statement_timeout (self-deadlock: the row was never
                # quarantined and every tick errored). Nor can `db` be
                # committed here: that would release the locks, and the drain
                # advisory lock, on the REST of the batch while it is still
                # queued to be produced below. The UPDATE rides this
                # transaction and commits with it, after the send loop.
                await quarantine_oversize(db, [str(r.id) for r in oversize])
            oversize_ids = {r.id for r in oversize}
            rows = [r for r in rows if r.id not in oversize_ids]

            published_ids: list[str] = []
            send_failed: BaseException | None = None
            failed_ids: list[str] = []
            for row in rows:
                payload = row.payload
                if isinstance(payload, str):
                    payload = json.loads(payload)
                try:
                    # PRODUCER span: inject the current trace context as W3C
                    # traceparent Kafka headers so the consumer continues the
                    # trace. No-op (global no-op tracer) when tracing is off.
                    with _tracer.start_as_current_span(
                        f"{row.topic} send", kind=SpanKind.PRODUCER
                    ):
                        await producer.send_and_wait(
                            row.topic,
                            value=payload,
                            key=row.kafka_key,
                            headers=inject_headers(),
                        )
                except Exception as exc:  # noqa: BLE001 — classified below
                    # Do NOT mark this row published — leave published_at NULL so
                    # it's retried on the next drain. Stop draining the rest of
                    # the batch in order to preserve per-key ordering.
                    log.exception("outbox_publish_failed", outbox_id=str(row.id))
                    send_failed = exc
                    # Only the row the broker refused is charged an attempt. The rows behind
                    # it were never offered, and charging them made one poison row
                    # dead-letter its whole batch together.
                    failed_ids = [str(row.id)]
                    break
                # Only record as published AFTER a successful send_and_wait.
                published_ids.append(str(row.id))

            if published_ids:
                await db.execute(
                    text("UPDATE outbox SET published_at = now() WHERE id = ANY(:ids)"),
                    {"ids": published_ids},
                )
            # Commit when there is anything to persist — including a batch whose
            # only outcome was quarantining oversized rows (otherwise the session
            # closes uncommitted and the quarantine rolls back).
            if published_ids or oversize:
                await db.commit()
            if oversize:
                # ERROR, not warning: these are events a user's action produced
                # that no consumer will ever see, and nothing else reports it.
                log.error(
                    "outbox_dead_lettered_oversize",
                    count=len(oversize),
                    limit_bytes=MAX_PUBLISH_BYTES,
                    detail="events accepted but never published",
                )
            if published_ids:
                log.info("outbox_published", count=len(published_ids))

        if send_failed is None:
            return len(published_ids)

        # A SEPARATE session, deliberately. The attempt counter has to COMMIT
        # even though the failed rows stay unpublished; writing it on the block
        # above would tie it to that transaction, and on any path where that
        # rolls back the counter would vanish — leaving the row retrying forever
        # with a permanently zero attempt count, which is the exact bug this
        # replaces. See app/outbox_dlq.py.
        async with session() as db:
            await set_bypass_rls(db)
            quarantined = await record_publish_failure(db, failed_ids, send_failed)
            await db.commit()
        if quarantined:
            log.error(
                "outbox_dead_lettered_after_retries",
                count=quarantined,
                attempts=MAX_PUBLISH_ATTEMPTS,
                error=str(send_failed)[:200],
                detail="events accepted but never published",
            )
        # Surface to _run so it applies exponential backoff before the next
        # attempt; the already-published rows above are durable.
        raise RuntimeError("outbox publish failed; backing off") from send_failed


poller = OutboxPoller()
