"""Outlook mail-sync worker — inbound delta walk + push-subscription renewal.

Shape mirrors refresh_worker.py (claim via an UPDATE...RETURNING, own
transaction per connection, bounded concurrency) and the deleted
push_worker.py this is a narrower, mail-only descendant of — see
`git show 7add122^:...app/push_worker.py` for the original, which also
covered Gmail/Teams mentions. This file does ONE thing: keep a connected
Outlook mailbox's INBOX and SENT ITEMS folders mirrored into messaging-svc's
mail_messages, in both directions for read/delete state.

── Why two folders, not one ──────────────────────────────────────────────────
The old code only walked Inbox, because it only needed to detect @-mentions.
Full mail sync needs Sent Items too — both for mail sent directly in Outlook
(a reply typed straight into the Outlook client, never touching BlissWork),
and to dedup mail BlissWork itself sent (see providers/microsoft.py's module
docstring: the send path backfills `external_message_id` precisely so this
walk's dedup is a no-op for those). ONE cursor column holds both folders'
deltaLinks as a small JSON object — not a schema change, since
0006_push_ingest.sql's `ingest_cursor_enc` was always "whatever a provider's
own ingest_cursor shape happens to be," encrypted.

── Push subscription scope ───────────────────────────────────────────────────
Only INBOX gets a Graph change-notification subscription. A subscription is
resource-scoped, and Sent Items has no equivalent push signal here — this is a
deliberate scope cut, not an oversight: new mail ARRIVING is the latency that
matters to a user staring at their inbox, and Sent Items still gets walked
every sweep regardless of whether a push fired. Doubling subscription/renewal
bookkeeping for a reply typed into Outlook — which is noticed within one
sweep interval either way — was not worth it.

── Removal (`@removed`) handling ─────────────────────────────────────────────
A delta `@removed` entry means Graph no longer has this message at its old
location in the walked folder (deleted, or moved elsewhere). mail_sync_links
is the only way back to a local mail_id from a bare Graph id at that point —
once removed, nothing else in Graph's response names it.
"""
from __future__ import annotations

import asyncio
import json
import secrets
from datetime import datetime, timezone

import uuid6
from sqlalchemy import text

from . import messaging_client
from .config import settings
from crypto import cryptor
from .db import session, set_bypass_rls
from .logging_setup import log
from .providers import microsoft as ms

_INTERVAL = 60.0  # seconds between sweeps
_BATCH = 25  # connections claimed per sweep
_CONCURRENCY = 5
_LEASE_MINUTES = 5

#: Bound the work one connection can do in a single sweep, per folder. A
#: mailbox with a large backlog is picked up incrementally over several
#: sweeps rather than monopolizing the worker.
_MAX_ITEMS_PER_FOLDER = 100
_MAX_DELTA_PAGES = 20

#: (folder name, its starting-delta-URL builder), walked in this order.
_FOLDERS = (
    ("inbox", ms.inbox_delta_url),
    ("sentitems", ms.sentitems_delta_url),
)


