from __future__ import annotations

import asyncio
import contextlib
import json

from aiokafka import AIOKafkaConsumer
from opentelemetry import trace
from opentelemetry.trace import SpanKind
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from kafka_security import kafka_security_kwargs

from . import events
from .config import settings
from crypto import cryptor
from .db import session, set_bypass_rls
from .events import AUTH_TOPIC
from .logging_setup import log
from .org_purge import purge_org
from .routes.helpers import enqueue_outbox
from tracing import extract_context

_tracer = trace.get_tracer(__name__)

_GROUP_ID = "task-svc"
MESSAGING_TOPIC = "messaging.events.v1"

# Defensive bound on consumed string fields before they hit user_projection.
_MAX_STR = 255

# Matches routes/tasks_write.py's _CANDIDATE_LIMIT: caps the fan-out query in
# _handle_channel_member_joined so an unusually large channel can't force one
# consumer transaction to decrypt/process an unbounded number of tasks.
_CHANNEL_JOIN_TASK_LIMIT = 100

# Kafka reconnect backoff: doubles from _RECONNECT_BASE up to _RECONNECT_MAX.
_RECONNECT_BASE = 1.0
_RECONNECT_MAX = 30.0

# ── Batch sizing ─────────────────────────────────────────────────────────────
#
# What this fixes is the OFFSET COMMIT, not the database work, and the
# distinction is why this consumer is batched differently from telemetry-svc's.
#
# This consumer subscribes to messaging.events.v1 — the highest-volume topic in
# the platform — but acts on exactly one event type from it
# (`channel.member.joined`). The old loop committed the offset after EVERY
# message, synchronously, including the overwhelming majority it had just
# decided to ignore. That is a network round trip to the group coordinator per
# event, to record that nothing happened.
#
# So the fix here is to fetch and acknowledge in batches while leaving the
# handlers exactly as they were: each still owns its own session, its own dedup
# claim and its own commit. They are heterogeneous and rare — a user projection
# upsert, a retroactive task fan-out, an org purge — and merging them into one
# transaction would buy nothing (they almost never co-occur) while making a
# failure in one able to roll back another.
#
# Error semantics: a handler failure now stops the batch instead of being
# logged and skipped — the earlier version committed past a failure, which
# turned a transient DB hiccup into a silently dropped user.created /
# channel.member.joined / org.deleted event, and let one malformed record wedge
# the offset forever with no way to get past it. `_consume_loop` seeks back to
# the start of the batch and retries with exponential backoff
# (`_RETRY_BACKOFF`/`_RETRY_BACKOFF_MAX`), exactly like sticky-svc and
# telemetry-svc. The one difference from those two: this topic is fed by
# several unrelated handlers rather than one, so a single message that can
# NEVER succeed is given up on (logged, dead-lettered) after
# `_MAX_HANDLER_ATTEMPTS` instead of blocking every later event on this
# partition indefinitely.
_MAX_BATCH_SIZE = 200

# How long to wait for a batch to fill once at least one message has arrived.
# A latency budget: a lone `channel.member.joined` still fans out within this
# much of arriving, which is far below anything a person waiting for a task to
# appear could notice.
_BATCH_LINGER_MS = 250

# Backoff after a handler failure, so a stuck database is retried rather than
# hammered. Doubles per attempt on the same failing message (see `_attempts`),
# capped at _RETRY_BACKOFF_MAX — same doubling shape as the reconnect backoff
# above, parameterized separately since the two back off on different things.
_RETRY_BACKOFF = 1.0
_RETRY_BACKOFF_MAX = 30.0

# A message that fails this many times in a row can't be fixed by retrying
# harder — it is logged and skipped instead of blocking every event behind it
# on this partition forever. Matches messaging-svc's handleWithRetry.
_MAX_HANDLER_ATTEMPTS = 8


def _clean_str(value, max_len: int = _MAX_STR) -> str:
    """Coerce an event string field to a bounded, control-char-free value.

    Upstream is trusted-ish but we never let an unbounded / control-char string
    into our projection: reject anything non-str, strip C0/C1 control chars
    (keeping ordinary whitespace), and truncate to ``max_len``.
    """
    if not isinstance(value, str):
        return ""
    cleaned = "".join(
        ch
        for ch in value
        if ch in ("\t", "\n", "\r")
        or (0x20 <= ord(ch) <= 0x7E)  # printable ASCII
        or ord(ch) >= 0xA0  # printable Unicode; excludes DEL (0x7F) + C1 controls (0x80–0x9F)
    )
    return cleaned[:max_len]


