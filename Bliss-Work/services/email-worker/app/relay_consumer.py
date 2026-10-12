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
  4. Offline gate: check presence FIRST. Already online → done, no email, no
     wait. Offline → wait out a grace window (event.occurredAt until it is
     offline_threshold_seconds old, measured from occurredAt NOT now(), so an
     event this consumer reaches late — a rebalance, a backlog — has already
     used it up), then check presence again before deciding to send: a
     reconnect during the wait still skips the email.
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
import hashlib
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import asyncpg
import httpx
import structlog
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from aiokafka.errors import KafkaConnectionError, KafkaError
from opentelemetry import trace
from opentelemetry.trace import SpanKind
from kafka_security import kafka_security_kwargs

from .attachments import Attachment, fetch as fetch_attachment, within_budget
from .config import Settings
from .healthcheck import record_heartbeat
from .internal_ids import uuid_path_segment
from .log_safety import recipient_ref, redact_email_addresses
from .mailer import Mailer, PermanentSMTPError, is_valid_email
from .migrations import run_migrations
from .presence import Presence
from .provider_mail import ProviderMailUnavailable, send as provider_send
from resilience import CircuitBreaker, CircuitOpenError, retry_async
from .templates import render_new_message_email, render_new_task_email, render_user_mail
from tracing import extract_context, inject_headers

_log = structlog.get_logger("relay")

_tracer = trace.get_tracer(__name__)

# Bounded per-attempt timeout for the auth-svc internal user lookup (the shared
# AsyncClient is created with timeout=5.0; we tighten the per-attempt budget via
# httpx.Timeout on the request itself so a slow auth-svc can't pin the worker).
_LOOKUP_TIMEOUT = 3.0
_LOOKUP_ATTEMPTS = 3

MESSAGE_CREATED = "message.created"
TASK_ASSIGNED = "task.assigned"
# One copy of a user's own email, bound for one address outside the workspace.
# Unlike the two above this is not a NOTIFICATION about something that happened
# in the app — it IS the thing the user sent, and the only way it reaches its
# recipient. That difference drives every special case below: no presence gate,
# no auth-svc lookup, and a template that does not dress it up.
MAIL_OUTBOUND = "mail.outbound"

# What a DLQ record may say about the event that failed — an ALLOW-list.
#
# The DLQ topic has the same no-ACL exposure as every other topic, and a relayed
# event carries user content and addresses: message.created's `body`,
# task.assigned's `title`/`description`, mail.outbound's `envelope`, `to`/`cc`,
# `subject`, `bodyText`/`bodyHtml`, `fromName`/`fromAddress`, `attachments` and
# the provider recipient lists. A deny-list of those fields (what this used to
# be) leaks every field it does not know about — it already missed most of the
# above — so only opaque identifiers and the event's type/time are kept: enough
# to find the event in its source topic, none of it content.
_DLQ_EVENT_FIELDS = (
    "eventId", "type", "orgId", "occurredAt",
    "mailId", "messageId", "conversationId", "taskId",
    "recipientId", "assigneeId", "senderId", "authorId", "providerCopy",
)
_DLQ_VALUE_MAX = 128
# `reason` is an exception string. SMTP/provider errors routinely quote the
# rejected address ("550 5.1.1 <jane@x.com>: Recipient address rejected").
_DLQ_REASON_MAX = 300


def _dlq_event(event: dict) -> dict:
    """The allow-listed, content-free view of `event` that may reach the DLQ.

    The outbound recipient is replaced by a short hash so two DLQ records for
    the same address can still be correlated without publishing the address.
    """
    safe: dict = {}
    for key in _DLQ_EVENT_FIELDS:
        value = event.get(key)
        # Scalars only: a nested object under an allow-listed name is not an id.
        if isinstance(value, str):
            safe[key] = value[:_DLQ_VALUE_MAX]
        elif isinstance(value, (bool, int, float)):
            safe[key] = value
    envelope = event.get("envelope")
    if isinstance(envelope, str) and envelope:
        safe["envelopeHash"] = hashlib.sha256(envelope.strip().lower().encode("utf-8")).hexdigest()[:16]
    return safe


def _dlq_reason(error: str) -> str:
    return redact_email_addresses(error)[:_DLQ_REASON_MAX]


def _assignment_timestamp(value: object) -> str:
    """Format an event timestamp for the task email, or omit malformed values."""
    if not isinstance(value, str):
        return ""
    try:
        occurred_at = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return ""
    if occurred_at.tzinfo is None:
        return ""
    return occurred_at.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


# How one mail left the deployment. Persisted in mail_transport — see the
# migration and _decide_transport for why the copies of one mail have to agree.
TRANSPORT_PROVIDER = "provider"
TRANSPORT_RELAY = "relay"
#: Not a stored value: the deciding copy has not been processed yet.
TRANSPORT_UNDECIDED = "undecided"

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
    # An in-app mail delivery needs no email ABOUT it: the recipient has a
    # BlissWork account and the mail is already in their Inbox. Relaying one
    # would send someone an email to tell them they have an email.
    "mail.delivered",
}

# Limit how much message body lands inside a single email — keep things
# scannable and avoid SMTP body-length issues at the destination.
PREVIEW_LEN = 200

# Match task-svc's validated description bound so task emails include the full
# assignment context without letting malformed events create unbounded mail.
TASK_DESCRIPTION_LEN = 10_000

# A task title becomes part of the Subject header; oversized headers get
# rejected by some SMTP servers, so cap it before building the subject.
TITLE_LEN = 120

# Bound how long a hung broker can block shutdown.
_STOP_TIMEOUT = 30.0

# How many of one mail's attachments _collect_attachments fetches at once. A
# mail with several files used to fetch them one at a time — N attachments
# meant N sequential round trips, each up to FETCH_TIMEOUT, serializing behind
# a single message the same way the consumer loop itself used to. Bounded
# rather than unbounded so one mail with an unusually long attachment list
# cannot open dozens of simultaneous streams to messaging-svc.
_ATTACHMENT_FETCH_CONCURRENCY = 6


# Pause before a failed batch is re-read, so a dead SMTP relay or database is
# not hammered. Failures are counted per event and routed to the DLQ past
# poison_max_failures, so this only ever bounds a transient outage.
_RETRY_BACKOFF = 2.0

# Cap on consecutive ProviderMailUnavailable failures (NOT a 409) for one mail
# before it is dead-lettered — see _handle_provider_unavailable. 30 x the 2s
# _RETRY_BACKOFF is about a minute of retrying, enough for integrations-svc's
# 60s refresh sweep to renew a token, yet finite so one author's permanently
# broken mailbox cannot hold a partition forever.
_PROVIDER_UNAVAILABLE_MAX_FAILURES = 30

