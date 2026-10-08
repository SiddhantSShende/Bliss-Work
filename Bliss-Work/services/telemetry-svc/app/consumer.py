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
import uuid
from datetime import datetime

from aiokafka import AIOKafkaConsumer
from opentelemetry import trace
from opentelemetry.trace import SpanKind
from prometheus_client import Counter
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from kafka_security import kafka_security_kwargs

from .config import settings
from .db import session, set_bypass_rls
from .event_map import MAPPINGS, detail_value_of, preview_of
from .ingest import ActivityRow, _is_missing_partition, clamp_occurred_at, insert_events
from .logging_setup import log
from .org_purge import purge_org
from tracing import extract_context

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

# ── Batch sizing ─────────────────────────────────────────────────────────────
#
# This loop used to be strictly one message at a time: a session checkout, a
# `set_bypass_rls`, a dedup INSERT, the row INSERT, a COMMIT, and then a
# SYNCHRONOUS offset commit — five or so round trips per event, with no
# pipelining. This consumer subscribes to FIVE topics because the activity
# record spans the whole product, so it sees every event the platform produces:
# it is the highest-volume Python consumer there is, and the per-message shape
# capped it at a few hundred events/sec per replica.
#
# That ceiling could not be lifted by adding replicas either — consumer-group
# parallelism is bounded by partition count.
#
# `insert_events` already took a LIST and already did a single multi-row insert
# behind a savepoint; it was simply never handed more than one row.
_MAX_BATCH_SIZE = 200

# How long to wait for a batch to fill. A latency budget, not a throughput knob.
#
# Deliberately larger than notification-svc's 25ms, and the reason is the
# consumer's job rather than a preference: a notification is on a person's
# screen and 25ms is chosen to stay under human perception. Activity events feed
# a timeline that is read later, so a quarter second of extra batching costs
# nothing anybody can observe and collects a much fuller batch.
_BATCH_LINGER_MS = 250

# Backoff after a transient failure, so a dead database is retried rather than
# hammered. Paired with the seek-back in `_consume_loop` — without a pause, a
# batch that fails instantly would spin at full speed.
_RETRY_BACKOFF = 1.0

# Events dropped because they can never be written, by reason. Unmapped event
# types are NOT counted: they are the majority of the traffic, not a fault.
SKIPPED = Counter(
    "telemetry_events_skipped_total",
    "Kafka events dropped as permanently unprocessable, by reason.",
    ["reason"],
)

# Events that are NOT timeline rows and keep their own transaction. Both are
# rare; see `_handle_control` for why each one is special.
_CONTROL_TYPES = ("org.deleted",)


def _is_permanent_db_error(exc: BaseException) -> bool:
    """True when Postgres rejected the event's VALUES, so no retry can succeed.

    SQLAlchemy's `DataError` class is not usable for this: with the asyncpg
    driver a bad uuid (client-side encode error, SQLSTATE 22000), an `invalid
    input syntax` (22P02) or an embedded NUL (22021) all surface as a bare
    `DBAPIError`, so the SQLSTATE class is read instead — 22 = data exception,
    23 = integrity constraint violation. Everything else (08 connection, 40
    deadlock, 53 resources, 57 statement timeout) is transient and keeps being
    retried. "no partition of relation" is a 23514 too, but it is a missing
    partition (infrastructure), not a bad event, so it stays transient.
    """
    if not isinstance(exc, DBAPIError) or _is_missing_partition(exc):
        return False
    state = getattr(exc.orig, "sqlstate", None) or getattr(exc.orig, "pgcode", None)
    return isinstance(state, str) and state[:2] in ("22", "23")