def _deserialize_event(value: bytes) -> dict | list | None:
    """Keep malformed Kafka records skippable instead of failing fetch."""
    try:
        return json.loads(value.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        log.warning("malformed_kafka_event_skipped")
        return None


class TaskSvcConsumer:
    """Subscribes to the upstream topics task-svc needs to react to:

      * auth.events  → maintain user_projection: user.created creates the row,
                       user.deactivated/reactivated/removed flip `active`
      * messaging.events.v1 → react to channel.member.joined by fanning out
        any active channel-allocated tasks to the new member (retroactive
        membership flow).

    Single AIOKafkaConsumer for both topics; we dispatch on event.type so
    only one consumer group lag has to be monitored.
    """

    def __init__(self) -> None:
        self._consumer: AIOKafkaConsumer | None = None
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        # (topic, partition, offset) -> consecutive failure count. Only ever
        # holds entries for messages that are CURRENTLY failing: cleared on
        # success and on giving up past _MAX_HANDLER_ATTEMPTS.
        self._attempts: dict[tuple[str, int, int], int] = {}

    async def start(self) -> None:
        # Deliberately does NOT connect to Kafka — same host-reboot race as
        # OutboxPoller.start (compose depends_on doesn't apply when the daemon
        # restarts containers by restart-policy). _run connects with backoff and
        # reconnects for the life of the process.
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="task-svc-consumer")
        log.info("consumer_started", topics=[AUTH_TOPIC, MESSAGING_TOPIC])

    async def stop(self) -> None:
        self._stop.set()
        # Stopping the consumer ends the in-flight `async for`, so _run falls
        # out of its loop instead of blocking until the next message.
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
            AUTH_TOPIC,
            MESSAGING_TOPIC,
            bootstrap_servers=settings.kafka_brokers,
            # TLS/SASL when KAFKA_SECURITY_PROTOCOL asks for it; empty otherwise.
            **kafka_security_kwargs(),
            group_id=_GROUP_ID,
            # Manual commit only after the handler (incl. its DB commit)
            # succeeds, so a crash mid-handle redelivers instead of silently
            # advancing the offset past an unprocessed event.
            enable_auto_commit=False,
            auto_offset_reset="earliest",
            value_deserializer=_deserialize_event,
        )

    @staticmethod
    async def _stop_quietly(consumer: AIOKafkaConsumer) -> None:
        with contextlib.suppress(Exception):
            await consumer.stop()

    async def _sleep_or_stop(self, delay: float) -> None:
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._stop.wait(), timeout=delay)

    async def _run(self) -> None:
        # Connect/consume/reconnect for the life of the process. Previously the
        # connect lived in start() and the loop ran exactly once, so a broker
        # blip both crash-looped the container at boot and silently killed this
        # task mid-run — events stopped projecting with the service still
        # reporting healthy.
        attempt = 0
        while not self._stop.is_set():
            consumer = self._build_consumer()
            try:
                await consumer.start()
            except Exception as exc:  # noqa: BLE001 — broker not up yet; retry
                attempt += 1
                delay = min(
                    _RECONNECT_BASE * (2 ** (attempt - 1)), _RECONNECT_MAX
                )
                log.warning(
                    "kafka_connect_retry",
                    attempt=attempt,
                    next_delay_s=delay,
                    error=str(exc),
                )
                await self._stop_quietly(consumer)
                await self._sleep_or_stop(delay)
                continue

            attempt = 0
            self._consumer = consumer
            log.info("consumer_connected", topics=[AUTH_TOPIC, MESSAGING_TOPIC])
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
                    # One offset commit for the whole fetch, after every
                    # handler in it has finished (and committed its own
                    # transaction). This is the round trip the batching exists
                    # to amortize.
                    await consumer.commit()
                    continue

                # A handler failed and hasn't yet hit _MAX_HANDLER_ATTEMPTS.
                # NOT committing is not enough on its own: the fetch position
                # has already moved past these messages, so the next
                # getmany() would return the ones after them, and when THAT
                # batch succeeds its commit would carry the offset past the
                # one that failed — skipping it for good instead of
                # redelivering it. Seeking back is what makes "offsets follow
                # success" true. Retrying costs nothing: every handler
                # dedup-claims its event before writing, so whatever a failed
                # attempt already wrote is a no-op the next time through.
                for tp, records in batches.items():
                    consumer.seek(tp, records[0].offset)
                attempts = max(self._attempts.values(), default=1)
                delay = min(_RETRY_BACKOFF * (2 ** (attempts - 1)), _RETRY_BACKOFF_MAX)
                await self._sleep_or_stop(delay)
        except asyncio.CancelledError:
            pass

    async def _process_batch(self, batches: dict) -> bool:
        """Run every message in one fetch through its handler, in order.

        True if the offsets may advance. Stops at the first handler failure
        instead of logging and moving on — logging-and-continuing is exactly
        the bug this replaces, where a DB hiccup or a malformed message was
        silently skipped and the offset committed past it anyway. Leaving the
        offset uncommitted here is what lets `_consume_loop` seek back and
        retry the whole batch.

        A message is retried in place (same batch, same order) up to
        `_MAX_HANDLER_ATTEMPTS` times across however many times its batch
        gets redelivered; past that it can't be fixed by retrying harder, so
        it is logged and given up on instead of blocking every later message
        on this partition forever. Each handler still owns its own session,
        dedup claim and commit — the batching is only in the fetch and the
        offset commit around it, not in the database work.
        """
        for _tp, messages in batches.items():
            for msg in messages:
                if self._stop.is_set():
                    return True
                key = (msg.topic, msg.partition, msg.offset)
                try:
                    # CONSUMER span continuing the producer's trace via the
                    # traceparent header. Per message rather than per batch: a
                    # batch is an implementation detail of this consumer, and
                    # the trace belongs to the event.
                    ctx = extract_context(msg.headers)
                    with _tracer.start_as_current_span(
                        f"{msg.topic} process", context=ctx, kind=SpanKind.CONSUMER
                    ):
                        await self._handle(msg.value)
                except Exception:  # noqa: BLE001 — never kill the consumer loop
                    event = msg.value if isinstance(msg.value, dict) else {}
                    attempts = self._attempts.get(key, 0) + 1
                    if attempts < _MAX_HANDLER_ATTEMPTS:
                        self._attempts[key] = attempts
                        log.warning(
                            "event_handle_retry",
                            attempt=attempts,
                            event_type=event.get("type"),
                            org_id=event.get("orgId"),
                            event_id=event.get("eventId"),
                        )
                        return False
                    # Given up: the handler's own transaction rolled back, so
                    # nothing half-written survives. Cleared from the ledger
                    # (it's no longer "currently failing") and skipped rather
                    # than retried again; the event is dedup-claimed, so it
                    # can't be double-applied if it's later fixed upstream and
                    # somehow redelivered.
                    self._attempts.pop(key, None)
                    log.exception(
                        "event_handle_dead_lettered",
                        attempts=attempts,
                        event_type=event.get("type"),
                        org_id=event.get("orgId"),
                        event_id=event.get("eventId"),
                    )
                    continue
                else:
                    self._attempts.pop(key, None)
        return True

    async def _handle(self, event: dict) -> None:
        # Malformed / non-whitelisted events fall through to a safe skip; the
        # caller still commits them so they can't loop forever.
        if not isinstance(event, dict):
            return
        event_type = event.get("type")
        if event_type == "user.created":
            await self._handle_user_created(event)
        elif event_type in ("user.deactivated", "user.reactivated", "user.removed"):
            await self._handle_membership_changed(event, active=event_type == "user.reactivated")
        elif event_type == "channel.member.joined":
            await self._handle_channel_member_joined(event)
        elif event_type == "org.deleted":
            # The whole workspace is gone. Crypto-shred has already made the
            # encrypted columns unreadable; this removes the rows, which is the
            # part a shred cannot do. Not dedup-claimed on purpose —
            # consumed_events is a global event-id table with no org_id (see
            # org_purge.py), so it plays no part in this event and there is
            # nothing here for a claim to delete out from under itself. The
            # purge is idempotent instead: a redelivery just re-runs it.
            org_id = event.get("orgId")
            if org_id:
                await purge_org(str(org_id))
        # All other events on these topics are intentionally ignored.

    async def _handle_user_created(self, event: dict) -> None:
        event_id = event.get("eventId")
        org_id = event.get("orgId")
        user_id = event.get("userId")
        occurred_at = event.get("occurredAt")
        # Bound + sanitize before projecting: cap length and strip control
        # chars so a hostile/buggy upstream can't bloat or corrupt the row.
        username = _clean_str(event.get("username", ""))
        display_name = _clean_str(event.get("displayName", ""))
        if not (event_id and org_id and user_id and occurred_at):
            return

        async with session() as db:
            # Cross-org background worker: the user_projection upsert writes an
            # arbitrary org's row (org from the event, not a request principal),
            # so RLS is bypassed for this trusted server-side transaction. Set
            # FIRST so the WITH CHECK on the INSERT passes.
            await set_bypass_rls(db)
            if await _claim(db, event_id) is False:
                return
            await db.execute(
                text(
                    "INSERT INTO user_projection "
                    "(user_id, org_id, username, display_name, active, source_occurred_at) "
                    "VALUES (:uid, :org, :uname, :dname, true, CAST(:occurred_at AS timestamptz)) "
                    "ON CONFLICT (user_id) DO UPDATE SET "
                    "org_id = CASE WHEN user_projection.source_occurred_at < EXCLUDED.source_occurred_at "
                    "THEN EXCLUDED.org_id ELSE user_projection.org_id END, "
                    "username = CASE WHEN user_projection.source_occurred_at < EXCLUDED.source_occurred_at "
                    "OR user_projection.username = '' THEN EXCLUDED.username ELSE user_projection.username END, "
                    "display_name = CASE WHEN user_projection.source_occurred_at < EXCLUDED.source_occurred_at "
                    "OR user_projection.display_name = '' THEN EXCLUDED.display_name "
                    "ELSE user_projection.display_name END, "
                    "active = CASE WHEN user_projection.source_occurred_at < EXCLUDED.source_occurred_at "
                    "THEN true ELSE user_projection.active END, "
                    "source_occurred_at = GREATEST(user_projection.source_occurred_at, EXCLUDED.source_occurred_at)"
                ),
                {
                    "uid": user_id,
                    "org": org_id,
                    "uname": username,
                    "dname": display_name,
                    "occurred_at": occurred_at,
                },
            )
            await db.commit()
            log.info("user_projection_upserted", user_id=user_id)

    async def _handle_membership_changed(self, event: dict, *, active: bool) -> None:
        """Suspended / removed / reactivated in auth-svc → flip the mirror.

        The projection row is kept: tasks reference assignee and allocator ids
        and resolve their names here, so a removed member's completed work must
        still render with their name on it. Marking them inactive is what stops
        the Available roster and the assignee picker offering someone who is no
        longer in the org.
        """
        event_id = event.get("eventId")
        org_id = event.get("orgId")
        user_id = event.get("userId")
        occurred_at = event.get("occurredAt")
        if not (event_id and org_id and user_id and occurred_at):
            return

        async with session() as db:
            # Same cross-org background-worker reasoning as _handle_user_created.
            await set_bypass_rls(db)
            if await _claim(db, event_id) is False:
                return
            await db.execute(
                text(
                    "INSERT INTO user_projection "
                    "(user_id, org_id, username, display_name, active, source_occurred_at) "
                    "VALUES (:uid, :org, '', '', :active, CAST(:occurred_at AS timestamptz)) "
                    "ON CONFLICT (user_id) DO UPDATE SET "
                    "active = EXCLUDED.active, source_occurred_at = EXCLUDED.source_occurred_at "
                    "WHERE user_projection.source_occurred_at < EXCLUDED.source_occurred_at"
                ),
                {
                    "uid": user_id,
                    "org": org_id,
                    "active": active,
                    "occurred_at": occurred_at,
                },
            )
            await db.commit()
            log.info("user_projection_membership_changed", user_id=user_id, active=active)

    async def _handle_channel_member_joined(self, event: dict) -> None:
        """Retroactive task assignment.

        Every ACTIVE task that was allocated to this channel (one of possibly
        several — see task_channels) and that the new
        member isn't yet an assignee on gets a fresh task_assignees row plus
        a task.assigned event so the sticky-note flow fires for them just as
        if the task had been allocated after they joined.

        "Active" = the task still has at least one SENT or ACKNOWLEDGED
        assignee. A channel task whose every assignee has COMPLETED / LEFT /
        IGNORED is treated as historically resolved — no point dragging a
        late joiner into a stale commitment.
        """
        event_id = event.get("eventId")
        org_id = event.get("orgId")
        channel_id = event.get("channelId")
        user_id = event.get("userId")
        if not (event_id and org_id and channel_id and user_id):
            return

        async with session() as db:
            # Cross-org background worker (channel.member.joined is processed for
            # whatever org the event carries): bypass RLS for this trusted
            # transaction so the tasks/user_projection read, the org_keys reads
            # warm_dek_versions makes, and the task_assignees INSERT (WITH CHECK)
            # all succeed regardless of any request principal. Set FIRST.
            await set_bypass_rls(db)
            if await _claim(db, event_id) is False:
                return

            # Pull every active task this channel owns. We need (id, sender_id,
            # title, description, sender's username) to mint a task.assigned
            # row. title/description are stored encrypted (title_enc/
            # description_enc) and decrypted below so the Kafka event still
            # carries plaintext (relay + messaging projection need it).
            # sender_username is resolved via the same LEFT JOIN
            # routes/tasks_read.py uses, rather than a per-row lookup —
            # user_projection.user_id is its primary key, so this can only
            # ever match zero or one row per task and never multiplies rows.
            rows = (
                await db.execute(
                    text(
                        """
                        SELECT t.id, t.sender_id, t.title_enc, t.description_enc,
                               COALESCE(up.username, '') AS sender_username
                        FROM tasks t
                        LEFT JOIN user_projection up
                               ON up.user_id = t.sender_id AND up.org_id = t.org_id
                        WHERE t.org_id = :org
                          AND t.id IN (
                              SELECT task_id FROM task_channels
                              WHERE org_id = :org AND channel_id = :ch
                              UNION
                              -- written before 012 (or by the release before it)
                              SELECT id FROM tasks
                              WHERE org_id = :org AND channel_id = :ch
                          )
                          AND EXISTS (
                              SELECT 1 FROM task_assignees a
                              WHERE a.task_id = t.id
                                AND a.status IN ('SENT', 'ACKNOWLEDGED')
                          )
                          -- A task past its deadline is as good as finished: a late
                          -- joiner would be handed it already missed.
                          AND (t.deadline_at IS NULL OR t.deadline_at > now())
                        LIMIT :limit
                        """
                    ),
                    {"org": org_id, "ch": channel_id, "limit": _CHANNEL_JOIN_TASK_LIMIT},
                )
            ).all()
            if not rows:
                await db.commit()
                return
            if len(rows) == _CHANNEL_JOIN_TASK_LIMIT:
                log.warning(
                    "channel_member_joined_task_fanout_capped",
                    org_id=org_id,
                    channel_id=channel_id,
                    limit=_CHANNEL_JOIN_TASK_LIMIT,
                )

            # Already-an-assignee check, batched into one query instead of one
            # SELECT per task: possible if a previous joiner event delivery
            # raced or the channel admin had pre-added them. Same semantics as
            # the old per-row check — ANY existing row counts, not just
            # SENT/ACKNOWLEDGED — just fewer round trips to answer it.
            task_ids = [str(row.id) for row in rows]
            already_assigned = {
                str(r.task_id)
                for r in (
                    await db.execute(
                        text(
                            "SELECT task_id FROM task_assignees "
                            "WHERE task_id = ANY(:tids) AND assignee_id = :aid"
                        ),
                        {"tids": task_ids, "aid": user_id},
                    )
                ).all()
            }

            # Batch-decrypt every title/description in one asyncio.to_thread
            # hop instead of up to 2 * _CHANNEL_JOIN_TASK_LIMIT sequential
            # `await cryptor().decrypt()` calls. On a warm per-org DEK cache
            # (the normal case) decrypt()'s await never actually suspends, so
            # that loop ran back-to-back with no opportunity for the event
            # loop to interleave anything else this single-worker process was
            # doing — including the HTTP API and every other Kafka batch. See
            # crypto.py's "Batch decrypt" section and routes/tasks_read.py,
            # which already uses this exact split for the same reason.
            ciphertexts: list[bytes | None] = []
            for row in rows:
                ciphertexts.extend([row.title_enc, row.description_enc])
            versions = {v for v in (cryptor().peek_version(b) for b in ciphertexts) if v is not None}
            await cryptor().warm_dek_versions(db, org_id, versions)
            plaintexts = await asyncio.to_thread(cryptor().decrypt_batch_cached, org_id, ciphertexts)

            joined_count = 0
            for i, row in enumerate(rows):
                task_id = str(row.id)
                if task_id in already_assigned:
                    continue
                sender_id = str(row.sender_id)
                title = plaintexts[2 * i] or ""
                description = plaintexts[2 * i + 1] or ""

                await db.execute(
                    text(
                        "INSERT INTO task_assignees (task_id, org_id, assignee_id, status, status_version) "
                        "VALUES (:tid, :org, :aid, 'SENT', 0)"
                    ),
                    {"tid": task_id, "org": org_id, "aid": user_id},
                )
                evt = events.task_assigned(
                    org_id=org_id,
                    task_id=task_id,
                    assignee_id=user_id,
                    sender_id=sender_id,
                    status_version=0,
                    sender_username=row.sender_username,
                    title=title,
                    description=description,
                )
                await enqueue_outbox(db, events.TASK_TOPIC, task_id, evt)
                joined_count += 1

            await db.commit()
            if joined_count:
                log.info(
                    "channel_member_retroactively_assigned",
                    user_id=user_id,
                    channel_id=channel_id,
                    tasks=joined_count,
                )


async def _claim(db, event_id: str) -> bool:
    """Insert into consumed_events; return True if we successfully claimed."""
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


consumer = TaskSvcConsumer()
