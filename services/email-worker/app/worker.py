"""email-worker: consume auth.events, send invite emails via SMTP.

Kafka consumer (no web server, no port) backed by email-worker's OWN database
(emaildb) for durable, exactly-once-ish dedup. Filters type == "invite.created"
and emails the invitee. Dedup is the same DB-backed ``email_consumed`` table the
relay consumer uses — a 'sent' row keyed by (eventId, inviteId) survives
restarts, so a redelivered event after a crash is NOT re-sent.

Offsets are committed manually (enable_auto_commit=False) only AFTER a
successful send + dedup-row write, so the offset can never advance past an
event we failed to deliver.
"""
from __future__ import annotations

import asyncio
import json
import signal

import asyncpg
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from aiokafka.errors import KafkaConnectionError, KafkaError
from opentelemetry import trace
from opentelemetry.trace import SpanKind

from .config import Settings, load_settings
from .logging_setup import configure_logging, get_logger
from .mailer import Mailer, is_valid_email
from .templates import render_invite_email
from .tracing import extract_context, inject_headers, setup_tracing

INVITE_CREATED = "invite.created"

_tracer = trace.get_tracer(__name__)

_KAFKA_RECONNECT_BASE = 1.0
_KAFKA_RECONNECT_MAX = 30.0

# Bound how long a hung broker can block shutdown.
_STOP_TIMEOUT = 30.0