def _deserialize_event(value: bytes) -> dict | list | None:
    """Keep malformed Kafka records skippable instead of failing fetch."""
    try:
        return json.loads(value.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        log.warning("malformed_kafka_event_skipped")
        return None


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
            # TLS/SASL when KAFKA_SECURITY_PROTOCOL asks for it; empty otherwise.
            **kafka_security_kwargs(),
            group_id=_GROUP_ID,
            enable_auto_commit=False,
            auto_offset_reset="latest",  # see the module docstring
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
            while not self._stop.is_set():
                batches = await consumer.getmany(
                    timeout_ms=_BATCH_LINGER_MS, max_records=_MAX_BATCH_SIZE
                )
                if not batches:
                    continue
                if await self._process_batch(batches):
                    await consumer.commit()
                    continue

                # Transient failure. Rewind every partition to the first message
                # of this batch so it is genuinely retried.
                #
                # NOT committing is not enough on its own, and this is the trap
                # worth spelling out: the fetch position has ALREADY moved past
                # these messages, so the next getmany() returns the ones after
                # them — and when that batch succeeds, its commit advances the
                # offset past the batch that failed. The events would be skipped
                # permanently rather than redelivered. Seeking back is what
                # makes "offsets follow the transaction" actually true.
                #
                # Retrying costs nothing: every event is dedup-claimed by
                # event_id, so whatever the failed batch did manage to write is
                # a no-op the second time through.
                for tp, records in batches.items():
                    consumer.seek(tp, records[0].offset)
                await self._sleep_or_stop(_RETRY_BACKOFF)
        except asyncio.CancelledError:
            pass

    async def _process_batch(self, batches: dict) -> bool:
        """Handle one fetch. True if the offsets may advance.

        The delivery guarantees are unchanged from the per-message version,
        which is the point — batching is an efficiency change and must not
        become a correctness one:

          - Offsets advance only after the database transaction commits.
          - Every row is claimed in `consumed_events` inside that same
            transaction, so a redelivered batch writes nothing twice.
          - A message that cannot become a row is SKIPPED, not failed. An
            unmapped event type is ordinary traffic here (these five topics
            carry far more than the timeline records), and a malformed one must
            not be able to block its own partition forever.
          - A transient error abandons the whole batch uncommitted rather than
            its successful prefix. That re-does work, and the dedup makes
            re-doing it free, whereas committing a prefix would need
            per-message offset tracking to stay correct.

        Ordering is preserved. Activity rows accumulate into a pending batch,
        but a control event FLUSHES that batch before it runs — so an
        `org.deleted` still lands after the rows that preceded it and before
        the rows that follow, exactly as it did one message at a time.
        """
        pending: list[tuple[ActivityRow, str]] = []
        try:
            for _tp, messages in batches.items():
                for msg in messages:
                    # CONSUMER span per message, continuing the producer's trace
                    # via the traceparent header. Per message rather than per
                    # batch: a batch is an implementation detail of this
                    # consumer, and the trace belongs to the event.
                    ctx = extract_context(msg.headers)
                    with _tracer.start_as_current_span(
                        f"{msg.topic} process", context=ctx, kind=SpanKind.CONSUMER
                    ):
                        event = msg.value
                        if not isinstance(event, dict):
                            continue
                        if event.get("type") in _CONTROL_TYPES:
                            await self._flush_isolating(pending)
                            pending.clear()
                            await self._handle_control(event)
                            continue
                        claimable = _to_claimable(event)
                        if claimable is not None:
                            pending.append(claimable)
            await self._flush_isolating(pending)
        except Exception:  # noqa: BLE001 — never kill the consumer loop
            log.exception("event_batch_error", messages=sum(len(m) for m in batches.values()))
            return False
        return True

    async def _flush_isolating(self, pending: list[tuple[ActivityRow, str]]) -> None:
        """`_flush`, but one row the database rejects cannot fail the batch.

        A permanent rejection (see `_is_permanent_db_error`) rolls back the whole
        transaction, and redelivering the same batch fails the same way — with
        no attempt cap that wedged every topic behind a single bad event. So the
        batch is retried row by row, each in its own transaction, and the row
        that is rejected is logged, counted and skipped. Rows that were written
        are claimed in `consumed_events`, so a later redelivery is a no-op.

        Transient errors are NOT isolated: they propagate and the whole batch is
        retried uncommitted, as before. The row-by-row path only runs after a
        permanent error, i.e. rarely, so the normal path stays one transaction.
        """
        try:
            await self._flush(pending)
            return
        except Exception as exc:  # noqa: BLE001 — classified below
            if not _is_permanent_db_error(exc):
                raise
            log.warning("event_batch_rejected_isolating", rows=len(pending),
                        sqlstate=_sqlstate(exc))
        for item in pending:
            try:
                await self._flush([item])
            except Exception as exc:  # noqa: BLE001 — classified below
                if not _is_permanent_db_error(exc):
                    raise
                SKIPPED.labels(reason="rejected_by_db").inc()
                log.error("event_skipped", reason="rejected_by_db",
                          sqlstate=_sqlstate(exc), event_id=item[1])

    async def _flush(self, pending: list[tuple[ActivityRow, str]]) -> None:
        """Write one transaction's worth of activity rows.

        Raises on failure, which the caller turns into "do not advance the
        offsets". Deliberately not swallowed here: a half-written batch that
        reported success is the one outcome that would break the dedup
        contract.
        """
        if not pending:
            return
        async with session() as db:
            # Cross-org background worker: it projects events for EVERY org off
            # one stream, so there is no single request org to scope to. Set
            # FIRST so the WITH CHECK on the insert passes.
            await set_bypass_rls(db)
            claimed = await _claim_many(db, [event_id for _, event_id in pending])
            # A single fetch batch can legitimately carry the same event_id
            # twice (producer retry — see the module docstring). `event_id in
            # claimed` is set membership, so both copies would otherwise pass
            # and both get inserted; these are server-observed rows
            # (client_event_id=None), so activity_events' unique index doesn't
            # catch the duplicate either. Keep only the first occurrence.
            seen: set[str] = set()
            rows = []
            for row, event_id in pending:
                if event_id in claimed and event_id not in seen:
                    seen.add(event_id)
                    rows.append(row)
            if rows:
                await insert_events(db, rows)
            await db.commit()

    async def _handle_control(self, event: dict) -> None:
        """The one event type that is not a timeline row.

        Kept in its own session rather than joining the batch — which is also
        what lets the batch above stay a plain list of rows.
        """
        # The whole workspace is gone. Deleting the org's rows here is the half
        # that crypto-shred cannot do: the encrypted columns are already
        # unreadable, but the ids, timestamps and counts are not encrypted and
        # would otherwise remain indefinitely.
        #
        # Deliberately NOT dedup-claimed. A claim writes to consumed_events,
        # which this purge is about to empty for the org — so a claim would be
        # deleted by its own handler and a redelivery would look new. The purge
        # is idempotent, which is the property that actually matters here.
        if event.get("type") == "org.deleted":
            org_id = event.get("orgId")
            if org_id:
                # A non-UUID orgId makes the purge's `org_id = $1` raise a
                # DataError on every attempt, which would wedge the consumer.
                canonical = _uuid_or_none(org_id)
                if canonical is None:
                    _skip_invalid("orgId", org_id, event)
                    return
                await purge_org(canonical)


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
    raw_org = _bounded(event.get("orgId"))
    raw_user = _bounded(event.get(mapping.actor_field))
    if not raw_org or not raw_user:
        return None
    # activity_events.org_id / user_id are `uuid` columns. Length-bounding is
    # not validation: a non-UUID id used to raise a DataError at insert time,
    # failing the whole batch on every redelivery. Skip the event instead.
    org_id = _uuid_or_none(raw_org)
    user_id = _uuid_or_none(raw_user)
    if org_id is None or user_id is None:
        _skip_invalid("orgId" if org_id is None else mapping.actor_field,
                      raw_org if org_id is None else raw_user, event)
        return None

    detail: dict[str, object] = {}
    if mapping.preview_field:
        preview = preview_of(event.get(mapping.preview_field))
        if preview:
            detail["preview"] = preview
    for detail_key, event_key in mapping.detail_fields:
        value = detail_value_of(event.get(event_key))
        if value is not None:
            detail[detail_key] = value

    return ActivityRow(
        org_id=org_id,
        user_id=user_id,
        occurred_at=clamp_occurred_at(_parse_ts(event.get("occurredAt")), source="server"),
        source="server",
        category=mapping.category,
        action=mapping.action,
        surface=mapping.surface,
        target_kind=mapping.target_kind,
        target_id=_bounded(event.get(mapping.target_field)) if mapping.target_field else None,
        detail=detail,
    )


def _uuid_or_none(value: object) -> str | None:
    """The canonical form of a UUID string, or None if it is not one."""
    try:
        return str(uuid.UUID(str(value)))
    except (AttributeError, TypeError, ValueError):
        return None


def _skip_invalid(field: str, value: object, event: dict) -> None:
    SKIPPED.labels(reason="id_not_a_uuid").inc()
    log.warning("event_id_not_a_uuid", field=field, value=str(value)[:_MAX_ID_LEN],
                event_id=str(event.get("eventId"))[:_MAX_ID_LEN])


def _sqlstate(exc: BaseException) -> str | None:
    orig = getattr(exc, "orig", None)
    return getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)


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


