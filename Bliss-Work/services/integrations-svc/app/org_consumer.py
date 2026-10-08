"""Erase an organization's integration data when the workspace is deleted.

This service is otherwise producer-only — it publishes to its outbox and never
reads Kafka. It gets a consumer for exactly one event type because of what it
stores: OAuth refresh tokens for Gmail, Outlook, Teams and Slack. Those are
long-lived credentials against systems that are not ours, so "the workspace was
deleted" has to reach them.

Crypto-shred already neutralises the secrets themselves — the tokens are
encrypted under the org DEK, and auth-svc destroys that key before this event is
published, so from that moment they are unrecoverable ciphertext regardless of
whether this consumer ever runs. This handles the rest: the connection rows,
identities, activity history and the pending-OAuth state.

The reader is deliberately minimal. A single topic, a consumer group, no
dead-letter and no dedup table: unrelated or malformed events are skipped;
valid org.deleted events are idempotent, so a transient purge failure is
retried by leaving the fetched batch uncommitted.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import uuid

from aiokafka import AIOKafkaConsumer
from kafka_security import kafka_security_kwargs
from org_purge_tables import purge_org_tables

from .config import settings
from .db import session, set_bypass_rls
from .logging_setup import log

_TOPIC = "auth.events"
_GROUP_ID = "integrations-svc"

# ── Batch sizing ─────────────────────────────────────────────────────────────
#
# The smallest of the three batched consumers, and honestly the one with least
# to gain: auth.events is low-volume and this consumer acts on `org.deleted`
# alone. It is batched anyway because the old loop paid a SYNCHRONOUS offset
# commit per message to record that it had ignored one, and because three
# consumers that fetch the same way are easier to reason about than two that do
# and one that does not.
#
# The handler keeps its own session and commit; only the fetch and the
# acknowledgement are batched.
_MAX_BATCH_SIZE = 200
_BATCH_LINGER_MS = 250

# Ordered children-before-parents. provider_identities and provider_activity
# reference a connection; oauth_states is an in-flight record against one.
# connection_verifications is NOT here: 0009_drop_connection_verification.sql
# dropped that table, and nothing recreated it — a stale reference here made
# every purge_org() call raise (undefined table), rolling back the whole
# transaction and leaving org.deleted permanently unprocessed.
_TABLES = (
    "provider_activity",
    "provider_identities",
    "oauth_states",
    "integration_connections",
    "provider_app_credentials",
    "mail_send_attempts",
    "message_send_attempts",
    # Last: see services/telemetry-svc/app/org_purge.py.
    "org_keys",
)


async def purge_org(org_id: str) -> None:
    """Delete one org's integration rows. Idempotent."""
    await purge_org_tables(session, set_bypass_rls, log, org_id, _TABLES)


class OrgLifecycleConsumer:
    """Consumes auth.events and acts on org.deleted alone."""

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._consumer: AIOKafkaConsumer | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        if self._task is not None:
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stop.set()
        if self._consumer is not None:
            with contextlib.suppress(Exception):
                await self._consumer.stop()
        if self._task is not None:
            with contextlib.suppress(asyncio.CancelledError, asyncio.TimeoutError):
                await asyncio.wait_for(self._task, timeout=5.0)
            self._task = None

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self._consumer = AIOKafkaConsumer(
                    _TOPIC,
                    bootstrap_servers=settings.kafka_brokers,
                    # TLS/SASL when KAFKA_SECURITY_PROTOCOL asks for it; empty otherwise.
                    **kafka_security_kwargs(),
                    group_id=_GROUP_ID,
                    enable_auto_commit=False,
                    auto_offset_reset="latest",
                )
                await self._consumer.start()
                log.info("org_consumer_started", topic=_TOPIC, group=_GROUP_ID)
                while not self._stop.is_set():
                    batches = await self._consumer.getmany(
                        timeout_ms=_BATCH_LINGER_MS, max_records=_MAX_BATCH_SIZE
                    )
                    if not batches:
                        continue
                    stopped = False
                    for _tp, messages in batches.items():
                        for msg in messages:
                            if self._stop.is_set():
                                stopped = True
                                break
                            await self._handle(msg.value)
                        if stopped:
                            break
                    # Commit once per fetch, after handling. An uncommitted
                    # message redelivers, which is safe because the handler is
                    # idempotent — and that is also what makes batching safe
                    # here: a throw anywhere in the fetch skips this commit, so
                    # the whole batch is redelivered and re-purged harmlessly.
                    await self._consumer.commit()
            except asyncio.CancelledError:
                return
            except Exception:
                # A broker that is down or restarting must not kill the loop.
                log.exception("org_consumer_failed")
            finally:
                if self._consumer is not None:
                    with contextlib.suppress(Exception):
                        await self._consumer.stop()
                    self._consumer = None
            if not self._stop.is_set():
                await asyncio.sleep(5)

    async def _handle(self, raw: bytes | None) -> None:
        if not raw:
            return
        try:
            event = json.loads(raw)
        except (ValueError, TypeError):
            # Skipped rather than dead-lettered: this consumer reads one event
            # type off a topic full of others, so "cannot parse" is already the
            # common case and is never actionable here.
            return
        if not isinstance(event, dict) or event.get("type") != "org.deleted":
            return
        org_id = event.get("orgId")
        try:
            normalized_org_id = str(uuid.UUID(str(org_id)))
        except (ValueError, TypeError, AttributeError):
            log.error("org_purge_event_invalid_org_id")
            return
        await purge_org(normalized_org_id)


consumer = OrgLifecycleConsumer()
