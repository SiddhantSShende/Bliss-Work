"""Mirrors a BlissWork-side mail read/delete action into the acting user's own
connected Outlook mailbox.

Shape mostly mirrors org_consumer.py (this service's only other Kafka reader):
single topic, no dead-letter, no dedup table, batched fetch with a commit after
the batch. One difference: org_consumer lets a handler failure propagate so the
whole batch is redelivered, which is fine for its low-volume org.deleted —
here, where every mail read/delete in the deployment rides this topic, a single
bad or permanently-failing event doing that would stall write-back for every
OTHER event in the batch behind it (a poison pill). So `_handle` below catches
and logs per-event instead: a skipped write-back just means Outlook's read/
delete state stays stale until the next state change or mail_sync_worker sweep
re-converges it, which is an acceptable, self-healing outcome for a
best-effort mirror — unlike org.deleted, which really does need the row purged.

messaging-svc emits mail.owner_state_changed on messaging.events.v1 (the same
topic every other messaging event rides — this consumer filters by type, the
same way org_consumer filters auth.events down to org.deleted alone) whenever
ONE owner's read or delete action happens on a mail. See events.go's
MailOwnerStateChanged docstring: OwnerUserID is the only mailbox this can ever
touch — there is no cross-recipient ambiguity because the lookup below is
scoped to that exact user's own connection.
"""
from __future__ import annotations

import asyncio
import contextlib
import json

from aiokafka import AIOKafkaConsumer
from sqlalchemy import text

from kafka_security import kafka_security_kwargs
from crypto import cryptor

from .config import settings
from .db import session, set_bypass_rls
from .logging_setup import log
from .providers import microsoft as ms

_TOPIC = "messaging.events.v1"
_GROUP_ID = "integrations-svc-mail-writeback"
_MAX_BATCH_SIZE = 200
_BATCH_LINGER_MS = 250


async def _write_back_one(org_id: str, mail_id: str, owner_user_id: str, *, is_read, hidden) -> None:
    async with session() as db:
        await set_bypass_rls(db)  # cross-org consumer, org comes from the event
        link = (
            await db.execute(
                text(
                    """
                    SELECT l.id, l.connection_id, l.graph_message_id, c.access_token_enc
                      FROM mail_sync_links l
                      JOIN integration_connections c ON c.id = l.connection_id
                     WHERE l.org_id = :org AND l.mail_id = :mail
                       AND c.owner_user_id = :owner AND c.provider = 'outlook'
                       AND c.status = 'connected'
                     ORDER BY l.last_synced_at DESC
                     LIMIT 1
                    """
                ),
                {"org": org_id, "mail": mail_id, "owner": owner_user_id},
            )
        ).one_or_none()
        if link is None:
            # Not an Outlook user, or this mail was never synced through their
            # connection (e.g. it originated before they connected). Nothing to
            # write back — not an error.
            return

        token = await cryptor().decrypt(
            db, org_id, bytes(link.access_token_enc) if link.access_token_enc else None
        )
        if not token:
            # refresh_worker hasn't caught up, or the connection was revoked
            # mid-flight. Not retried here — the NEXT state change (or
            # mail_sync_worker's own next sweep) will carry a fresh token.
            return

        try:
            if hidden:
                await ms.move_to_deleted(token, link.graph_message_id)
            elif is_read is not None:
                await ms.set_message_read(token, link.graph_message_id, is_read)
            else:
                return
        except ms.MicrosoftAuthError:
            # Stale ACCESS token, not a broken connection — re-arm expiry so
            # refresh_worker's next 60s sweep renews it, same pattern as
            # routes/internal.py's send path.
            await db.execute(
                text("UPDATE integration_connections SET token_expires_at = now() WHERE id = :id"),
                {"id": str(link.connection_id)},
            )
            await db.commit()
            return
        except ms.MicrosoftError as exc:
            # Includes the benign "already moved" 404 noted in move_to_deleted's
            # docstring — logged, not retried; both directions converge on their
            # own on the next delta walk or state change.
            log.info("mail_write_back_skipped", mail_id=mail_id, error=str(exc))
            return

        await db.execute(
            text(
                """
                UPDATE mail_sync_links
                   SET last_known_is_read = COALESCE(:is_read, last_known_is_read),
                       last_synced_at = now()
                 WHERE id = :id
                """
            ),
            {"id": str(link.id), "is_read": is_read},
        )
        await db.commit()


class MailWriteBackConsumer:
    """Consumes messaging.events.v1 and acts on mail.owner_state_changed alone."""

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
                    **kafka_security_kwargs(),
                    group_id=_GROUP_ID,
                    enable_auto_commit=False,
                    auto_offset_reset="latest",
                )
                await self._consumer.start()
                log.info("mail_write_back_consumer_started", topic=_TOPIC, group=_GROUP_ID)
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
                    await self._consumer.commit()
            except asyncio.CancelledError:
                return
            except Exception:  # noqa: BLE001 — a down/restarting broker must not kill the loop
                log.exception("mail_write_back_consumer_failed")
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
            return
        if not isinstance(event, dict) or event.get("type") != "mail.owner_state_changed":
            return
        org_id = event.get("orgId")
        mail_id = event.get("mailId")
        owner_user_id = event.get("ownerUserId")
        if not (org_id and mail_id and owner_user_id):
            log.warning("mail_write_back_event_missing_fields")
            return
        try:
            await _write_back_one(
                str(org_id),
                str(mail_id),
                str(owner_user_id),
                is_read=event.get("isRead"),
                hidden=event.get("hidden"),
            )
        except Exception:  # noqa: BLE001 — one bad event must not stall the batch
            log.exception("mail_write_back_failed", mail_id=mail_id)


consumer = MailWriteBackConsumer()
