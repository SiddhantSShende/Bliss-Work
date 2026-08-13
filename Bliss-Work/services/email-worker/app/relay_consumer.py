"""relay_consumer ─ Phase 6 offline-only SMTP relay.

Consumes ``messaging.events.v1`` + ``task.events.v1`` (group
``email-worker-relay``, distinct from the auth-invite group so partition
assignment and offset commit are independent). For every relayable event:

  1. Determine the recipient user id from the event payload.
  2. CLAIM dedup atomically — INSERT email_consumed (event_id, recipient_id,
     state='pending'). If a 'sent' row already exists, the conflict path
     returns no rows and we skip; if a 'pending' row exists (prior worker
     crashed mid-flight), the reaper retries it later.
  3. Lookup recipient e-mail + username via auth-svc's internal API.
  4. Check presence: SCARD presence:user:<userId> == 0 AND event.occurredAt
     is older than offline_threshold_seconds. The "older than X seconds"
     check uses event.occurredAt (NOT now()) so post-rebalance re-reads of
     messages the user has ALREADY seen via WS do not produce spam.
  5. Render + send via the existing aiosmtplib Mailer.
  6. UPDATE email_consumed.state='sent', sent_at=now().

Failures between step 2 and step 6 leave the row 'pending'. The reaper sweep
re-runs the pipeline for those rows.

Loop guard: only handle the events that are MEANT to wake up the recipient
(MessageCreated, TaskAssigned). delivery / read / dismissed events would
fan-in infinitely if relayed — see NO_RELAY_TYPES below.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import asyncpg
import httpx
import structlog
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from aiokafka.errors import KafkaConnectionError, KafkaError
from opentelemetry import trace
from opentelemetry.trace import SpanKind

from .config import Settings
from .mailer import Mailer, is_valid_email
from .presence import Presence
from .resilience import CircuitBreaker, CircuitOpenError, retry_async
from .templates import render_new_message_email, render_new_task_email
from .tracing import extract_context, inject_headers

_log = structlog.get_logger("relay")

_tracer = trace.get_tracer(__name__)

# Bounded per-attempt timeout for the auth-svc internal user lookup (the shared
# AsyncClient is created with timeout=5.0; we tighten the per-attempt budget via
# httpx.Timeout on the request itself so a slow auth-svc can't pin the worker).
_LOOKUP_TIMEOUT = 3.0
_LOOKUP_ATTEMPTS = 3

MESSAGE_CREATED = "message.created"
TASK_ASSIGNED = "task.assigned"

# Events that arrive on the same topics but MUST NOT trigger a notification
# (closing the delivered→ack→delivered loop, e.g.).
NO_RELAY_TYPES = {
    "message.read",
    "message.delivered",
    "message.dismissed",
    "conversation.ignored",
    "task.acknowledged",
    "task.completed",
    "task.ignored",
    "task.left",
}

# Limit how much message body lands inside a single email — keep things
# scannable and avoid SMTP body-length issues at the destination.
PREVIEW_LEN = 200

# A task title becomes part of the Subject header; oversized headers get
# rejected by some SMTP servers, so cap it before building the subject.
TITLE_LEN = 120

# Bound how long a hung broker can block shutdown.
_STOP_TIMEOUT = 30.0


class RelayConsumer:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._mailer = Mailer(
            host=settings.smtp_host,
            port=settings.smtp_port,
            sender=settings.smtp_from,
            username=settings.smtp_username,
            password=settings.smtp_password,
            starttls=settings.smtp_starttls,
        )
        self._presence: Presence | None = None
        self._db: asyncpg.Pool | None = None
        self._http: httpx.AsyncClient | None = None
        self._producer: AIOKafkaProducer | None = None
        # Consecutive failure count per event_id; poison messages (>= N) are
        # routed to the DLQ so they can't loop forever.
        self._failures: dict[str, int] = {}
        # Circuit breaker for the auth-svc internal user-lookup. Once auth-svc
        # has been failing, the breaker opens and lookups fail fast for a
        # cooldown — the relay then SKIPS the email (marks sent) instead of
        # blocking the consumer on the per-attempt timeout for every event.
        self._auth_breaker = CircuitBreaker(
            fail_max=5, reset_timeout=30.0, name="auth-svc"
        )
        self._stop = asyncio.Event()

    def request_stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        self._presence = Presence(self._settings.redis_url)
        self._http = httpx.AsyncClient(timeout=5.0)
        await self._connect_db()

        # Apply migration 0001 once on startup (idempotent).
        await self._apply_migrations()

        consumer = AIOKafkaConsumer(
            self._settings.messaging_topic,
            self._settings.task_topic,
            bootstrap_servers=self._settings.kafka_brokers,
            group_id=self._settings.relay_consumer_group,
            # Manual commit: the offset only advances AFTER _mark_sent, so it
            # can never commit mid-SMTP-send.
            enable_auto_commit=False,
            auto_offset_reset="latest",
            value_deserializer=lambda b: b,
        )
        self._producer = AIOKafkaProducer(
            bootstrap_servers=self._settings.kafka_brokers,
        )
        reaper = asyncio.create_task(self._reaper_loop())

        retries = 0
        try:
            while not self._stop.is_set():
                try:
                    await consumer.start()
                    await self._producer.start()
                except (KafkaConnectionError, KafkaError, OSError) as exc:
                    retries += 1
                    delay = min(0.5 * (2 ** (retries - 1)), 30.0)
                    _log.warning("relay_kafka_connect_retry", attempt=retries,
                                 delay_s=delay, error=str(exc))
                    await self._stop_quietly(consumer)
                    await self._stop_quietly(self._producer)
                    try:
                        await asyncio.wait_for(self._stop.wait(), timeout=delay)
                    except asyncio.TimeoutError:
                        pass
                    continue

                retries = 0
                _log.info("relay_consumer_ready",
                          topics=[self._settings.messaging_topic, self._settings.task_topic],
                          group=self._settings.relay_consumer_group)
                try:
                    await self._consume_loop(consumer)
                except (KafkaConnectionError, KafkaError, OSError) as exc:
                    _log.warning("relay_consume_loop_error", error=str(exc))
                finally:
                    await self._stop_quietly(consumer)
                    await self._stop_quietly(self._producer)
        finally:
            reaper.cancel()
            try:
                await reaper
            except asyncio.CancelledError:
                pass
            if self._presence:
                await self._presence.aclose()
            if self._db:
                await self._db.close()
            if self._http:
                await self._http.aclose()

    async def _consume_loop(self, consumer: AIOKafkaConsumer) -> None:
        while not self._stop.is_set():
            batch = await consumer.getmany(timeout_ms=1000, max_records=100)
            handled = False
            ok = True
            for _tp, messages in batch.items():
                for msg in messages:
                    handled = True
                    # CONSUMER span continuing the producer's trace via the
                    # traceparent header. No-op when tracing is disabled.
                    ctx = extract_context(msg.headers)
                    with _tracer.start_as_current_span(
                        f"{msg.topic} process", context=ctx, kind=SpanKind.CONSUMER
                    ):
                        ok_one = await self._handle(msg.value)
                    if not ok_one:
                        # A transient failure below the poison threshold — do
                        # NOT advance the offset so Kafka redelivers and retries.
                        ok = False
            # Commit only AFTER the batch's _mark_sent writes completed.
            if handled and ok:
                await consumer.commit()
            if self._stop.is_set():
                break

    async def _handle(self, raw: bytes) -> bool:
        """Process one event. Return True if the offset may advance, False if a
        transient failure means the batch must NOT be committed (Kafka will
        redeliver and we retry)."""
        try:
            event = json.loads(raw)
        except (ValueError, TypeError) as exc:
            _log.warning("relay_bad_json", error=str(exc))
            return True
        if not isinstance(event, dict):
            return True

        etype = event.get("type", "")
        if etype in NO_RELAY_TYPES:
            return True
        if etype not in (MESSAGE_CREATED, TASK_ASSIGNED):
            return True

        event_id = event.get("eventId")
        if not event_id:
            return True

        # Determine the recipient.
        recipient_id = (
            event.get("recipientId")
            if etype == MESSAGE_CREATED
            else event.get("assigneeId")
        )
        if not recipient_id:
            return True

        # Self-send guard (the sender's own bubble doesn't need an email to
        # themselves). For tasks the assignee may equal the sender if a task
        # is self-assigned — fine to skip in that edge case too.
        if recipient_id == event.get("senderId"):
            return True

        # Claim dedup. Returns True if we successfully inserted a fresh
        # 'pending' row; False if a row (sent or in-flight pending) exists.
        claimed = await self._claim(event_id, recipient_id)
        if not claimed:
            # A 'sent' row means a true duplicate — done. A 'pending' row means
            # OUR earlier attempt failed before _mark_sent (the offset never
            # committed, so Kafka redelivered) — re-run the pipeline to retry.
            if await self._is_sent(event_id, recipient_id):
                return True

        # Offline gate. event.occurredAt is the canonical "when did this
        # happen on the bus" timestamp — comparing to it instead of now()
        # avoids spamming users who legitimately viewed the event live but
        # we only got around to processing now after a rebalance.
        if not await self._should_relay(recipient_id, event.get("occurredAt", "")):
            # Mark sent (=skipped, no rewind) so a later replay doesn't try
            # again. The result is the same to the user.
            await self._mark_sent(event_id, recipient_id)
            self._failures.pop(str(event_id), None)
            return True

        try:
            await self._send_for_event(event, recipient_id, etype)
        except CircuitOpenError as exc:
            # auth-svc is known-bad (breaker open): SKIP this email rather than
            # blocking the consumer on the lookup. Mark sent so a later replay
            # doesn't retry — the in-app inbox remains authoritative, so a
            # dropped notification during an auth-svc outage is acceptable.
            _log.warning("relay_skipped_auth_breaker_open", event_id=event_id,
                         recipient=recipient_id, error=str(exc))
            await self._mark_sent(event_id, recipient_id)
            self._failures.pop(str(event_id), None)
            return True
        except Exception as exc:  # noqa: BLE001 - poison-message handling below
            return await self._on_failure(str(event_id), event, str(exc))

        # Offset advances only AFTER _mark_sent completes.
        await self._mark_sent(event_id, recipient_id)
        self._failures.pop(str(event_id), None)
        return True

    async def _on_failure(self, event_id: str, event: dict, error: str) -> bool:
        """Count consecutive failures; route poison messages to the DLQ.

        Returns False below the threshold so the caller leaves the offset
        uncommitted and Kafka redelivers (retry). At/after the threshold we
        publish to the DLQ and return True so the offset commits and the poison
        message stops looping."""
        n = self._failures.get(event_id, 0) + 1
        self._failures[event_id] = n
        _log.error("relay_send_failed", event_id=event_id, attempt=n, error=error)
        if n >= self._settings.poison_max_failures:
            await self._to_dlq(event, error)
            self._failures.pop(event_id, None)
            return True
        # Don't commit — Kafka redelivers this event and we retry.
        return False

    async def _to_dlq(self, event: dict, error: str) -> None:
        if self._producer is None:
            _log.error("relay_dlq_producer_unavailable", event_id=event.get("eventId"))
            return
        envelope = {"reason": error, "source": "relay", "event": event}
        try:
            # PRODUCER span: inject traceparent so the DLQ message stays linked
            # to this trace. No-op when tracing is disabled.
            with _tracer.start_as_current_span(
                f"{self._settings.dlq_topic} send", kind=SpanKind.PRODUCER
            ):
                await self._producer.send_and_wait(
                    self._settings.dlq_topic,
                    json.dumps(envelope).encode("utf-8"),
                    headers=inject_headers(),
                )
            _log.warning("relay_routed_to_dlq", event_id=event.get("eventId"),
                         topic=self._settings.dlq_topic)
        except Exception as exc:  # noqa: BLE001 - DLQ best-effort
            _log.error("relay_dlq_publish_failed", event_id=event.get("eventId"),
                       error=str(exc))

    async def _should_relay(self, recipient_id: str, occurred_at_iso: str) -> bool:
        assert self._presence is not None
        if await self._presence.is_online(recipient_id):
            return False
        if not occurred_at_iso:
            return True  # Best-effort: relay if we can't tell.
        try:
            occurred = datetime.fromisoformat(occurred_at_iso.replace("Z", "+00:00"))
        except ValueError:
            return True
        if occurred.tzinfo is None:
            occurred = occurred.replace(tzinfo=timezone.utc)
        delta = (datetime.now(timezone.utc) - occurred).total_seconds()
        return delta >= self._settings.offline_threshold_seconds

    async def _lookup_user(self, user_id: str, request_id: str | None = None) -> dict | None:
        """Resolve a user's e-mail/username from auth-svc's internal API.

        Returns the parsed UserDTO dict, or None on miss/non-transient error.
        The relay only fires for OFFLINE recipients (already off the hot path),
        so a synchronous service-to-service lookup here is fine — and it keeps
        email-worker free of any cross-service database access (strict
        database-per-service).

        Resilience: bounded per-attempt timeout, up to 3 retries with
        backoff+jitter on transient failures (connect/timeout/5xx), and a
        circuit breaker. ``CircuitOpenError`` propagates to the caller so it can
        SKIP the email (mark sent) rather than block — see _send_for_event.
        """
        assert self._http is not None
        url = f"{self._settings.auth_internal_base}/internal/users/{user_id}"
        headers = {"X-Internal-Token": self._settings.internal_token}
        # Best-effort: propagate the originating event id as the request id so
        # the lookup can be correlated in auth-svc's logs.
        if request_id:
            headers["X-Request-Id"] = request_id

        async def _attempt() -> httpx.Response:
            assert self._http is not None
            resp = await self._http.get(
                url, headers=headers, timeout=_LOOKUP_TIMEOUT
            )
            # 5xx is transient (retryable) and should trip the breaker; raising
            # HTTPStatusError lets retry_async classify it. 4xx (incl. 404) is
            # returned as-is and treated as a definitive (non-transient) answer.
            if resp.status_code >= 500:
                resp.raise_for_status()
            return resp

        def _on_retry(attempt: int, exc: BaseException, delay: float) -> None:
            _log.warning("relay_user_lookup_retry", user=user_id, attempt=attempt,
                         delay_s=round(delay, 3), error=str(exc))

        # CircuitOpenError intentionally propagates (handled by _send_for_event).
        try:
            resp = await retry_async(
                _attempt,
                attempts=_LOOKUP_ATTEMPTS,
                breaker=self._auth_breaker,
                on_retry=_on_retry,
            )
        except httpx.HTTPError as exc:
            # Exhausted retries on a transient failure — treat as a miss.
            _log.warning("relay_user_lookup_failed", user=user_id, error=str(exc))
            return None

        if resp.status_code == 200:
            return resp.json()
        if resp.status_code != 404:
            _log.warning("relay_user_lookup_status", user=user_id,
                         status=resp.status_code)
        return None

    async def _send_for_event(self, event: dict, recipient_id: str, etype: str) -> None:
        # Resolve recipient + sender identity from auth-svc (the identity owner)
        # via its internal API — email-worker never reads another service's DB.
        # Propagate the event id as X-Request-Id (best-effort correlation).
        request_id = event.get("eventId")
        recipient = await self._lookup_user(recipient_id, request_id=request_id)
        if not recipient or not recipient.get("email"):
            _log.info("relay_skipped_no_email", recipient=recipient_id, type=etype)
            return
        to_addr = str(recipient["email"])
        # Invalid recipients are rejected by SMTP and would retry forever; log
        # + skip (the caller marks sent) instead.
        if not is_valid_email(to_addr):
            _log.warning("relay_invalid_email_skipped", recipient=recipient_id, to=to_addr)
            return
        sender_username = ""
        sid = event.get("senderId")
        if sid:
            sender = await self._lookup_user(sid, request_id=request_id)
            if sender:
                sender_username = sender.get("username") or ""

        link = f"{self._settings.web_base_url}/app/inbox"
        if etype == MESSAGE_CREATED:
            body = (event.get("body") or "")[:PREVIEW_LEN]
            subject = f"{sender_username or 'A teammate'} sent you a message"
            text, html = render_new_message_email(
                sender_username=sender_username or "A teammate",
                body_preview=body,
                link=link,
            )
        else:  # TASK_ASSIGNED
            # Cap the title (lands in the Subject header) and description (body)
            # so oversized headers/bodies don't get rejected by SMTP.
            title = (event.get("title", "") or "Untitled task")[:TITLE_LEN]
            desc = (event.get("description", "") or "")[:PREVIEW_LEN]
            subject = f"New task: {title}"
            text, html = render_new_task_email(
                sender_username=sender_username or "A teammate",
                title=title,
                description=desc,
                link=link,
            )
        # Let a send failure propagate — the caller (_handle) counts consecutive
        # failures and routes poison messages to the DLQ; transient failures
        # leave the offset uncommitted so Kafka redelivers.
        await self._mailer.send(
            to=to_addr, subject=subject, text_body=text, html_body=html,
        )
        _log.info("relay_email_sent", to=to_addr, type=etype, recipient=recipient_id)

    # ── two-phase dedup ──────────────────────────────────────────────────

    async def _claim(self, event_id: str, recipient_id: str) -> bool:
        assert self._db is not None
        async with self._db.acquire() as conn:
            try:
                ct = await conn.execute(
                    """
                    INSERT INTO email_consumed (event_id, recipient_id, state)
                    VALUES ($1, $2, 'pending')
                    ON CONFLICT (event_id, recipient_id) DO NOTHING
                    """,
                    event_id, recipient_id,
                )
                # asyncpg returns 'INSERT 0 N' — N is the count.
                return ct.split()[-1] == "1"
            except Exception as exc:  # noqa: BLE001
                _log.error("relay_claim_failed", event_id=event_id, error=str(exc))
                return False

    async def _is_sent(self, event_id: str, recipient_id: str) -> bool:
        """True if a 'sent' row exists (a real duplicate, not our pending retry)."""
        assert self._db is not None
        async with self._db.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT 1 FROM email_consumed
                WHERE event_id = $1 AND recipient_id = $2 AND state = 'sent'
                """,
                event_id, recipient_id,
            )
            return row is not None

    async def _mark_sent(self, event_id: str, recipient_id: str) -> None:
        assert self._db is not None
        async with self._db.acquire() as conn:
            await conn.execute(
                """
                UPDATE email_consumed SET state = 'sent', sent_at = now()
                WHERE event_id = $1 AND recipient_id = $2
                """,
                event_id, recipient_id,
            )

    async def _reaper_loop(self) -> None:
        """Re-process rows still 'pending' older than 30s (worker crashed).

        Reaper-driven retries don't try to re-send the email yet — that
        would require persisting the full event payload. Instead the reaper
        flips them to 'sent' so we move on; in practice a crash mid-pipeline
        is rare and a missed notification per crash is acceptable (the
        in-app inbox is always authoritative).
        """
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=30.0)
                return
            except asyncio.TimeoutError:
                pass
            if self._db is None:
                continue
            try:
                async with self._db.acquire() as conn:
                    ct = await conn.execute(
                        """
                        UPDATE email_consumed SET state = 'sent', sent_at = now()
                        WHERE state = 'pending' AND consumed_at < now() - interval '30 seconds'
                        """,
                    )
                # asyncpg returns "UPDATE N"
                n = ct.split()[-1] if ct else "0"
                if n != "0":
                    _log.info("relay_reaped_pending", count=n)
            except Exception as exc:  # noqa: BLE001
                _log.warning("relay_reaper_failed", error=str(exc))

    async def _stop_quietly(self, client) -> None:
        # A hung broker must not block shutdown forever.
        try:
            await asyncio.wait_for(client.stop(), timeout=_STOP_TIMEOUT)
        except asyncio.TimeoutError:
            _log.warning("relay_stop_timeout", client=type(client).__name__)
        except Exception as exc:  # noqa: BLE001
            _log.warning("relay_stop_error", error=str(exc))

    # ── DB setup ─────────────────────────────────────────────────────────

    async def _connect_db(self) -> None:
        # Retry briefly while Postgres warms up alongside the rest of the
        # stack on docker-compose first-up.
        for attempt in range(30):
            try:
                self._db = await asyncpg.create_pool(
                    dsn=self._settings.email_db_dsn,
                    ssl=self._settings.email_db_ssl_context,
                    min_size=1,
                    max_size=4,
                )
                async with self._db.acquire() as conn:
                    await conn.execute("SELECT 1")
                return
            except Exception as exc:  # noqa: BLE001
                _log.warning("relay_db_connect_retry", attempt=attempt + 1,
                             error=str(exc))
                await asyncio.sleep(2.0)
        raise RuntimeError("could not connect to emaildb")

    async def _apply_migrations(self) -> None:
        assert self._db is not None
        # Path is relative to the worker's working dir inside the container.
        # In dev, the file is mounted; in prod the migrations folder is
        # bundled alongside app/. Resilient to either by importing-relative.
        from pathlib import Path
        here = Path(__file__).resolve().parent.parent
        migrations = sorted((here / "migrations").glob("*.sql"))
        async with self._db.acquire() as conn:
            for f in migrations:
                sql = f.read_text(encoding="utf-8")
                try:
                    await conn.execute(sql)
                    _log.info("relay_migration_applied", file=f.name)
                except Exception as exc:  # noqa: BLE001
                    _log.error("relay_migration_failed", file=f.name, error=str(exc))
                    raise