class EmailWorker:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._log = get_logger("worker")
        self._mailer = Mailer(
            host=settings.smtp_host,
            port=settings.smtp_port,
            sender=settings.smtp_from,
            username=settings.smtp_username,
            password=settings.smtp_password,
            starttls=settings.smtp_starttls,
        )
        self._db: asyncpg.Pool | None = None
        self._producer: AIOKafkaProducer | None = None
        # Consecutive failure count per event_id; poison messages (>= N) are
        # routed to the DLQ so they can't loop forever.
        self._failures: dict[str, int] = {}
        self._stop = asyncio.Event()

    def request_stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        self._log.info(
            "starting",
            kafka_brokers=self._settings.kafka_brokers,
            topic=self._settings.auth_topic,
            group=self._settings.consumer_group,
            smtp=f"{self._settings.smtp_host}:{self._settings.smtp_port}",
        )
        await self._connect_db()
        attempt = 0
        while not self._stop.is_set():
            consumer = AIOKafkaConsumer(
                self._settings.auth_topic,
                bootstrap_servers=self._settings.kafka_brokers,
                group_id=self._settings.consumer_group,
                # Manual commit: the offset only advances AFTER a successful
                # send + dedup-row write (see _consume_loop).
                enable_auto_commit=False,
                auto_offset_reset="earliest",
                value_deserializer=lambda b: b,  # raw bytes; we json.loads ourselves
            )
            producer = AIOKafkaProducer(
                bootstrap_servers=self._settings.kafka_brokers,
            )
            try:
                await consumer.start()
                await producer.start()
            except (KafkaConnectionError, KafkaError, OSError) as exc:
                attempt += 1
                delay = min(
                    _KAFKA_RECONNECT_BASE * (2 ** (attempt - 1)),
                    _KAFKA_RECONNECT_MAX,
                )
                self._log.warning(
                    "kafka_connect_retry",
                    attempt=attempt,
                    next_delay_s=delay,
                    error=str(exc),
                )
                await self._stop_quietly(consumer)
                await self._stop_quietly(producer)
                await self._sleep_or_stop(delay)
                continue

            attempt = 0
            self._producer = producer
            self._log.info("ready", topic=self._settings.auth_topic)
            try:
                await self._consume_loop(consumer)
            except (KafkaConnectionError, KafkaError, OSError) as exc:
                self._log.warning("consume_loop_error_reconnecting", error=str(exc))
            finally:
                self._producer = None
                await self._stop_quietly(consumer)
                await self._stop_quietly(producer)

        if self._db:
            await self._db.close()
        self._log.info("stopped")

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
                        ok_one = await self._handle_message(msg.value)
                    if not ok_one:
                        # A transient failure below the poison threshold — do
                        # NOT advance the offset so Kafka redelivers and retries.
                        ok = False
            # Commit only AFTER the batch's sends + dedup-row writes succeeded.
            if handled and ok:
                await consumer.commit()
            if self._stop.is_set():
                break

    async def _handle_message(self, raw: bytes) -> bool:
        """Process one event. Return True if the offset may advance, False if a
        transient failure means the batch must NOT be committed."""
        try:
            event = json.loads(raw)
        except (ValueError, TypeError) as exc:
            self._log.warning("bad_json_skipped", error=str(exc))
            return True

        if not isinstance(event, dict):
            return True

        if event.get("type") != INVITE_CREATED:
            return True

        event_id = event.get("eventId")
        if not event_id:
            self._log.warning("missing_event_id_skipped", type=event.get("type"))
            return True

        # Durable dedup: a 'sent' row keyed by this event already means done.
        if await self._already_sent(str(event_id)):
            self._log.info("duplicate_skipped", event_id=event_id)
            return True

        try:
            await self._send_invite(event)
        except Exception as exc:  # noqa: BLE001 - poison-message handling below
            return await self._on_failure(str(event_id), event, str(exc))

        self._failures.pop(str(event_id), None)
        return True

    async def _send_invite(self, event: dict) -> None:
        """Send the invite and write the durable dedup row.

        Returns normally if the event is fully handled (sent or deliberately
        skipped). Raises to signal a transient failure that must NOT commit.
        """
        email = event.get("email")
        org_name = event.get("orgName", "your team")
        invite_url = event.get("inviteUrl", "")
        invited_by = event.get("invitedByUsername", "A teammate")
        expires_at = event.get("expiresAt", "")
        event_id = event.get("eventId")
        invite_id = event.get("inviteId")

        if not email or not invite_url:
            self._log.warning(
                "incomplete_invite_skipped",
                event_id=event_id,
                has_email=bool(email),
                has_url=bool(invite_url),
            )
            # Nothing actionable — record as handled so we don't loop.
            await self._mark_sent(str(event_id), invite_id)
            return

        # Invalid recipients are rejected by SMTP and would retry forever;
        # log + mark sent (skip) instead.
        if not is_valid_email(str(email)):
            self._log.warning("invite_invalid_email_skipped", event_id=event_id, to=email)
            await self._mark_sent(str(event_id), invite_id)
            return

        subject = f"You're invited to {org_name} on BlissWork"
        text_body, html_body = render_invite_email(
            org_name=org_name,
            invited_by=invited_by,
            invite_url=invite_url,
            expires_at=expires_at,
        )

        await self._mailer.send(
            to=email,
            subject=subject,
            text_body=text_body,
            html_body=html_body,
        )

        # Durable dedup-row write happens only after a successful send.
        await self._mark_sent(str(event_id), invite_id)

        self._log.info(
            "invite_email_sent",
            event_id=event_id,
            invite_id=invite_id,
            to=email,
            org_name=org_name,
        )

    async def _on_failure(self, event_id: str, event: dict, error: str) -> bool:
        """Count consecutive failures; route poison messages to the DLQ.

        Returns False below the threshold so the caller leaves the offset
        uncommitted and Kafka redelivers (retry). At/after the threshold we
        publish to the DLQ and return True so the offset commits and the poison
        message stops looping.
        """
        n = self._failures.get(event_id, 0) + 1
        self._failures[event_id] = n
        self._log.error(
            "invite_email_failed", event_id=event_id, attempt=n, error=error
        )
        if n >= self._settings.poison_max_failures:
            await self._to_dlq(event, error)
            self._failures.pop(event_id, None)
            return True
        # Don't commit — Kafka redelivers this event and we retry.
        return False

    async def _to_dlq(self, event: dict, error: str) -> None:
        if self._producer is None:
            self._log.error("dlq_producer_unavailable", event_id=event.get("eventId"))
            return
        envelope = {"reason": error, "source": "invite", "event": event}
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
            self._log.warning(
                "invite_routed_to_dlq",
                event_id=event.get("eventId"),
                topic=self._settings.dlq_topic,
            )
        except Exception as exc:  # noqa: BLE001 - DLQ best-effort
            self._log.error("dlq_publish_failed", event_id=event.get("eventId"), error=str(exc))

    # ── durable dedup (reuses email_consumed; recipient_id = inviteId) ───────

    async def _already_sent(self, event_id: str) -> bool:
        assert self._db is not None
        async with self._db.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT 1 FROM email_consumed WHERE event_id = $1 AND state = 'sent'",
                event_id,
            )
            return row is not None

    async def _mark_sent(self, event_id: str, invite_id) -> None:
        assert self._db is not None
        # email_consumed.recipient_id is uuid NOT NULL; invites have no separate
        # recipient uuid, so key the row on inviteId (a uuid), falling back to
        # eventId (also a uuid) for the rare event missing one. _already_sent
        # queries by event_id alone, so either choice dedups correctly.
        recipient_id = invite_id or event_id
        async with self._db.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO email_consumed (event_id, recipient_id, state, sent_at)
                VALUES ($1, $2, 'sent', now())
                ON CONFLICT (event_id, recipient_id)
                DO UPDATE SET state = 'sent', sent_at = now()
                """,
                event_id, recipient_id,
            )

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
                self._log.warning("db_connect_retry", attempt=attempt + 1, error=str(exc))
                await asyncio.sleep(2.0)
        raise RuntimeError("could not connect to emaildb")

    async def _stop_quietly(self, client) -> None:
        # A hung broker must not block shutdown forever.
        try:
            await asyncio.wait_for(client.stop(), timeout=_STOP_TIMEOUT)
        except asyncio.TimeoutError:
            self._log.warning("stop_timeout", client=type(client).__name__)
        except Exception as exc:  # noqa: BLE001
            self._log.warning("stop_error", error=str(exc))

    async def _sleep_or_stop(self, delay: float) -> None:
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass


async def _amain() -> None:
    settings = load_settings()
    configure_logging(settings.log_level)
    # Gated on OTEL_EXPORTER_OTLP_ENDPOINT — no-ops when unset (dev default).
    setup_tracing()
    worker = EmailWorker(settings)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, worker.request_stop)
        except NotImplementedError:
            # Signal handlers are unavailable on some platforms (e.g. Windows).
            pass

    await worker.run()


def main() -> None:
    try:
        asyncio.run(_amain())
    except KeyboardInterrupt:
        get_logger("worker").info("interrupted")


if __name__ == "__main__":
    main()
