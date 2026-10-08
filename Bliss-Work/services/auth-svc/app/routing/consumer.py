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
from prometheus_client import Counter
from sqlalchemy.exc import DataError, DBAPIError, IntegrityError

from kafka_security import kafka_security_kwargs

from ..config import settings
from ..db import engine
from ..logging_config import log
from . import directory
from .events import TOPIC_ROUTING, CapacityReport, DirectoryUpsert, parse

# Backoff between reconnect attempts. The consumer must survive Kafka being
# unavailable at startup: compose ordering does not apply on a host reboot, and a
# consumer that exited on a connection failure would leave this site's directory
# frozen at whatever it knew an hour ago.
_RETRY_SECONDS = 5.0

# Backoff while ONE event cannot be written (database down, pool exhausted,
# statement timeout). The consumer stays on that event — committing past it
# would lose the directory row for good — so this bounds how hard it pushes on a
# struggling database, not how long it is willing to wait.
_APPLY_RETRY_BASE_SECONDS = 1.0
_APPLY_RETRY_MAX_SECONDS = 30.0

SKIPPED = Counter(
    "auth_routing_events_skipped_total",
    "Routing events dropped as permanently unprocessable, by reason.",
    ["reason"],
)
APPLY_RETRIES = Counter(
    "auth_routing_apply_retries_total",
    "Routing event writes retried after a transient failure.",
)


def _is_permanent_db_error(exc: Exception) -> bool:
    """True when Postgres rejected the event's VALUES, so no retry can succeed.

    With the asyncpg driver a bad uuid or `invalid input syntax` surfaces as a
    bare `DBAPIError`, not SQLAlchemy's `DataError`, so the SQLSTATE class is
    checked too: 22 = data exception, 23 = integrity constraint violation.
    Connection loss (08), resources (53), timeouts (57) and deadlocks (40)
    stay transient.
    """
    if isinstance(exc, (DataError, IntegrityError)):
        return True
    if isinstance(exc, DBAPIError):
        state = getattr(exc.orig, "sqlstate", None) or getattr(exc.orig, "pgcode", None)
        return isinstance(state, str) and state[:2] in ("22", "23")
    return False


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
            if not await self._process(message):
                # Shutting down mid-retry: the event is NOT applied, so it must
                # not be committed — the next start redelivers it.
                return
            # Committed AFTER the write (or a deliberate skip). A crash between
            # the two replays the event, which the version check makes a no-op.
            await consumer.commit()

    async def _process(self, message) -> bool:
        """Apply one message. True when it is safe to commit past it — written,
        or permanently unprocessable and skipped; False if told to stop first.

        Two very different failures live here, and only one may be skipped:

          * PERMANENT — the event itself is bad (not JSON, not an object, or the
            database rejects its values outright). Retrying cannot change the
            outcome, and blocking on it would freeze every key at this site, so it
            is logged, counted and dropped. The cost is one stale key that
            answers "retry".
          * TRANSIENT — the event is fine and the database is not (connection
            lost, pool timeout, statement timeout). Skipping it would drop a
            routing row for good — an invite redemption then answers 503 until the
            invite expires — so it is retried, with backoff, until it is written.
        """
        try:
            payload = json.loads(message.value)
            if not isinstance(payload, dict):
                raise ValueError("routing event is not a JSON object")
            decoded = parse(payload)
        except Exception as err:  # noqa: BLE001 — anything undecodable is a bad event
            self._skip("malformed", err, message)
            return True
        if decoded is None:
            return True  # an event type this site does not act on

        attempt = 0
        while True:
            try:
                await self._apply(decoded)
                return True
            except Exception as err:  # noqa: BLE001 — classified below
                if _is_permanent_db_error(err):
                    self._skip("rejected_by_db", err, message)
                    return True
                attempt += 1
                delay = min(
                    _APPLY_RETRY_MAX_SECONDS, _APPLY_RETRY_BASE_SECONDS * 2 ** (attempt - 1)
                )
                APPLY_RETRIES.inc()
                log.warning(
                    "routing_event_apply_retry",
                    err=str(err),
                    offset=message.offset,
                    attempt=attempt,
                    retry_in=delay,
                )
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=delay)
                    return False  # stop was set while waiting
                except asyncio.TimeoutError:
                    pass

    @staticmethod
    def _skip(reason: str, err: Exception, message) -> None:
        SKIPPED.labels(reason=reason).inc()
        log.error("routing_event_skipped", reason=reason, err=str(err), offset=message.offset)

    async def _apply(self, decoded: DirectoryUpsert | CapacityReport) -> None:
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