# ── Reaper abandonment window ───────────────────────────────────────────────
#
# _reap_once reclaims a 'pending' row once it has gone this long without a
# _touch_claim refresh (see below). It must be a genuine upper bound on how
# long a SINGLE phase between two touches can legitimately take, in ANY
# replica — this consumer runs with several replicas sharing one
# email_consumed table, and every replica's reaper sweeps every replica's
# rows (there is no per-row owner-replica column, only the relay/email_worker
# `owner`). A window shorter than a real phase's worst case means replica B
# can delete replica A's still-in-progress claim: the row disappears, A's
# later _mark_sent silently updates zero rows, and a subsequent redelivery
# finds no claim at all and sends the message a second time. This is exactly
# what happened when the window was a flat 30s while the notification path's
# grace wait alone could reach offline_threshold_seconds (60s default,
# operator-configurable higher) and Mailer.send()'s own retry budget could
# reach ~108s (_MAX_ATTEMPTS=5 attempts x up to a 20s socket timeout, plus
# 0.5+1+2+4=7.5s of backoff between them — see mailer.py).
#
# _REAP_SEND_BUDGET_SECONDS covers the send-side phase(s): _lookup_user
# (x2) + Mailer.send() on the notification path, or attachment collection /
# provider_send / Mailer.send() on the mail.outbound path (each phase is
# individually bounded well under this by its own timeout — see
# _touch_claim's call sites for where each phase's clock resets). Rounded up
# generously past the ~108s Mailer figure rather than pinned to it exactly,
# so a small change to Mailer's own constants doesn't silently reopen this
# race — this is deliberately a loose, easy-to-verify bound, not a tight one.
_REAP_SEND_BUDGET_SECONDS = 180.0


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
        # (event_id, recipient_key) pairs this process is actively working on
        # right now — claimed and not yet marked sent. This is a same-process
        # fast path only: it lets THIS process's own reaper sweep skip its own
        # active rows without a DB round trip. It is NOT what makes a
        # different replica's reaper safe — that replica's _inflight set
        # knows nothing about this process's work. Cross-replica safety comes
        # from _reap_once's abandonment window itself being sized to cover
        # the real worst case (see _REAP_SEND_BUDGET_SECONDS) and from
        # _touch_claim resetting a row's clock at each phase boundary. See
        # _mark_inflight and _reaper_loop.
        self._inflight: set[tuple[str, str]] = set()
        # Circuit breaker for the auth-svc internal user-lookup. Once auth-svc
        # has been failing, the breaker opens and lookups fail fast for a
        # cooldown — the relay then SKIPS the email (marks sent) instead of
        # blocking the consumer on the per-attempt timeout for every event.
        self._auth_breaker = CircuitBreaker(
            fail_max=5, reset_timeout=30.0, name="auth-svc"
        )
        self._stop = asyncio.Event()
        # Bounds how many messages this process handles at once — see
        # _consume_loop and Settings.relay_max_concurrency.
        self._semaphore = asyncio.Semaphore(settings.relay_max_concurrency)

    def request_stop(self) -> None:
        self._stop.set()

    async def run(self) -> None:
        self._presence = Presence(self._settings.redis_url)
        self._http = httpx.AsyncClient(timeout=5.0)
        await self._connect_db()

        # All replicas use the same transaction-scoped lock and migration ledger.
        await self._apply_migrations()

        consumer = AIOKafkaConsumer(
            self._settings.messaging_topic,
            self._settings.task_topic,
            bootstrap_servers=self._settings.kafka_brokers,
            # TLS/SASL when KAFKA_SECURITY_PROTOCOL asks for it; empty otherwise.
            **kafka_security_kwargs(),
            group_id=self._settings.relay_consumer_group,
            # Manual commit: the offset only advances AFTER _mark_sent, so it
            # can never commit mid-SMTP-send.
            enable_auto_commit=False,
            auto_offset_reset="latest",
            value_deserializer=lambda b: b,
        )
        self._producer = AIOKafkaProducer(
            bootstrap_servers=self._settings.kafka_brokers,
            # TLS/SASL when KAFKA_SECURITY_PROTOCOL asks for it; empty otherwise.
            **kafka_security_kwargs(),
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
            handled = bool(batch)
            if batch:
                # One partition's messages MUST stay in order — that is the
                # guarantee _decide_transport relies on (every copy of one mail
                # shares the mail id as its Kafka key, so they land on one
                # partition in send order, and the first copy has to record its
                # provider-transport decision before the others read it). Kafka
                # gives no ordering guarantee ACROSS partitions though, so
                # different partitions run concurrently — bounded by
                # self._semaphore — instead of the whole batch queuing behind
                # whichever message happens to be slowest. A hung SMTP retry
                # chain on one partition no longer blocks every other partition
                # in the batch, which previously stalled the WHOLE 100-message
                # poll behind a single message's up-to-~100s worst case.
                results = await asyncio.gather(
                    *(self._handle_partition(messages) for messages in batch.values())
                )
                ok = all(results)
            else:
                ok = True
            # Commit only AFTER every partition's _mark_sent writes completed.
            if handled and ok:
                await consumer.commit()
            elif handled:
                # Not committing is not enough: the fetch position has already
                # moved past this batch, so the next getmany() returns what comes
                # AFTER it, and when that succeeds its commit carries the offset
                # past the message that failed — skipped for good, not retried.
                # Seeking back is what makes "Kafka redelivers and we retry" true.
                # Re-running the messages that did succeed is safe: each is
                # dedup-claimed and already 'sent'.
                for tp, messages in batch.items():
                    consumer.seek(tp, messages[0].offset)
                await self._sleep_or_stop(_RETRY_BACKOFF)
            record_heartbeat("relay")
            if self._stop.is_set():
                break

    async def _sleep_or_stop(self, delay: float) -> None:
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass

    async def _handle_partition(self, messages) -> bool:
        """Process one partition's slice of a batch, strictly in order."""
        ok = True
        for msg in messages:
            async with self._semaphore:
                # CONSUMER span continuing the producer's trace via the
                # traceparent header. No-op when tracing is disabled.
                ctx = extract_context(msg.headers)
                with _tracer.start_as_current_span(
                    f"{msg.topic} process", context=ctx, kind=SpanKind.CONSUMER
                ):
                    ok_one = await self._handle(msg.value)
            if not ok_one:
                # A transient failure below the poison threshold — do NOT
                # advance the offset so Kafka redelivers and retries.
                ok = False
        return ok

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
        if etype not in (MESSAGE_CREATED, TASK_ASSIGNED, MAIL_OUTBOUND):
            return True

        event_id = event.get("eventId")
        if not event_id:
            return True

        if etype == MAIL_OUTBOUND:
            return await self._handle_outbound_mail(event, event_id)

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
            # A 'sent' row means a true duplicate — done.
            if await self._is_sent(event_id, recipient_id):
                return True
            # Still 'pending', not 'sent': this process's own _inflight set
            # only ever sees ITS OWN in-flight work, never another process's
            # — so this is NOT proof "our earlier attempt failed before
            # _mark_sent". During a rebalance where the prior owner hasn't
            # crashed (just hasn't polled recently — max.poll.interval.ms
            # exceeded, say), a second instance reaches this exact branch
            # while the first is still genuinely mid-send. Retrying here
            # used to send a duplicate straight into an external recipient's
            # inbox. This module's own docstring already says the right
            # answer: leave a still-pending row for the reaper (_reap_once),
            # which only reclaims a row once it has been abandoned long
            # enough that "still genuinely in flight" is no longer
            # plausible. Returning False leaves the offset uncommitted, so
            # Kafka redelivers and this same check runs again later — by
            # then either the owning attempt has committed 'sent' (caught
            # above) or the reaper has reclaimed it.
            return False

        async with self._mark_inflight(str(event_id), str(recipient_id)):
            # Presence gate, checked FIRST. A recipient already online right
            # now needs neither an email nor the wait below — the in-app copy
            # is what they'll see. This used to be checked only AFTER the
            # wait, so EVERY event on this (the highest-volume) topic paid up
            # to offline_threshold_seconds before this partition's next batch
            # could even be picked up — online recipients included, throttling
            # live in-app delivery on unrelated events behind it for no
            # reason: nothing about an online recipient can change during a
            # wait that exists only to give an OFFLINE one a chance to
            # reconnect.
            if not await self._should_relay(recipient_id):
                # Online: mark sent (=skipped, no rewind) so a later replay
                # doesn't try again. The result is the same to the user.
                await self._mark_sent(event_id, recipient_id)
                self._failures.pop(str(event_id), None)
                return True

            # Offline right now: give them a grace window to reconnect and see
            # the event live before it becomes an email. event.occurredAt is
            # the canonical "when did this happen on the bus" timestamp —
            # measuring from it rather than from now() means an event this
            # consumer only reaches late (a rebalance, a backlog) has already
            # used up its window and skips straight to the final check below
            # with wait=0.
            #
            # Waiting here is safe against the reaper because this pair is in
            # _inflight for THIS process (see _mark_inflight) and, for every
            # process, because the wait itself is bounded by
            # offline_threshold_seconds — _reap_once's window covers at least
            # that. See _REAP_SEND_BUDGET_SECONDS.
            wait = self._grace_remaining(event.get("occurredAt", ""))
            if wait > 0:
                await self._sleep_or_stop(wait)
                if self._stop.is_set():
                    # Shutting down mid-wait: NOT a skip. Release the claim so the
                    # redelivery after the restart can send it.
                    await self._release_claim(str(event_id), str(recipient_id))
                    return False
                # The wait is the only thing that can leave this claim
                # 'pending' for anywhere near the reaper's abandonment window.
                # Refresh it here so _reap_once measures the send phase that
                # follows from THIS point, not from the original claim —
                # keeping the window's job to covering one phase at a time
                # instead of their sum.
                await self._touch_claim(str(event_id), str(recipient_id))

            # Final check: they may have reconnected during the wait. Still
            # offline (or the window was already used up above) → send.
            if not await self._should_relay(recipient_id):
                await self._mark_sent(event_id, recipient_id)
                self._failures.pop(str(event_id), None)
                return True

            try:
                await self._send_for_event(event, recipient_id, etype)
            except CircuitOpenError as exc:
                if etype == TASK_ASSIGNED:
                    return await self._retry_or_dlq(
                        str(event_id),
                        str(recipient_id),
                        event,
                        str(exc),
                    )
                # auth-svc is known-bad (breaker open): SKIP this email rather
                # than blocking the consumer on the lookup. Mark sent so a
                # later replay doesn't retry — the in-app inbox remains
                # authoritative, so a dropped notification during an auth-svc
                # outage is acceptable.
                _log.warning("relay_skipped_auth_breaker_open", event_id=event_id,
                             recipient=recipient_id, error=str(exc))
                await self._mark_sent(event_id, recipient_id)
                self._failures.pop(str(event_id), None)
                return True
            except Exception as exc:  # noqa: BLE001 - poison-message handling below
                return await self._retry_or_dlq(
                    str(event_id),
                    str(recipient_id),
                    event,
                    str(exc),
                    max_failures=1 if isinstance(exc, PermanentSMTPError) else None,
                )

            # Offset advances only AFTER _mark_sent completes.
            await self._mark_sent(event_id, recipient_id)
            self._failures.pop(str(event_id), None)
            return True

    async def _handle_outbound_mail(self, event: dict, event_id: str) -> bool:
        """Put ONE copy of a user's own email on the wire.

        Three things this path deliberately does NOT do, each of which the
        notification path does:

        * No presence gate. The offline check exists so we don't email someone
          about something they are already watching happen. This mail has no
          in-app copy for its recipient to be watching — they are outside the
          workspace, and SMTP is the only way it reaches them at all.
        * No auth-svc lookup. Both addresses are on the event, resolved by
          messaging-svc at send time against the org directory.
        * No notification template. See templates.render_user_mail.

        Dedup still applies, keyed by (eventId, mailId): messaging-svc emits one
        event per external addressee, so the pair is unique per copy and a
        redelivered batch cannot send the same person the same mail twice.

        The whole body runs behind a catch-all boundary (mirroring the one
        _handle already puts around the notification path's _send_for_event):
        without it, any exception here — a DB error surfacing through
        _decide_transport despite the hardening above, or anything else —
        propagated out of _handle, _consume_loop and run(), crashing every
        consumer in the process over one bad message.
        """
        try:
            return await self._do_handle_outbound_mail(event, event_id)
        except Exception as exc:  # noqa: BLE001 - poison-message handling below
            return await self._retry_or_dlq(
                str(event_id),
                str(event.get("mailId") or ""),
                event,
                str(exc),
                max_failures=1 if isinstance(exc, PermanentSMTPError) else None,
            )

    async def _do_handle_outbound_mail(self, event: dict, event_id: str) -> bool:
        envelope = str(event.get("envelope") or "")
        mail_id = event.get("mailId")
        if not mail_id:
            _log.warning("relay_mail_missing_id", event_id=event_id)
            return True
        if not is_valid_email(envelope):
            # Rejected by SMTP and retried forever otherwise. messaging-svc
            # validates on the way in, so reaching here means a malformed
            # producer, not a user typo — log loudly and drop the copy.
            _log.warning(
                "relay_mail_invalid_envelope",
                event_id=event_id,
                recipient_ref=recipient_ref(envelope),
            )
            return True

        claimed = await self._claim(event_id, mail_id)
        if not claimed:
            # Same reasoning as _handle above: a 'sent' row means a true
            # duplicate (done), but a still-'pending' row is not proof our
            # own earlier attempt failed — another process may genuinely be
            # mid-send after a rebalance. Returning False leaves the offset
            # uncommitted so Kafka redelivers and this check runs again once
            # the owning attempt has either committed 'sent' or been
            # reclaimed by the reaper. Falling through here would send this
            # external recipient's copy of the mail twice.
            if await self._is_sent(event_id, mail_id):
                return True
            return False

        async with self._mark_inflight(str(event_id), str(mail_id)):
            sender_name = str(event.get("fromName") or "")
            sender_address = str(event.get("fromAddress") or "")
            # An empty Subject is both unhelpful to the recipient and a
            # filtering signal in its own right on the corporate mail systems
            # this most often lands on. Applied once, so both transports send
            # the same header.
            subject = str(event.get("subject") or "").strip() or "(no subject)"
            parts, skipped = await self._collect_attachments(event, event_id, mail_id)
            text, html = render_user_mail(
                body=str(event.get("bodyText") or ""),
                sender_name=sender_name,
                sender_address=sender_address,
                skipped_files=skipped,
            )

            # Attachment collection is the one open-ended phase on this path
            # (no fixed cap on attachment count, unlike the bounded calls
            # below) — refresh here so the reaper's window only has to cover
            # what's left (provider send, then maybe the SMTP send), not the
            # whole claim-to-sent span. See _touch_claim / _REAP_SEND_BUDGET_SECONDS.
            await self._touch_claim(event_id, str(mail_id))

            # Through the author's own mailbox when they have one — see
            # provider_mail for why that is worth preferring.
            try:
                transport, covered = await self._decide_transport(
                    event, mail_id, parts, subject, text, html
                )
            except ProviderMailUnavailable as exc:
                _log.warning(
                    "relay_mail_provider_unavailable",
                    mail_id=mail_id,
                    conflict=exc.conflict,
                    error=redact_email_addresses(exc),
                )
                return await self._handle_provider_unavailable(event_id, event, mail_id, exc)
            # `covered` is the set of envelopes the provider send actually
            # reached (None means an old, pre-migration row with no recorded
            # set — treated as "assume covered", the prior behavior). A local
            # org member's own copy is deliberately NEVER in that set (see
            # mail_send.go's relayRecipients / splitExternalsByKind) — it still
            # needs its own real-mailbox copy, so it falls through to the
            # relay send below exactly like the no-connected-mailbox case.
            if transport == TRANSPORT_PROVIDER and (covered is None or envelope.lower() in covered):
                await self._mark_sent(event_id, mail_id)
                self._failures.pop(str(event_id), None)
                _log.info("relay_mail_sent_via_provider", event_id=event_id, mail_id=mail_id)
                return True
            if transport == TRANSPORT_UNDECIDED:
                # The copy that owns the decision has not finished. It is
                # FIRST on this partition, so this normally cannot happen;
                # bounded retries then the DLQ is the right answer to a state
                # that should not exist, rather than a copy that spins forever.
                return await self._retry_or_dlq(
                    str(event_id), str(mail_id), event,
                    "provider transport not decided for this mail",
                )

            # TRANSPORT_RELAY, or a PROVIDER decision that didn't cover THIS
            # copy's own envelope (a local org member's copy) — either way
            # this specific copy still needs its own real send over SMTP.
            # Refresh again: _decide_transport's own provider_send attempt
            # (when it ran) is now behind us, so the reaper's window only
            # needs to cover the SMTP send below, not that plus everything
            # before it.
            await self._touch_claim(event_id, str(mail_id))
            try:
                await self._mailer.send(
                    to=envelope,
                    subject=subject,
                    text_body=text,
                    html_body=html,
                    from_name=sender_name,
                    # The author's own identity in From, so the mail arrives
                    # from the person who wrote it. Mailer keeps the SMTP
                    # envelope on the deployment's authenticated address
                    # regardless.
                    from_address=sender_address,
                    # The reply target is the author too. Mailer emits the
                    # header only when it says something From does not
                    # already say, so this is a no-op while the two agree —
                    # it is declared rather than assumed so the reply target
                    # survives a change to either.
                    reply_to=sender_address if is_valid_email(sender_address) else "",
                    display_to=[str(a) for a in (event.get("to") or [])],
                    display_cc=[str(a) for a in (event.get("cc") or [])],
                    attachments=parts,
                )
            except Exception as exc:  # noqa: BLE001 - poison-message handling below
                return await self._retry_or_dlq(
                    str(event_id),
                    str(mail_id),
                    event,
                    str(exc),
                    max_failures=1 if isinstance(exc, PermanentSMTPError) else None,
                )

            await self._mark_sent(event_id, mail_id)
            self._failures.pop(str(event_id), None)
            _log.info("relay_mail_sent", event_id=event_id, mail_id=mail_id)
            return True

    async def _handle_provider_unavailable(
        self, event_id: str, event: dict, mail_id: str, exc: ProviderMailUnavailable
    ) -> bool:
        """Retry a mail whose provider send could not be completed — boundedly.

        This used to release the claim and return False with NO counting, so a
        mail that could never succeed rewound the whole batch every
        _RETRY_BACKOFF forever, stalling its partition (and every mail behind
        it). Both kinds now count against the same per-event `_failures`
        counter as every other failure, and past the cap go through the SAME
        poison path (_to_dlq + commit). Neither ever falls back to SMTP: the
        provider may already have delivered the mail, and a relay copy on top
        of it is the duplicate this whole idempotency chain exists to prevent.

        * 409 (`exc.conflict`): integrations-svc's claim for this mail is still
          'sending'. That does not clear by waiting — it is a lost outcome
          parked for an operator — so it gets the ordinary poison_max_failures
          cap: a few quick retries (enough to ride out a genuinely concurrent
          attempt), then the DLQ for manual review.
        * Anything else (5xx, timeout, connection refused, a token mid-refresh
          answered 502): a real outage or refresh window, which does clear, and
          which sustained is already cut short by provider_mail's breaker
          (-> relay). A per-mail cap still has to exist, because a fault
          specific to ONE author (an unrefreshable token) never opens a
          breaker that other authors' successes keep resetting. It is larger
          than poison_max_failures so a ~60s token-refresh sweep is not
          mistaken for poison: _PROVIDER_UNAVAILABLE_MAX_FAILURES x
          _RETRY_BACKOFF.
        """
        cap = (
            self._settings.poison_max_failures
            if exc.conflict
            else max(self._settings.poison_max_failures, _PROVIDER_UNAVAILABLE_MAX_FAILURES)
        )
        return await self._retry_or_dlq(
            event_id, str(mail_id), event, f"provider mail unavailable: {exc}", max_failures=cap
        )

    async def _decide_transport(
        self,
        event: dict,
        mail_id: str,
        parts: list[tuple[str, str, bytes]],
        subject: str,
        text_body: str,
        html_body: str,
    ) -> tuple[str, frozenset[str] | None]:
        """Which way this mail leaves — and, for one copy, actually send it.

        A mail addressed to several outside recipients arrives as one event per
        address, which is what SMTP wants and what keeps a Bcc'd address out of
        everybody's headers. A mailbox provider cannot work that way: it has no
        envelope of its own and delivers to exactly the addresses it is handed,
        so ONE send covers every EXTERNAL recipient — local org members are
        deliberately excluded from that send (they already have an in-app copy)
        but still need their own real-mailbox copy, same as relayRecipients on
        the producer side gives them one.

        messaging-svc therefore marks exactly one copy (`providerCopy`) and puts
        the whole external recipient list on it. That copy sends, records what
        happened AND which envelopes it actually covered, and the rest read the
        record — they cannot work it out for themselves, because whether the
        mailbox exists is only known once it has been tried, and whether THEIR
        OWN envelope was one of the covered ones is not derivable from their own
        payload (only the deciding copy carries providerTo/Cc/Bcc).

        Returns (TRANSPORT_PROVIDER, covered) — covered is the set of envelopes
        (lowercased) the provider send reached, or None for a pre-migration row
        recorded before covered_envelopes existed (treated as "assume covered"
        by the caller, preserving the old behavior for those) — (TRANSPORT_RELAY,
        None), or (TRANSPORT_UNDECIDED, None).
        """
        author_id = str(event.get("authorId") or "")
        if not author_id:
            # An event produced before authorId existed. SMTP is the only route
            # available for it, which is exactly what it was emitted expecting.
            return TRANSPORT_RELAY, None
        if not event.get("providerCopy"):
            decided = await self._read_transport(mail_id)
            return decided if decided is not None else (TRANSPORT_UNDECIDED, None)

        # Recorded BEFORE the send is retried, not after: this is the marker
        # that makes the deciding copy idempotent. Without it a redelivery
        # (crash between the send and the offset commit) sends a second time.
        decided = await self._read_transport(mail_id)
        if decided is not None:
            return decided

        provider_to = [str(a) for a in (event.get("providerTo") or [])]
        provider_cc = [str(a) for a in (event.get("providerCc") or [])]
        provider_bcc = [str(a) for a in (event.get("providerBcc") or [])]
        sent = await provider_send(
            self._http,
            self._settings.integrations_internal_base,
            self._settings.integrations_internal_token,
            org_id=str(event.get("orgId") or ""),
            author_id=author_id,
            mail_id=mail_id,
            subject=subject,
            text_body=text_body,
            html_body=html_body,
            to=provider_to,
            cc=provider_cc,
            bcc=provider_bcc,
            attachments=parts,
        )
        if sent:
            transport = TRANSPORT_PROVIDER
            covered = frozenset(a.lower() for a in provider_to + provider_cc + provider_bcc)
        else:
            transport = TRANSPORT_RELAY
            covered = frozenset()
        await self._record_transport(mail_id, transport, covered)
        return transport, covered

    async def _read_transport(self, mail_id: str) -> tuple[str, frozenset[str] | None] | None:
        """Look up a previously recorded transport decision for `mail_id`.

        Retries a transient DB hiccup a few times (same backoff as
        _mark_sent) before giving up and returning None, rather than treating
        the FIRST failure as "no decision yet". That distinction matters here
        specifically: the deciding copy in _decide_transport reads this to
        decide whether it is safe to call provider_send, which is a REAL
        external send, not idempotent, and not safe to repeat. A read that
        gives up too eagerly on a plain DB blip would look identical to
        "nobody has decided" and could send the same mail through the
        author's mailbox a second time. Retrying first narrows that window to
        a DB outage that outlasts the retries, at which point falling back to
        None still can't crash the consumer — the caller either treats it as
        "not decided" (safe: nothing has been sent yet) or, for the deciding
        copy, the failure is caught by _handle_outbound_mail's boundary and
        the event is retried later via _on_failure, never by assuming success
        or failure of a prior send.
        """
        assert self._db is not None
        for attempt in range(3):
            try:
                async with self._db.acquire() as conn:
                    row = await conn.fetchrow(
                        "SELECT transport, covered_envelopes FROM mail_transport WHERE mail_id = $1",
                        mail_id,
                    )
                    if row is None:
                        return None
                    raw_covered = row["covered_envelopes"]
                    covered = frozenset(a.lower() for a in raw_covered) if raw_covered is not None else None
                    return row["transport"], covered
            except Exception as exc:  # noqa: BLE001
                if attempt == 2:
                    _log.error("relay_read_transport_failed", mail_id=mail_id, error=str(exc))
                    return None
                await asyncio.sleep(0.5 * (2**attempt))
        return None  # unreachable, satisfies type checkers

    async def _record_transport(
        self, mail_id: str, transport: str, covered: frozenset[str]
    ) -> None:
        """First decision wins — a redelivery must not change how a mail that
        has already gone out is described to the copies still to be read.

        `covered` is the set of envelopes (lowercased) the provider send
        actually reached — empty for TRANSPORT_RELAY, where it is never
        consulted. Recording it (rather than just the transport type) is what
        lets a local org member's own copy — deliberately never in that set —
        tell it apart from a covered external one and still get its own relay
        send instead of being silently treated as already delivered.

        Best-effort, no retry: unlike _mark_sent, a failure here is never the
        only thing standing between "sent" and "not sent" — the provider send
        this follows has already happened (or definitively not happened) by
        the time this runs, so retrying can't change that outcome, only delay
        recording it. Logged and swallowed rather than raised: the caller
        still needs to mark the event 'sent' and move on (see
        _handle_outbound_mail), because retrying the whole event on THIS
        failure would re-read a transport that is genuinely missing and could
        send the mail through the provider a second time — see
        _read_transport. A lost write here just means the other copies fail
        safe into a bounded retry + eventual DLQ instead of a clean read.
        """
        assert self._db is not None
        try:
            async with self._db.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO mail_transport (mail_id, transport, covered_envelopes)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (mail_id) DO NOTHING
                    """,
                    mail_id, transport, list(covered),
                )
        except Exception as exc:  # noqa: BLE001
            _log.error("relay_record_transport_failed", mail_id=mail_id,
                       transport=transport, error=str(exc))

    async def _collect_attachments(
        self, event: dict, event_id: str, mail_id: str
    ) -> tuple[list[tuple[str, str, bytes]], list[str]]:
        """Fetch the files that fit. Returns the MIME parts and the names left off.

        Never raises, and never fails the mail. A file that cannot be fetched —
        a blob that outlived its row, a messaging-svc mid-restart — is reported
        as skipped and the message still goes out, because retrying the whole
        mail to recover one attachment would mean nobody receives the words
        either. The recipient is told what is missing rather than left to
        wonder, and the in-app copy for anyone inside the org still has it all.
        """
        # isinstance before iterating: this field crossed a topic, and a string
        # would iterate as characters while a number would raise — out here,
        # OUTSIDE the send's try/except, where it would escape the poison-message
        # handling and take the consumer loop with it.
        raw = event.get("attachments")
        if not isinstance(raw, list):
            return [], []
        declared = [
            att for att in (Attachment.from_event(a) for a in raw) if att is not None
        ]
        if not declared:
            return [], []

        wanted, oversized = within_budget(
            declared, self._settings.mail_attachment_budget_bytes
        )
        if oversized:
            _log.info("relay_mail_attachments_over_budget", event_id=event_id,
                      mail_id=mail_id, count=len(oversized),
                      budget=self._settings.mail_attachment_budget_bytes)

        org_id = str(event.get("orgId") or "")
        skipped = [att.filename for att in oversized]
        if not wanted or self._http is None or not org_id:
            skipped.extend(att.filename for att in wanted)
            return [], skipped

        # Known-size attachments fetch CONCURRENTLY, each capped at its own
        # declared size (+ slack): within_budget already proved their sizes
        # sum to at most the per-mail budget, and that proof holds regardless
        # of fetch order, so no shared/shrinking ceiling is needed between
        # them. This is what used to be one attachment fetched at a time —
        # N attachments meant N sequential round trips, each blocking this
        # message (and, before the batch was split across partitions, every
        # other message behind it in the poll) for up to FETCH_TIMEOUT.
        #
        # Unknown-size attachments (the event's declared sizeBytes was
        # missing/invalid — not the normal case, since messaging-svc always
        # populates it from the attachments row) stay sequential, exactly as
        # before: within_budget reserves nothing for them up front, so the
        # only ceiling that keeps several of them from each independently
        # claiming the whole remaining budget is the shrinking one built from
        # what was actually fetched so far. They run AFTER the known-size
        # batch, against what that batch actually consumed — a small,
        # deliberate refinement over the old strict list-order accounting: a
        # known-size file's own fetch no longer depends on where an
        # unknown-size file happened to sit in the list.
        known = [att for att in wanted if att.size_bytes is not None]
        unknown = [att for att in wanted if att.size_bytes is None]

        fetch_sem = asyncio.Semaphore(min(len(known), _ATTACHMENT_FETCH_CONCURRENCY) or 1)

        async def _fetch_known(att: Attachment) -> bytes | None:
            async with fetch_sem:
                return await fetch_attachment(
                    self._http,
                    base_url=self._settings.messaging_internal_base,
                    token=self._settings.messaging_internal_token,
                    org_id=org_id,
                    mail_id=mail_id,
                    attachment=att,
                    # size_bytes is not None here (that's the `known` split);
                    # fetch() rejects only if declared > this ceiling, so its
                    # own size is exactly the ceiling within_budget already
                    # cleared it against.
                    budget_bytes=att.size_bytes,  # type: ignore[arg-type]
                )

        known_results = (
            await asyncio.gather(*(_fetch_known(att) for att in known)) if known else []
        )
        by_id: dict[str, bytes | None] = dict(zip((att.id for att in known), known_results))
        fetched_known_bytes = sum(len(d) for d in known_results if d is not None)

        remaining = max(self._settings.mail_attachment_budget_bytes - fetched_known_bytes, 0)
        for att in unknown:
            data = await fetch_attachment(
                self._http,
                base_url=self._settings.messaging_internal_base,
                token=self._settings.messaging_internal_token,
                org_id=org_id,
                mail_id=mail_id,
                attachment=att,
                budget_bytes=remaining,
            )
            by_id[att.id] = data
            if data is not None:
                remaining -= len(data)

        parts: list[tuple[str, str, bytes]] = []
        for att in wanted:
            data = by_id.get(att.id)
            if data is None:
                skipped.append(att.filename)
                continue
            parts.append((att.filename, att.mime, data))
        return parts, skipped

    async def _retry_or_dlq(
        self, event_id: str, recipient_key: str, event: dict, error: str,
        max_failures: int | None = None,
    ) -> bool:
        """_on_failure, and settle this attempt's claim either way.

        Every failure path that returns after claiming MUST come through here,
        or the claim stays 'pending' and wedges the partition:

        * Retry (below the threshold): release the claim. The redelivery has to
          be able to claim the event again. Left 'pending', it finds this
          attempt's own row, answers False without counting it, and waits for
          the reaper (>= _REAP_SEND_BUDGET_SECONDS) — which releases a stale
          'pending' row for Kafka redelivery without pretending it was sent.
          That stalled the partition for minutes per attempt, and for
          mail.outbound there is no in-app copy to make up for it.
        * DLQ (at the threshold): the event is finished for good, so the claim
          becomes terminal ('sent' = handled, same as every other deliberate
          skip in this module). Left 'pending', the next rewind of a batch that
          still contains this event would find it, stall until the reaper
          deleted it, and then re-claim and re-fail the event — publishing it
          to the DLQ again.
        """
        done = await self._on_failure(event_id, event, error, max_failures)
        if recipient_key:
            if done:
                await self._mark_sent(event_id, recipient_key)
            else:
                await self._release_claim(event_id, recipient_key)
        return done

    async def _release_claim(self, event_id: str, recipient_key: str) -> None:
        """Drop this attempt's still-'pending' claim so a redelivery can retry.
        Best-effort, and never touches a row that is already 'sent'."""
        if self._db is None:
            _log.warning("relay_release_claim_no_db", event_id=event_id)
            return
        try:
            async with self._db.acquire() as conn:
                await conn.execute(
                    """
                    DELETE FROM email_consumed
                    WHERE event_id = $1 AND recipient_id = $2
                          AND state = 'pending' AND owner = 'relay'
                    """,
                    event_id, recipient_key,
                )
        except Exception as exc:  # noqa: BLE001
            _log.warning("relay_release_claim_failed", event_id=event_id, error=str(exc))

    async def _touch_claim(self, event_id: str, recipient_key: str) -> None:
        """Refresh this claim's consumed_at to now(), resetting the reaper's
        abandonment clock (see _reap_once / _REAP_SEND_BUDGET_SECONDS) at a
        phase boundary — called right after a phase whose worst case is
        already accounted for ends, and before the next one that needs its
        own budget begins.

        Best-effort and never touches a 'sent' row (same guard as
        _release_claim). A failure here only shrinks this row's safety margin
        for the current reaper sweep — it never changes whether the send
        itself succeeds, and the next sweep (30s later) gets another chance
        to see a fresher write if this process makes any further progress on
        the row before then.
        """
        if self._db is None:
            return
        try:
            async with self._db.acquire() as conn:
                await conn.execute(
                    """
                    UPDATE email_consumed SET consumed_at = now()
                    WHERE event_id = $1 AND recipient_id = $2
                          AND state = 'pending' AND owner = 'relay'
                    """,
                    event_id, recipient_key,
                )
        except Exception as exc:  # noqa: BLE001
            _log.warning("relay_touch_claim_failed", event_id=event_id, error=str(exc))

    async def _on_failure(
        self, event_id: str, event: dict, error: str, max_failures: int | None = None
    ) -> bool:
        """Count consecutive failures; route poison messages to the DLQ.

        Returns False below the threshold so the caller leaves the offset
        uncommitted and Kafka redelivers (retry). At/after the threshold we
        publish to the DLQ and return True so the offset commits and the poison
        message stops looping. `max_failures` overrides settings.poison_max_failures
        for a failure class with its own, justified cap."""
        n = self._failures.get(event_id, 0) + 1
        self._failures[event_id] = n
        error = redact_email_addresses(error)
        _log.error("relay_send_failed", event_id=event_id, attempt=n, error=error)
        if n >= (max_failures or self._settings.poison_max_failures):
            await self._to_dlq(event, error)
            self._failures.pop(event_id, None)
            return True
        # Don't commit — Kafka redelivers this event and we retry.
        return False

    async def _to_dlq(self, event: dict, error: str) -> None:
        if self._producer is None:
            _log.error("relay_dlq_producer_unavailable", event_id=event.get("eventId"))
            return
        # Only the allow-listed identifiers reach Kafka — see _DLQ_EVENT_FIELDS.
        envelope = {"reason": _dlq_reason(error), "source": "relay", "event": _dlq_event(event)}
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

    def _grace_remaining(self, occurred_at_iso: str) -> float:
        """Seconds until an event is offline_threshold_seconds old: how long the
        user still has to see it live before it becomes an email. 0 when the
        window has already passed, or the event carries no usable timestamp
        (best-effort: relay if we can't tell)."""
        if not occurred_at_iso:
            return 0.0
        try:
            occurred = datetime.fromisoformat(occurred_at_iso.replace("Z", "+00:00"))
        except ValueError:
            return 0.0
        if occurred.tzinfo is None:
            occurred = occurred.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - occurred).total_seconds()
        threshold = float(self._settings.offline_threshold_seconds)
        # Capped at the window itself: an event stamped in the future (clock
        # skew between producer and this host) must not stall the partition.
        return max(0.0, min(threshold, threshold - age))

    async def _should_relay(self, recipient_id: str) -> bool:
        """True when the recipient is offline right now. Called twice by
        _handle: once immediately (skip the wait entirely if already online),
        and again after the grace window (catch a reconnect that happened
        during the wait)."""
        assert self._presence is not None
        return not await self._presence.is_online(recipient_id)

    async def _lookup_user(
        self,
        user_id: str,
        request_id: str | None = None,
        *,
        retry_transient: bool = False,
    ) -> dict | None:
        """Resolve a user's e-mail/username from auth-svc's internal API.

        Returns the parsed UserDTO dict, or None on miss/non-transient error.
        A task-assignment recipient lookup sets ``retry_transient`` so an
        exhausted transient failure reaches Kafka's retry/DLQ path rather than
        being mistaken for an ineligible recipient.
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
        safe_user_id = uuid_path_segment(user_id, "user_id")
        url = f"{self._settings.auth_internal_base}/internal/users/{safe_user_id}"
        headers = {"X-Internal-Token": self._settings.auth_internal_token}
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
            if retry_transient:
                raise
            # Other relay notices are best-effort: an in-app copy remains
            # authoritative if auth-svc is unavailable.
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
        event_org_id = event.get("orgId")
        recipient = await self._lookup_user(
            recipient_id,
            request_id=request_id,
            retry_transient=etype == TASK_ASSIGNED,
        )
        if not recipient or not recipient.get("email"):
            _log.info("relay_skipped_no_email", recipient=recipient_id, type=etype)
            return
        if not isinstance(event_org_id, str) or recipient.get("orgId") != event_org_id:
            _log.warning("relay_skipped_org_mismatch", recipient=recipient_id, type=etype)
            return
        if recipient.get("emailVerified") is not True:
            _log.info("relay_skipped_unverified_email", recipient=recipient_id, type=etype)
            return
        to_addr = str(recipient["email"])
        # Invalid recipients are rejected by SMTP and would retry forever; log
        # + skip (the caller marks sent) instead.
        if not is_valid_email(to_addr):
            _log.warning(
                "relay_invalid_email_skipped",
                recipient=recipient_id,
                recipient_ref=recipient_ref(to_addr),
            )
            return
        # A recipient who was active when the event was produced may have been
        # suspended/removed by the time this (offline-gated, delayed) send
        # fires. Treat that the same as "no email" rather than SMTP-sending to
        # an account that should no longer hear from this org.
        if recipient.get("status", "active") != "active":
            _log.info("relay_skipped_ineligible_recipient", recipient=recipient_id, type=etype)
            return
        sender_username = ""
        reply_to = ""
        sid = event.get("senderId")
        if sid:
            try:
                sender = await self._lookup_user(sid, request_id=request_id)
            except CircuitOpenError as exc:
                _log.warning(
                    "relay_sender_lookup_skipped",
                    event_id=request_id,
                    sender=sid,
                    error=str(exc),
                )
                sender = None
            if sender and sender.get("orgId") == event_org_id:
                sender_username = sender.get("username") or ""
                sender_email = sender.get("email")
                if (
                    sender.get("emailVerified") is True
                    and sender_email
                    and is_valid_email(str(sender_email))
                ):
                    reply_to = str(sender_email)

        if etype == MESSAGE_CREATED:
            link = f"{self._settings.web_origin.rstrip('/')}/app/inbox"
            body = (event.get("body") or "")[:PREVIEW_LEN]
            subject = f"{sender_username or 'A teammate'} sent you a message"
            text, html = render_new_message_email(
                sender_username=sender_username or "A teammate",
                body_preview=body,
                link=link,
            )
        else:  # TASK_ASSIGNED
            # Cap the title (lands in the Subject header) and keep the full
            # validated task description (up to task-svc's schema bound).
            title = (event.get("title", "") or "Untitled task")[:TITLE_LEN]
            raw_description = event.get("description", "")
            desc = raw_description[:TASK_DESCRIPTION_LEN] if isinstance(raw_description, str) else ""
            channel_name = (event.get("channelName") or "")[:TITLE_LEN] or None
            who = sender_username or "A teammate"
            subject = (
                f"BlissWork: New task assigned to {channel_name} — {title}"
                if channel_name
                else f"BlissWork: {who} assigned you a task — {title}"
            )
            text, html = render_new_task_email(
                sender_username=who,
                title=title,
                description=desc,
                link=f"{self._settings.web_origin.rstrip('/')}/app/tasks/allocated",
                channel_name=channel_name,
                assigned_at=_assignment_timestamp(event.get("occurredAt")),
            )
        # Let a send failure propagate — the caller (_handle) counts consecutive
        # failures and routes poison messages to the DLQ; transient failures
        # leave the offset uncommitted so Kafka redelivers.
        await self._mailer.send(
            to=to_addr, subject=subject, text_body=text, html_body=html, reply_to=reply_to,
        )
        _log.info(
            "relay_email_sent",
            recipient_ref=recipient_ref(to_addr),
            type=etype,
            recipient=recipient_id,
        )

    # ── two-phase dedup ──────────────────────────────────────────────────

    @asynccontextmanager
    async def _mark_inflight(self, event_id: str, recipient_key: str):
        """Mark (event_id, recipient_key) as actively being worked on by this
        process for the duration of the block, so _reaper_loop knows not to
        reclaim it out from under a send that is still retrying.
        """
        marker = (event_id, recipient_key)
        self._inflight.add(marker)
        try:
            yield
        finally:
            self._inflight.discard(marker)

    async def _claim(self, event_id: str, recipient_id: str) -> bool:
        assert self._db is not None
        async with self._db.acquire() as conn:
            try:
                # owner='relay' (explicit, matching the column's DEFAULT) is
                # what lets _reap_once's sweep touch only this consumer's own
                # rows — see migrations/0004_email_consumed_owner.sql. Never
                # EmailWorker's: an invite/reset/verify link has no in-app
                # fallback the way a relayed notification does, so the
                # reaper's "flip to sent without sending" tradeoff would
                # silently lose the email instead of just being redundant.
                ct = await conn.execute(
                    """
                    INSERT INTO email_consumed (event_id, recipient_id, state, owner)
                    VALUES ($1, $2, 'pending', 'relay')
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
        try:
            async with self._db.acquire() as conn:
                row = await conn.fetchrow(
                    """
                    SELECT 1 FROM email_consumed
                    WHERE event_id = $1 AND recipient_id = $2 AND state = 'sent'
                    """,
                    event_id, recipient_id,
                )
                return row is not None
        except Exception as exc:  # noqa: BLE001 - a DB hiccup must cost this
            # event (retry treats it as not-yet-sent, same as a fresh 'pending'
            # row), not the whole process. See _claim above for the same
            # pattern; this call used to be unguarded and could crash both
            # consumers via asyncio.gather in __main__.py.
            _log.error("relay_is_sent_failed", event_id=event_id, error=str(exc))
            return False

    async def _mark_sent(self, event_id: str, recipient_id: str) -> bool:
        """Flip the dedup row to 'sent'. Returns False (logged) on a DB error
        rather than raising — the email already went out at this point, so a
        crash here would take down the whole worker over bookkeeping, not
        over anything that could still be prevented.

        Retries a few times first: the crash window this can't close (the
        process dying between the send and this write) is unavoidable without
        a distributed transaction across SMTP and Postgres, but the far more
        likely real-world cause — a transient DB hiccup at that exact instant
        — is exactly what a short retry absorbs, which meaningfully narrows
        how often a redelivery can end up resending a message that already
        went out.
        """
        assert self._db is not None
        for attempt in range(3):
            try:
                async with self._db.acquire() as conn:
                    await conn.execute(
                        """
                        UPDATE email_consumed SET state = 'sent', sent_at = now()
                        WHERE event_id = $1 AND recipient_id = $2
                        """,
                        event_id, recipient_id,
                    )
                return True
            except Exception as exc:  # noqa: BLE001
                if attempt == 2:
                    _log.error("relay_mark_sent_failed", event_id=event_id, error=str(exc))
                    return False
                await asyncio.sleep(0.5 * (2**attempt))
        return False  # unreachable, satisfies type checkers

    async def _reaper_loop(self) -> None:
        """Every 30s, release 'pending' rows that have gone unabandoned long
        enough to no longer plausibly be real in-progress work — see
        _reap_once for the abandonment window itself and _mark_inflight for
        the same-process fast path that sits alongside it.

        Reaper-driven retries don't try to re-send the email themselves —
        that would require persisting the full event payload. Instead the
        reaper releases genuinely abandoned claims so Kafka can redeliver the
        event; a stale claim must never be changed to 'sent' without a
        successful send.
        """
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=30.0)
                return
            except asyncio.TimeoutError:
                pass
            if self._db is None:
                continue
            await self._reap_once()

    def _reap_after_seconds(self) -> float:
        """The abandonment window itself: a row is a reap candidate once
        consumed_at is at least this old. Must cover the longest SINGLE
        phase a legitimate claim can sit in between _touch_claim refreshes
        (see _REAP_SEND_BUDGET_SECONDS) — including the notification path's
        wait, which is bounded by offline_threshold_seconds and is only
        refreshed at its END, not its start. offline_threshold_seconds is
        operator-configurable (OFFLINE_THRESHOLD_SECONDS), so this is read
        from live settings rather than baked in as a constant: a deployment
        that raises it must not silently reopen the cross-replica reap race
        this exists to close.
        """
        return max(float(self._settings.offline_threshold_seconds), _REAP_SEND_BUDGET_SECONDS)

    async def _reap_once(self) -> None:
        """One sweep: reclaim rows past the abandonment window, skipping any
        this process is still actively retrying. Split out from _reaper_loop
        so the exclusion logic can be exercised directly in tests without
        waiting on the loop's real 30s timer.
        """
        assert self._db is not None
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=self._reap_after_seconds())
        try:
            async with self._db.acquire() as conn:
                # owner = 'relay': this sweep must never touch EmailWorker's
                # claim rows (invite/password-reset/email-verification) — see
                # _claim's comment and migrations/0004_email_consumed_owner.sql.
                candidates = await conn.fetch(
                    """
                    SELECT event_id, recipient_id FROM email_consumed
                    WHERE state = 'pending' AND owner = 'relay'
                          AND consumed_at < $1
                    """,
                    cutoff,
                )
                stale = [
                    (r["event_id"], r["recipient_id"]) for r in candidates
                    if (str(r["event_id"]), str(r["recipient_id"])) not in self._inflight
                ]
                if stale:
                    await conn.executemany(
                        """
                        DELETE FROM email_consumed
                        WHERE event_id = $1 AND recipient_id = $2 AND state = 'pending'
                              AND owner = 'relay'
                        """,
                        stale,
                    )
                    _log.info("relay_released_pending", count=len(stale))
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
                    # Sized against relay_max_concurrency, not against 4 (the
                    # single-message-at-a-time figure from before concurrent
                    # partitions existed): up to that many messages can each
                    # want a connection around the same instant for a claim or
                    # mark-sent query. Each acquire is held only for one short,
                    # indexed query — never for the SMTP/provider send in
                    # between — so this does not mean relay_max_concurrency
                    # connections are busy at once, only that a burst of that
                    # size does not queue behind a too-small pool.
                    max_size=max(4, self._settings.relay_max_concurrency // 2),
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
        await run_migrations(self._db)
