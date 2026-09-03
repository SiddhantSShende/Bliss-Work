"""Keeps sticky_pins in step with the task lifecycle.

Subscribes to task.events.v1 and applies `app.transitions.plan_transition` — the
whole rule lives there, pure and unit-tested, so this file is only the plumbing
that gets events to it and writes the answer down.

Also subscribes to auth.events for org.deleted alone (see org_purge.py) — every
other Python service purges its own org-scoped tables on that event, and this
one has an org-scoped table (sticky_pins) too.

Structure (reconnect-with-backoff, batched fetch, manual offset commit, per-event
dedup claim) deliberately mirrors task-svc/app/consumer.py. A consumer that
handles broker blips differently from its neighbours is one that fails in a way
nobody on the team has debugged before.

One deliberate difference from task-svc: a `handle()` failure here does NOT
skip-and-commit past the event. task-svc can afford that (its handlers are
heterogeneous, rare side effects; losing one costs a retroactive fan-out at
worst). Here it would mean a pin update silently never happens — the task-svc
version of "the note never leaves the desktop" — so `_consume_loop` instead
seeks back and retries the whole batch, exactly like
telemetry-svc/app/consumer.py.
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
from .org_purge import purge_org
from .transitions import ASSIGNED, PinRow, plan_transition

_GROUP_ID = "sticky-svc"
TASK_TOPIC = "task.events.v1"
# Read for org.deleted only: sticky_pins has no other reason to react to
# anything on this topic. See org_purge.py.
AUTH_TOPIC = "auth.events"
ORG_DELETED = "org.deleted"

# Kafka reconnect backoff: doubles from _RECONNECT_BASE up to _RECONNECT_MAX.
_RECONNECT_BASE = 1.0
_RECONNECT_MAX = 30.0

_MAX_BATCH_SIZE = 200
# A latency budget, and a tight one on purpose: this delay is part of how long
# a person waits between being given a task and seeing it appear on their
# desktop. 250ms is far below anything noticeable, and matches task-svc.
_BATCH_LINGER_MS = 250

# Backoff after a transient failure, so a dead database is retried rather than
# hammered. Paired with the seek-back in `_consume_loop` — without a pause, a
# batch that fails instantly would spin at full speed. Matches
# telemetry-svc/app/consumer.py's `_RETRY_BACKOFF`.
_RETRY_BACKOFF = 1.0


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
        log.info("consumer_started", topics=[TASK_TOPIC, AUTH_TOPIC])

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
            AUTH_TOPIC,
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
            log.info("consumer_connected", topics=[TASK_TOPIC, AUTH_TOPIC])
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
                if await self._process_batch(batches):
                    if self._stop.is_set():
                        break
                    await consumer.commit()
                    continue

                # Transient failure. Rewind every partition to the first message
                # of this batch so it is genuinely retried.
                #
                # NOT committing is not enough on its own, and this is the trap
                # worth spelling out (see telemetry-svc/app/consumer.py's
                # _consume_loop for the original write-up): the fetch position
                # has ALREADY moved past these messages, so the next getmany()
                # returns the ones after them — and when that batch succeeds,
                # its commit advances the offset past the batch that failed.
                # The event would be skipped permanently rather than
                # redelivered. Seeking back is what makes "offsets follow the
                # transaction" actually true.
                #
                # Retrying costs nothing: every event is dedup-claimed by
                # event_id inside handle(), so whatever the failed batch did
                # manage to write is a no-op the second time through.
                for tp, records in batches.items():
                    consumer.seek(tp, records[0].offset)
                await self._sleep_or_stop(_RETRY_BACKOFF)
        except asyncio.CancelledError:
            pass

    async def _process_batch(self, batches: dict) -> bool:
        """Handle one fetch, in order. True if the offsets may advance.

        Stops at the first `handle()` failure instead of swallowing it and
        moving on to the next message: swallowing is exactly the bug this
        replaces — a DB hiccup or lock timeout was logged and then the batch
        was committed anyway, so the pin update was gone for good instead of
        being redelivered. Leaving the offset uncommitted here is what lets
        `_consume_loop` seek back and retry the whole batch.

        A message that cannot be handled at all (missing fields, wrong shape,
        a different topic's event) is not a failure here — `handle()` returns
        early for those rather than raising, so a genuinely malformed message
        cannot get stuck retrying forever the way a transient DB error should.
        """
        for _tp, messages in batches.items():
            for msg in messages:
                try:
                    await self.handle(msg.value)
                except Exception as exc:  # noqa: BLE001 — abandon batch, don't die
                    log.warning(
                        "sticky_event_failed",
                        error=str(exc),
                        event_id=(msg.value or {}).get("eventId"),
                    )
                    return False
        return True

    async def handle(self, event: dict) -> None:
        """Apply one task event to the pin table, or purge a deleted org."""
        if not isinstance(event, dict):
            return
        event_type = event.get("type", "")

        # A different topic and a different shape entirely — handled before
        # the task-event field checks below, none of which an org.deleted
        # event carries. purge_org's DELETEs are idempotent on their own
        # (see org_purge.py), so this skips the task-event dedup claim rather
        # than needing one of its own.
        if event_type == ORG_DELETED:
            org_id = event.get("orgId")
            if org_id:
                await purge_org(str(org_id))
            return

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
