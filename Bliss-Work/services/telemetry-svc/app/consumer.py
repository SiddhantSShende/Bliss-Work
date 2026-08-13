"""Kafka → activity_events.

Structurally the same consumer as services/task-svc/app/consumer.py — manual
commit only after the handler's DB commit, dedup on eventId BEFORE any side
effect, reconnect with exponential backoff, and a handler that can never kill
the loop. The differences worth knowing are both deliberate:

  * It subscribes to FIVE topics, because the activity record spans the whole
    product. What each event becomes is declared in event_map.py, not here.

  * `auto_offset_reset` is "latest", NOT "earliest". A brand-new consumer group
    pointed at "earliest" would replay every event these topics have ever held
    into partitions that were never created for those dates — turning a routine
    first deploy into a flood. Telemetry starts when it is switched on; it is
    not a backfill tool.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
from datetime import datetime

from aiokafka import AIOKafkaConsumer
from opentelemetry import trace
from opentelemetry.trace import SpanKind
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from .config import settings
from .db import session, set_bypass_rls
from .event_map import MAPPINGS, preview_of
from .ingest import ActivityRow, clamp_occurred_at, insert_events
from .logging_setup import log
from .tracing import extract_context

_tracer = trace.get_tracer(__name__)

_GROUP_ID = "telemetry-svc"
TOPICS = (
    "auth.events",
    "task.events.v1",
    "messaging.events.v1",
    "notification.events.v1",
    "integration.events.v1",
)

_RECONNECT_BASE = 1.0
_RECONNECT_MAX = 30.0
_MAX_ID_LEN = 128


class TelemetryConsumer:
    def __init__(self) -> None:
        self._consumer: AIOKafkaConsumer | None = None
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        # Deliberately does not connect here: compose's depends_on does not apply
        # when the daemon restarts containers by restart-policy, so the broker
        # may not be up yet. _run connects with backoff and keeps reconnecting.
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="telemetry-consumer")
        log.info("consumer_started", topics=list(TOPICS))

    async def stop(self) -> None:
        self._stop.set()
        if self._consumer is not None:
            await self._stop_quietly(self._consumer)
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
        log.info("consumer_stopped")

    def _build_consumer(self) -> AIOKafkaConsumer:
        return AIOKafkaConsumer(
            *TOPICS,
            bootstrap_servers=settings.kafka_brokers,
            group_id=_GROUP_ID,
            enable_auto_commit=False,
            auto_offset_reset="latest",  # see the module docstring
            value_deserializer=lambda v: json.loads(v.decode("utf-8")),
        )

    @staticmethod
    async def _stop_quietly(consumer: AIOKafkaConsumer) -> None:
        with contextlib.suppress(Exception):
            await consumer.stop()

    async def _sleep_or_stop(self, delay: float) -> None:
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._stop.wait(), timeout=delay)

    async def _run(self) -> None:
        attempt = 0
        while not self._stop.is_set():
            consumer = self._build_consumer()
            try:
                await consumer.start()
            except Exception as exc:  # noqa: BLE001 — broker not up yet; retry
                attempt += 1
                delay = min(_RECONNECT_BASE * (2 ** (attempt - 1)), _RECONNECT_MAX)
                log.warning("kafka_connect_retry", attempt=attempt,
                            next_delay_s=delay, error=str(exc))
                await self._stop_quietly(consumer)
                await self._sleep_or_stop(delay)
                continue

            attempt = 0
            self._consumer = consumer
            log.info("consumer_connected", topics=list(TOPICS))
            try:
                await self._consume_loop(consumer)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — reconnect, don't die
                log.warning("consume_loop_error_reconnecting", error=str(exc))
            finally:
                self._consumer = None
                await self._stop_quietly(consumer)

    async def _consume_loop(self, consumer: AIOKafkaConsumer) -> None:
        try:
            async for msg in consumer:
                if self._stop.is_set():
                    break
                try:
                    ctx = extract_context(msg.headers)
                    with _tracer.start_as_current_span(
                        f"{msg.topic} process", context=ctx, kind=SpanKind.CONSUMER
                    ):
                        await self._handle(msg.value)
                except Exception:  # noqa: BLE001 — never kill the consumer loop
                    # Do NOT commit: leave the offset so this event redelivers.
                    event = msg.value if isinstance(msg.value, dict) else {}
                    log.exception(
                        "event_handle_error",
                        event_type=event.get("type"),
                        org_id=event.get("orgId"),
                        event_id=event.get("eventId"),
                    )
                    continue
                await consumer.commit()
        except asyncio.CancelledError:
            pass

    async def _handle(self, event: object) -> None:
        if not isinstance(event, dict):
            return
        event_id = event.get("eventId")
        if not event_id:
            return

        # A membership ending must also end its agents. A paired desktop sampler
        # or browser extension holds a long-lived secret that is NOT a session,
        # so revoking the person's tokens does nothing to it — without this, a
        # removed member's laptop keeps reporting their activity to a workspace
        # they are no longer part of.
        if event.get("type") in ("user.removed", "user.deactivated"):
            await self._revoke_agent_tokens(event, str(event_id))
            return

        row = to_activity_row(event)
        if row is None:
            return

        async with session() as db:
            # Cross-org background worker: it projects events for EVERY org off
            # one stream, so there is no single request org to scope to. Set
            # FIRST so the WITH CHECK on the insert passes.
            await set_bypass_rls(db)
            if await _claim(db, str(event_id)) is False:
                return
            await insert_events(db, [row])
            await db.commit()

    async def _revoke_agent_tokens(self, event: dict, event_id: str) -> None:
        user_id = _bounded(event.get("userId"))
        if not user_id:
            return
        async with session() as db:
            await set_bypass_rls(db)
            if await _claim(db, event_id) is False:
                return
            result = await db.execute(
                text(
                    "UPDATE ingest_tokens SET revoked_at = now() "
                    "WHERE user_id = :uid AND revoked_at IS NULL"
                ),
                {"uid": user_id},
            )
            await db.commit()
        if result.rowcount:
            log.info("agent_tokens_revoked", user_id=user_id, count=result.rowcount)


def to_activity_row(event: object) -> ActivityRow | None:
    """Translate one domain event, or None when it is not mapped.

    Pure — no DB, no clock beyond the skew clamp — so the whole mapping table can
    be tested without a broker or a database.
    """
    if not isinstance(event, dict):
        return None
    mapping = MAPPINGS.get(str(event.get("type") or ""))
    if mapping is None:
        return None
    org_id = _bounded(event.get("orgId"))
    user_id = _bounded(event.get(mapping.actor_field))
    if not org_id or not user_id:
        return None

    detail: dict[str, object] = {}
    if mapping.preview_field:
        preview = preview_of(event.get(mapping.preview_field))
        if preview:
            detail["preview"] = preview

    return ActivityRow(
        org_id=org_id,
        user_id=user_id,
        occurred_at=clamp_occurred_at(_parse_ts(event.get("occurredAt"))),
        source="server",
        category=mapping.category,
        action=mapping.action,
        surface=mapping.surface,
        target_kind=mapping.target_kind,
        target_id=_bounded(event.get(mapping.target_field)) if mapping.target_field else None,
        detail=detail,
    )


def _bounded(value: object) -> str | None:
    """Ids arrive from other services, so they are trusted-ish — but never
    unbounded. A hostile or buggy producer must not be able to write a megabyte
    into an indexed column."""
    if not isinstance(value, str) or not value:
        return None
    return value[:_MAX_ID_LEN]


def _parse_ts(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


async def _claim(db, event_id: str) -> bool:
    """Insert into consumed_events; True if this process claimed the event."""
    try:
        await db.execute(
            text("INSERT INTO consumed_events (event_id) VALUES (:eid)"),
            {"eid": event_id},
        )
        return True
    except IntegrityError:
        await db.rollback()
        log.info("event_duplicate_skipped", event_id=event_id)
        return False


consumer = TelemetryConsumer()
