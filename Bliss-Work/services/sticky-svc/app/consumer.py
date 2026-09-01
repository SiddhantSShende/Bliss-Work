"""Keeps sticky_pins in step with the task lifecycle.

Subscribes to task.events.v1 and applies `app.transitions.plan_transition` — the
whole rule lives there, pure and unit-tested, so this file is only the plumbing
that gets events to it and writes the answer down.

Structure (reconnect-with-backoff, batched fetch, manual offset commit, per-event
dedup claim) deliberately mirrors task-svc/app/consumer.py. A consumer that
handles broker blips differently from its neighbours is one that fails in a way
nobody on the team has debugged before.
"""

from __future__ import annotations

import asyncio
import contextlib
import json

from aiokafka import AIOKafkaConsumer
from kafka_security import kafka_security_kwargs
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from .config import settings
from .db import session, set_bypass_rls
from .logging_setup import log
from .transitions import ASSIGNED, PinRow, plan_transition

_GROUP_ID = "sticky-svc"
TASK_TOPIC = "task.events.v1"

# Kafka reconnect backoff: doubles from _RECONNECT_BASE up to _RECONNECT_MAX.
_RECONNECT_BASE = 1.0
_RECONNECT_MAX = 30.0

_MAX_BATCH_SIZE = 200
# A latency budget, and a tight one on purpose: this delay is part of how long
# a person waits between being given a task and seeing it appear on their
# desktop. 250ms is far below anything noticeable, and matches task-svc.
_BATCH_LINGER_MS = 250


class StickyConsumer:
    """Projects task.events.v1 into the durable pin table."""

    def __init__(self) -> None:
        self._consumer: AIOKafkaConsumer | None = None
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        # Deliberately does NOT connect here: compose's depends_on does not
        # apply when the daemon restarts containers by restart-policy, so the
        # broker may well not be up yet. _run connects with backoff instead.
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="sticky-svc-consumer")
        log.info("consumer_started", topics=[TASK_TOPIC])

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
            TASK_TOPIC,
            bootstrap_servers=settings.kafka_brokers,
            **kafka_security_kwargs(),
            group_id=_GROUP_ID,
            # Manual commit only after every handler in the batch has committed
            # its own transaction, so a crash mid-handle redelivers rather than
            # advancing the offset past a pin that was never opened.
            enable_auto_commit=False,
            # earliest, so a freshly deployed replica back-fills pins for tasks
            # assigned before it existed rather than starting blind.
            auto_offset_reset="earliest",
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
                log.warning(
                    "kafka_connect_retry", attempt=attempt, next_delay_s=delay, error=str(exc)
                )
                await self._stop_quietly(consumer)
                await self._sleep_or_stop(delay)
                continue

            attempt = 0
            self._consumer = consumer
            log.info("consumer_connected", topics=[TASK_TOPIC])
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
            while not self._stop.is_set():
                batches = await consumer.getmany(
                    timeout_ms=_BATCH_LINGER_MS, max_records=_MAX_BATCH_SIZE
                )
                if not batches:
                    continue
                for _tp, messages in batches.items():
                    for msg in messages:
                        try:
                            await self.handle(msg.value)
                        except Exception as exc:  # noqa: BLE001
                            # One bad event costs one pin, not the batch. Logged
                            # with the id so it can be replayed by hand.
                            log.warning(
                                "sticky_event_failed",
                                error=str(exc),
                                event_id=(msg.value or {}).get("eventId"),
                            )
                if self._stop.is_set():
                    break
                await consumer.commit()
        except asyncio.CancelledError:
            pass

    async def handle(self, event: dict) -> None:
        """Apply one task event to the pin table."""
        if not isinstance(event, dict):
            return
        event_type = event.get("type", "")
        event_id = event.get("eventId")
        org_id = event.get("orgId")
        task_id = event.get("taskId")
        assignee_id = event.get("assigneeId")
        if not (event_id and org_id and task_id and assignee_id):
            return

        version = event.get("statusVersion")
        version = version if isinstance(version, int) else 0

        async with session() as db:
            # A cross-org projection worker: the org comes from the event, not
            # from a request principal, so RLS is bypassed for this trusted
            # transaction. Set FIRST, so the WITH CHECK on the INSERT passes.
            await set_bypass_rls(db)
            if await _claim(db, str(event_id)) is False:
                return

            row = (
                await db.execute(
                    text(
                        "SELECT status, assignee_status, status_version FROM sticky_pins "
                        " WHERE org_id = :org AND assignee_id = :me AND task_id = :task "
                        " FOR UPDATE"
                    ),
                    {"org": org_id, "me": assignee_id, "task": task_id},
                )
            ).first()

            current = (
                PinRow(
                    status=row.status,
                    assignee_status=row.assignee_status,
                    status_version=row.status_version,
                )
                if row is not None
                else None
            )

            plan = plan_transition(current, event_type, version)
            if plan is None:
                # Still commit: the dedup claim above must stick, or a
                # redelivery would re-do this work every time.
                await db.commit()
                return

            params = {
                "org": org_id,
                "me": assignee_id,
                "task": task_id,
                "sender": event.get("senderId"),
                "status": plan.status,
                "assignee_status": plan.assignee_status,
                "version": plan.status_version,
                "reason": plan.close_reason,
            }
            if current is None:
                await db.execute(
                    text(
                        "INSERT INTO sticky_pins "
                        "  (org_id, assignee_id, task_id, sender_id, status, "
                        "   assignee_status, status_version) "
                        "VALUES (:org, :me, :task, :sender, :status, :assignee_status, :version) "
                        "ON CONFLICT (org_id, assignee_id, task_id) DO NOTHING"
                    ),
                    params,
                )
            else:
                await db.execute(
                    text(
                        "UPDATE sticky_pins SET "
                        "  status = :status, "
                        "  assignee_status = :assignee_status, "
                        "  status_version = :version, "
                        "  close_reason = :reason, "
                        "  closed_at = CASE WHEN :status = 'CLOSED' THEN now() ELSE NULL END, "
                        # A reopened pin has never been delivered in its new
                        # life, so the watchdog must be able to see it again.
                        "  last_delivered_at = CASE WHEN :is_assign THEN NULL "
                        "                          ELSE last_delivered_at END, "
                        "  delivery_attempts = CASE WHEN :is_assign THEN 0 "
                        "                          ELSE delivery_attempts END, "
                        "  last_event_at = now() "
                        " WHERE org_id = :org AND assignee_id = :me AND task_id = :task"
                    ),
                    {**params, "is_assign": event_type == ASSIGNED},
                )
            await db.commit()


async def _claim(db, event_id: str) -> bool:
    """Insert into consumed_events; return True if we successfully claimed it.

    Kafka is at-least-once, so this is what stops a redelivery re-applying an
    event. The version guard in plan_transition is the second line of defence,
    for the case where a claim row has aged out.
    """
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


consumer = StickyConsumer()