class MailSyncWorker:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="mail-sync-worker")
        log.info("mail_sync_worker_started")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except asyncio.TimeoutError:
                self._task.cancel()
        log.info("mail_sync_worker_stopped")

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await self._sweep()
            except Exception:  # noqa: BLE001 — keep the worker alive
                log.exception("mail_sync_worker_error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=_INTERVAL)
            except asyncio.TimeoutError:
                pass

    # ── claim ────────────────────────────────────────────────────────────────
    async def _claim_due(self) -> list[dict]:
        async with session() as db:
            await set_bypass_rls(db)  # cross-org worker
            rows = (
                await db.execute(
                    text(
                        """
                        WITH due AS (
                            SELECT id FROM integration_connections
                             WHERE status = 'connected' AND provider = 'outlook'
                               AND next_ingest_at <= now()
                             ORDER BY next_ingest_at
                             LIMIT :lim
                             FOR UPDATE SKIP LOCKED
                        )
                        UPDATE integration_connections c
                           SET next_ingest_at = now() + make_interval(mins => :lease)
                          FROM due
                         WHERE c.id = due.id
                        RETURNING c.id, c.org_id, c.owner_user_id, c.access_token_enc,
                                  c.ingest_cursor_enc, c.push_subscription_enc,
                                  c.push_subscription_id, c.push_expires_at, c.ingest_failures
                        """
                    ),
                    {"lim": _BATCH, "lease": _LEASE_MINUTES},
                )
            ).all()
            await db.commit()
        return [dict(r._mapping) for r in rows]

    async def _sweep(self) -> None:
        rows = await self._claim_due()
        if not rows:
            return
        log.info("mail_sync_worker_due", count=len(rows))
        semaphore = asyncio.Semaphore(_CONCURRENCY)

        async def process(row: dict) -> None:
            async with semaphore:
                try:
                    await self._process_one(row)
                except ms.MicrosoftAuthError as exc:
                    # A stale ACCESS token, not a broken connection — re-arm
                    # expiry so refresh_worker's next 60s sweep renews it,
                    # same pattern as routes/internal.py's send path. Not a
                    # failure count: this resolves itself without this
                    # connection ever needing a reconnect.
                    await self._expire_token(str(row["id"]))
                    log.info("mail_sync_token_expired", connection_id=str(row["id"]), error=str(exc))
                except Exception as exc:  # noqa: BLE001 — one connection must not block the batch
                    log.exception("mail_sync_connection_failed", connection_id=str(row["id"]))
                    retry_after = getattr(exc, "retry_after", None)
                    await self._schedule_retry(
                        str(row["id"]), int(row["ingest_failures"] or 0) + 1, retry_after, str(exc)
                    )

        await asyncio.gather(*(process(row) for row in rows))

    async def _expire_token(self, conn_id: str) -> None:
        async with session() as db:
            await set_bypass_rls(db)
            await db.execute(
                text(
                    "UPDATE integration_connections SET token_expires_at = now() "
                    "WHERE id = :id AND status = 'connected'"
                ),
                {"id": conn_id},
            )
            await db.commit()

    async def _schedule_retry(
        self, conn_id: str, failures: int, retry_after: float | None, error: str
    ) -> None:
        delay = retry_after if retry_after and retry_after > 0 else min(3600.0, 30.0 * (2 ** min(failures, 7)))
        async with session() as db:
            await set_bypass_rls(db)
            await db.execute(
                text(
                    """
                    UPDATE integration_connections
                       SET ingest_failures = :f, ingest_error = :e,
                           next_ingest_at = now() + make_interval(secs => :delay)
                     WHERE id = :id AND status = 'connected'
                    """
                ),
                {"id": conn_id, "f": failures, "e": error[:500], "delay": delay},
            )
            await db.commit()

    # ── per-connection ───────────────────────────────────────────────────────
    async def _process_one(self, row: dict) -> None:
        conn_id, org_id, owner_id = str(row["id"]), str(row["org_id"]), str(row["owner_user_id"])

        # Phase A — decrypt what this sweep needs, release the connection
        # before any Graph call.
        async with session() as db:
            await set_bypass_rls(db)
            token = await cryptor().decrypt(
                db, org_id, bytes(row["access_token_enc"]) if row["access_token_enc"] else None
            )
            cursor_raw = await cryptor().decrypt(
                db, org_id, bytes(row["ingest_cursor_enc"]) if row["ingest_cursor_enc"] else None
            )
            sub_raw = await cryptor().decrypt(
                db, org_id, bytes(row["push_subscription_enc"]) if row["push_subscription_enc"] else None
            )
        if not token:
            # refresh_worker hasn't caught up (or the connection was just
            # revoked). Not a failure — the claim already advanced
            # next_ingest_at, so this comes back around on its own.
            return

        try:
            cursor: dict = json.loads(cursor_raw) if cursor_raw else {}
        except (ValueError, TypeError):
            cursor = {}
        try:
            sub: dict = json.loads(sub_raw) if sub_raw else {}
        except (ValueError, TypeError):
            sub = {}

        # Phase B — network + per-item work. Nothing here holds a DB session
        # open across a Graph call; each item gets its own short transaction.
        sub = await self._renew_subscription_if_needed(row, token, sub)
        new_cursor = dict(cursor)
        for folder, delta_url in _FOLDERS:
            start_url = cursor.get(folder) or delta_url()
            items, delta_link = await ms.walk_delta(token, start_url, max_pages=_MAX_DELTA_PAGES)
            for item in items[:_MAX_ITEMS_PER_FOLDER]:
                await self._handle_item(conn_id, org_id, owner_id, token, folder, item)
            # Only advance THIS folder's cursor if the walk actually reached
            # the deltaLink — see walk_delta's own docstring on why a
            # half-walked nextLink must never be persisted.
            if delta_link:
                new_cursor[folder] = delta_link

        # Phase C — persist the advanced cursor + subscription state + reset
        # the failure count, in one short transaction.
        async with session() as db:
            await set_bypass_rls(db)
            cursor_enc = await cryptor().encrypt(db, org_id, json.dumps(new_cursor))
            sub_enc = await cryptor().encrypt(db, org_id, json.dumps(sub)) if sub else None
            await db.execute(
                text(
                    """
                    UPDATE integration_connections
                       SET ingest_cursor_enc = :cursor,
                           push_subscription_enc = COALESCE(:sub, push_subscription_enc),
                           ingest_failures = 0, ingest_error = NULL,
                           updated_at = now()
                     WHERE id = :id
                    """
                ),
                {"id": conn_id, "cursor": cursor_enc, "sub": sub_enc},
            )
            await db.commit()

    # ── subscription ─────────────────────────────────────────────────────────
    async def _renew_subscription_if_needed(self, row: dict, token: str, sub: dict) -> dict:
        expires_at = row.get("push_expires_at")
        due = expires_at is None or _minutes_until(expires_at) <= ms.RENEW_MARGIN_MINUTES
        if not due:
            return sub

        sub_id = row.get("push_subscription_id")
        notification_url = f"{settings.public_base_url.rstrip('/')}/ext/outlook/notifications"
        if sub_id:
            try:
                res = await ms.renew_subscription(token, sub_id, minutes=ms.MAIL_SUBSCRIPTION_MINUTES)
                await self._store_subscription_id(row, sub_id, res.get("expirationDateTime"))
                return sub
            except ms.MicrosoftError:
                # Gone or unrenewable — fall through and create a fresh one
                # rather than leaving the connection with none at all.
                pass

        client_state = sub.get("clientState") or secrets.token_urlsafe(32)
        res = await ms.create_subscription(
            token,
            resource="/me/mailFolders('inbox')/messages",
            notification_url=notification_url,
            client_state=client_state,
            minutes=ms.MAIL_SUBSCRIPTION_MINUTES,
        )
        new_sub_id = str(res.get("id") or "")
        await self._store_subscription_id(row, new_sub_id, res.get("expirationDateTime"))
        return {"clientState": client_state}

    async def _store_subscription_id(self, row: dict, sub_id: str, expires_iso: str | None) -> None:
        async with session() as db:
            await set_bypass_rls(db)
            await db.execute(
                text(
                    """
                    UPDATE integration_connections
                       SET push_subscription_id = :sid, push_expires_at = :exp
                     WHERE id = :id
                    """
                ),
                {"id": str(row["id"]), "sid": sub_id, "exp": _parse_graph_datetime(expires_iso)},
            )
            await db.commit()

    # ── per-item ─────────────────────────────────────────────────────────────
    async def _handle_item(
        self, conn_id: str, org_id: str, owner_id: str, token: str, folder: str, item: dict
    ) -> None:
        graph_id = str(item.get("id") or "")
        if not graph_id:
            return

        if item.get("@removed"):
            mail_id = await self._mail_id_for_graph_message(conn_id, graph_id)
            if mail_id:
                await messaging_client.hide_for_owner(org_id, mail_id, owner_id)
                await self._delete_sync_link(conn_id, graph_id)
            return

        existing = await self._sync_link_for_graph_message(conn_id, graph_id)
        is_read = item.get("isRead")
        if existing is not None:
            # An UPDATE to a message we already know (e.g. isRead flipped
            # directly in Outlook) — mirror it inbound if it actually changed.
            if is_read is not None and existing["last_known_is_read"] != is_read:
                ok = await messaging_client.mark_read_for_owner(
                    org_id, existing["mail_id"], owner_id, bool(is_read)
                )
                if ok:
                    await self._touch_sync_link(existing["id"], is_read=is_read)
            else:
                await self._touch_sync_link(existing["id"], is_read=existing["last_known_is_read"])
            return

        # A genuinely new item — fetch the body and deliver it.
        full = await ms.get_message(token, graph_id, as_text=True)
        sender, to, cc = ms.addresses_of(full)
        if not sender:
            return
        from_name = str(((full.get("from") or {}).get("emailAddress") or {}).get("name") or "")
        sent_at = full.get("receivedDateTime") or full.get("sentDateTime") or ""
        payload = {
            "orgId": org_id,
            "externalMessageId": str(full.get("internetMessageId") or item.get("internetMessageId") or ""),
            "fromAddress": sender,
            "fromName": from_name,
            "subject": str(full.get("subject") or ""),
            "bodyText": str((full.get("body") or {}).get("content") or full.get("bodyPreview") or ""),
            "bodyHtml": "",
            "to": to,
            "cc": cc,
            "sentAt": sent_at,
        }
        if not payload["externalMessageId"]:
            return
        result = await messaging_client.deliver_inbound_mail(payload)
        if result is None:
            return
        mail_id = result.get("mailId")
        if not mail_id:
            return
        await self._upsert_sync_link(conn_id, org_id, mail_id, graph_id, folder, bool(is_read))

    # ── mail_sync_links ──────────────────────────────────────────────────────
    async def _sync_link_for_graph_message(self, conn_id: str, graph_id: str) -> dict | None:
        async with session() as db:
            await set_bypass_rls(db)
            row = (
                await db.execute(
                    text(
                        """
                        SELECT id, mail_id, last_known_is_read FROM mail_sync_links
                         WHERE connection_id = :c AND graph_message_id = :g
                        """
                    ),
                    {"c": conn_id, "g": graph_id},
                )
            ).one_or_none()
            return dict(row._mapping) if row is not None else None

    async def _mail_id_for_graph_message(self, conn_id: str, graph_id: str) -> str | None:
        link = await self._sync_link_for_graph_message(conn_id, graph_id)
        return str(link["mail_id"]) if link else None

    async def _touch_sync_link(self, link_id, *, is_read) -> None:
        async with session() as db:
            await set_bypass_rls(db)
            await db.execute(
                text(
                    "UPDATE mail_sync_links SET last_known_is_read = :r, last_synced_at = now() "
                    "WHERE id = :id"
                ),
                {"id": link_id, "r": is_read},
            )
            await db.commit()

    async def _delete_sync_link(self, conn_id: str, graph_id: str) -> None:
        async with session() as db:
            await set_bypass_rls(db)
            await db.execute(
                text(
                    "DELETE FROM mail_sync_links WHERE connection_id = :c AND graph_message_id = :g"
                ),
                {"c": conn_id, "g": graph_id},
            )
            await db.commit()

    async def _upsert_sync_link(
        self, conn_id: str, org_id: str, mail_id: str, graph_id: str, folder: str, is_read: bool
    ) -> None:
        async with session() as db:
            await set_bypass_rls(db)
            await db.execute(
                text(
                    """
                    INSERT INTO mail_sync_links
                        (id, connection_id, org_id, mail_id, graph_message_id, folder, last_known_is_read)
                    VALUES (:id, :conn, :org, :mail, :graph, :folder, :r)
                    ON CONFLICT (connection_id, graph_message_id) DO UPDATE
                        SET last_known_is_read = EXCLUDED.last_known_is_read, last_synced_at = now()
                    """
                ),
                {
                    "id": str(uuid6.uuid7()),
                    "conn": conn_id,
                    "org": org_id,
                    "mail": mail_id,
                    "graph": graph_id,
                    "folder": folder,
                    "r": is_read,
                },
            )
            await db.commit()


def _minutes_until(dt: datetime) -> float:
    now = datetime.now(timezone.utc)
    target = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return (target - now).total_seconds() / 60.0


def _parse_graph_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


worker = MailSyncWorker()