def _to_claimable(event: dict) -> tuple[ActivityRow, str] | None:
    """Map one event to (row, event_id), or None to skip it.

    Skipping covers three different things, all of them normal:

      * No eventId — it cannot be dedup-claimed, so it cannot be written safely.
      * An eventId that is not a UUID. `consumed_events.event_id` is a `uuid`
        column, so a malformed id used to raise a DataError that the loop
        counted as a handler failure and never committed: a poison message that
        blocked its own partition indefinitely. It is skipped now.
      * An event type this service does not record. The five subscribed topics
        carry far more than the timeline maps, so this is the MAJORITY of the
        traffic rather than an error.
    """
    event_id = event.get("eventId")
    if not event_id:
        return None
    try:
        uuid.UUID(str(event_id))
    except (AttributeError, TypeError, ValueError):
        SKIPPED.labels(reason="id_not_a_uuid").inc()
        log.warning("event_id_not_a_uuid", event_id=str(event_id)[:_MAX_ID_LEN])
        return None
    row = to_activity_row(event)
    if row is None:
        return None
    return row, str(event_id)


async def _claim_many(db, event_ids: list[str]) -> set[str]:
    """Claim many events in ONE statement; return the ids this process won.

    Replaces a per-event INSERT that caught IntegrityError and called
    `db.rollback()` on a duplicate. That rollback is precisely why the old
    helper could not just be called in a loop inside one transaction: a single
    duplicate anywhere in the batch would have discarded the whole batch's work,
    including the transaction-local RLS GUC the caller sets first.
    `ON CONFLICT DO NOTHING` has no such side effect, and RETURNING says exactly
    which ids were new.

    DISTINCT because one fetch can legitimately carry the same event twice (a
    producer retry). Without it the value appears twice in the INSERT, is
    returned once, and the RETURNING set — which is what decides whether the row
    gets written — would be ambiguous about the second copy.
    """
    if not event_ids:
        return set()
    result = await db.execute(
        text(
            "INSERT INTO consumed_events (event_id) "
            "SELECT DISTINCT unnest(CAST(:eids AS uuid[])) "
            "ON CONFLICT DO NOTHING "
            "RETURNING event_id::text"
        ),
        {"eids": event_ids},
    )
    return {str(row[0]) for row in result}


consumer = TelemetryConsumer()
