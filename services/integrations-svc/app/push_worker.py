"""Push subscription renewal + ingest reconciliation worker.

Gmail and Microsoft PUSH new mail/chat to us rather than us polling. This worker
exists because push alone is not sufficient:

  * SUBSCRIPTIONS EXPIRE. Gmail's watch lasts 7 days, Graph mail ~3 days, Graph
    CHAT ~60 minutes. A lapsed subscription stops delivering silently — no
    error, notifications simply cease — so renewal is mandatory, not an
    optimization.

  * BOTH VENDORS DROP NOTIFICATIONS. Delivery is best-effort at Google and
    Microsoft alike. Without a reconciliation sweep, one dropped notification
    means a permanently missed mention.

Shape follows refresh_worker.py: in-process on the FastAPI lifespan, each
connection in its OWN transaction so one bad connection cannot roll back or
poison the others, and an `except Exception: log.exception` guard around every
loop body so a single failure never kills the sweep.

CONCURRENCY. Connections are claimed with `FOR UPDATE SKIP LOCKED` and their
`next_ingest_at` pushed forward before the lock is released, so a second replica
— or a restart mid-sweep — cannot double-process one connection.

CURSOR SAFETY. The cursor advances in the SAME transaction as the inserts it
covers. A crash between fetching and committing therefore re-fetches the same
window next sweep, and the `(connection_id, external_id_bidx)` unique index
absorbs the duplicates. The alternative — advancing the cursor first — loses
messages permanently on a crash, silently.
"""
from __future__ import annotations

import asyncio
import json
import secrets
from datetime import datetime, timezone

from sqlalchemy import text

from .config import settings
from .crypto import cryptor
from .db import session, set_bypass_rls
from .ingest import ingest_one
from .logging_setup import log
from .providers import gmail, microsoft as ms
from .push_backoff import needs_renewal, next_attempt_at

_INTERVAL = 60.0  # seconds between sweeps
_BATCH = 25  # connections claimed per sweep
_PUSH_PROVIDERS = ("gmail", "outlook", "teams")

#: Bound the work one connection can do in a single sweep. A mailbox with a
#: large backlog would otherwise monopolize the worker and starve every other
#: connection; the remainder is picked up on the next pass.
_MAX_MESSAGES_PER_SWEEP = 100


class PushWorker:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="push-ingest-worker")
        log.info("push_worker_started")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except asyncio.TimeoutError:
                self._task.cancel()
        log.info("push_worker_stopped")

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await self._sweep()
            except Exception:  # noqa: BLE001 — keep the worker alive
                log.exception("push_worker_error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=_INTERVAL)
            except asyncio.TimeoutError:
                pass

    # ── claim ────────────────────────────────────────────────────────────────
    async def _claim_due(self) -> list[dict]:
        """Lease up to _BATCH due connections.

        The UPDATE pushes next_ingest_at forward inside the claiming
        transaction, so the lease is visible to other replicas the moment this
        commits. If we then crash, the connection simply becomes due again after
        the interval rather than being stuck.
        """
        async with session() as db:
            await set_bypass_rls(db)
            rows = (
                await db.execute(
                    text(
                        """
                        WITH due AS (
                            SELECT id
                              FROM integration_connections
                             WHERE status = 'connected'
                               AND provider = ANY(:providers)
                               AND next_ingest_at <= now()
                             ORDER BY next_ingest_at
                             LIMIT :limit
                             FOR UPDATE SKIP LOCKED
                        )
                        UPDATE integration_connections c
                           SET next_ingest_at = now() + interval '5 minutes'
                          FROM due
                         WHERE c.id = due.id
                        RETURNING c.id, c.org_id, c.owner_user_id, c.created_by, c.provider,
                                  c.access_token_enc, c.external_account_id_bidx,
                                  c.ingest_cursor_enc, c.push_subscription_enc,
                                  c.push_subscription_id, c.push_expires_at, c.ingest_failures
                        """
                    ),
                    {"providers": list(_PUSH_PROVIDERS), "limit": _BATCH},
                )
            ).all()
            await db.commit()
        return [dict(r._mapping) for r in rows]

    async def _sweep(self) -> None:
        for row in await self._claim_due():
            try:
                await self._process_one(row)
            except Exception:  # noqa: BLE001 — one bad connection must not
                # stop the sweep. _record_failure already ran inside
                # _process_one for expected errors; this catches the rest.
                log.exception("push_worker_connection_failed", connection_id=str(row["id"]))

    # ── per-connection ───────────────────────────────────────────────────────
    async def _process_one(self, row: dict) -> None:
        provider = row["provider"]
        org_id = str(row["org_id"])

        async with session() as db:
            await set_bypass_rls(db)
            token = await cryptor().decrypt(
                db, org_id, bytes(row["access_token_enc"]) if row["access_token_enc"] else None
            )
            if not token:
                # The refresh worker hasn't caught up. Not an error — come back
                # shortly rather than burning a failure count on it.
                await self._schedule(db, row["id"], failures=0)
                await db.commit()
                return

            cursor = await cryptor().decrypt(
                db, org_id, bytes(row["ingest_cursor_enc"]) if row["ingest_cursor_enc"] else None
            )
            sub = await self._subscription(db, org_id, row["push_subscription_enc"])

            try:
                if needs_renewal(row["push_expires_at"]):
                    sub = await self._arm_subscription(db, row, token, sub)

                if provider == "gmail":
                    await self._reconcile_gmail(db, row, token, cursor)
                else:
                    await self._reconcile_graph(db, row, token, cursor)

            except (gmail.GmailAuthError, ms.MicrosoftAuthError) as exc:
                # A stale ACCESS token is not a broken connection. Expire it so
                # the existing refresh_worker picks it up on its next 60s sweep;
                # only a failed REFRESH marks the connection 'error'.
                await db.execute(
                    text(
                        "UPDATE integration_connections "
                        "   SET token_expires_at = now(), ingest_error = :e "
                        " WHERE id = :id"
                    ),
                    {"id": row["id"], "e": str(exc)[:500]},
                )
                await self._schedule(db, row["id"], failures=0)
                await db.commit()
                return

            except (gmail.GmailRateLimited, ms.MicrosoftRateLimited) as exc:
                await self._schedule(
                    db,
                    row["id"],
                    failures=int(row["ingest_failures"] or 0) + 1,
                    retry_after=exc.retry_after,
                    error=str(exc),
                )
                await db.commit()
                return

            except Exception as exc:  # noqa: BLE001 — provider/network failure
                await self._schedule(
                    db,
                    row["id"],
                    failures=int(row["ingest_failures"] or 0) + 1,
                    error=str(exc),
                )
                await db.commit()
                log.warning(
                    "push_worker_ingest_failed",
                    connection_id=str(row["id"]),
                    provider=provider,
                    error=str(exc),
                )
                return

            # Success resets the failure count immediately, so a connection that
            # recovers returns to the normal cadence rather than serving out its
            # backoff penalty.
            await self._schedule(db, row["id"], failures=0)
            await db.commit()

    # ── subscriptions ────────────────────────────────────────────────────────
    async def _subscription(self, db, org_id: str, blob) -> dict:
        if not blob:
            return {}
        plain = await cryptor().decrypt(db, org_id, bytes(blob))
        try:
            return json.loads(plain or "{}")
        except (ValueError, TypeError):
            return {}

    async def _arm_subscription(self, db, row: dict, token: str, sub: dict) -> dict:
        """Create or renew the provider-side push subscription."""
        provider = row["provider"]
        org_id = str(row["org_id"])
        base = settings.public_base_url.rstrip("/")

        if provider == "gmail":
            topic = await self._pubsub_topic(db, org_id)
            if not topic:
                # No Pub/Sub topic configured for this org. Reconciliation still
                # runs on its own cadence, so mentions arrive — just minutes
                # late instead of seconds. Not an error worth failing on.
                return sub
            res = await gmail.watch(token, topic)
            # `expiration` is epoch MILLISECONDS, not seconds. Treating it as
            # seconds puts expiry in 1970 and re-arms the watch every sweep.
            expires = _epoch_ms_to_dt(res.get("expiration"))
            sub = {"historyId": str(res.get("historyId") or "")}
            await self._store_subscription(db, row["id"], org_id, sub, expires, sub_id=None)
            return sub

        # Graph (outlook / teams)
        client_state = sub.get("clientState") or secrets.token_urlsafe(32)
        sub_id = row["push_subscription_id"]
        minutes = (
            ms.MAIL_SUBSCRIPTION_MINUTES if provider == "outlook" else ms.CHAT_SUBSCRIPTION_MINUTES
        )
        notification_url = f"{base}/ext/microsoft/notifications"

        if sub_id:
            try:
                res = await ms.renew_subscription(token, sub_id, minutes=minutes)
            except ms.MicrosoftError:
                # Gone or unrenewable — fall through and create a fresh one
                # rather than leaving the connection without a subscription.
                res, sub_id = {}, None
        if not sub_id:
            resource = (
                "/me/mailFolders('inbox')/messages"
                if provider == "outlook"
                # Teams: per-chat subscriptions would need one per chat;
                # /me/chats/getAllMessages needs Protected API approval. Until
                # per-chat arming lands, reconciliation carries Teams.
                else ""
            )
            if not resource:
                return sub
            res = await ms.create_subscription(
                token,
                resource=resource,
                notification_url=notification_url,
                client_state=client_state,
                minutes=minutes,
            )
            sub_id = str(res.get("id") or "")

        sub = {"clientState": client_state}
        expires = _parse_graph_datetime(res.get("expirationDateTime"))
        await self._store_subscription(db, row["id"], org_id, sub, expires, sub_id=sub_id)
        return sub

    async def _pubsub_topic(self, db, org_id: str) -> str:
        row = (
            await db.execute(
                text(
                    "SELECT pubsub_topic FROM provider_app_credentials "
                    " WHERE org_id = :o AND vendor = 'google'"
                ),
                {"o": org_id},
            )
        ).one_or_none()
        return str(row.pubsub_topic) if row and row.pubsub_topic else ""

    async def _store_subscription(
        self, db, conn_id, org_id: str, sub: dict, expires: datetime | None, *, sub_id: str | None
    ) -> None:
        enc = await cryptor().encrypt(db, org_id, json.dumps(sub))
        await db.execute(
            text(
                """
                UPDATE integration_connections
                   SET push_subscription_enc = :s,
                       push_subscription_id  = COALESCE(:sid, push_subscription_id),
                       push_expires_at       = :exp
                 WHERE id = :id
                """
            ),
            {"id": conn_id, "s": enc, "sid": sub_id, "exp": expires},
        )

    # ── reconciliation ───────────────────────────────────────────────────────
    async def _reconcile_gmail(self, db, row: dict, token: str, cursor: str | None) -> None:
        """Ingest everything added since `cursor`, then advance it.

        With no cursor we take profile().historyId and store it WITHOUT
        ingesting: that means "everything from here on", so connecting a mailbox
        does not replay years of mail into the mention feed.
        """
        if not cursor:
            prof = await gmail.profile(token)
            await self._store_cursor(db, row["id"], str(row["org_id"]), str(prof.get("historyId") or ""))
            return

        try:
            page = await gmail.history_list(token, cursor)
        except gmail.GmailError as exc:
            # 404 = the history id is older than Google retains (~1 week).
            # Re-baseline instead of failing forever; the gap is unavoidable and
            # a connection that never ingests again is worse.
            if "404" not in str(exc):
                raise
            prof = await gmail.profile(token)
            await self._store_cursor(db, row["id"], str(row["org_id"]), str(prof.get("historyId") or ""))
            log.warning("gmail_history_expired_rebaselined", connection_id=str(row["id"]))
            return

        message_ids = gmail.message_ids_from_history(page)[:_MAX_MESSAGES_PER_SWEEP]
        conn = _ConnRow(row)
        for mid in message_ids:
            msg = await gmail.get_message(token, mid)
            headers = gmail.headers_of(msg)
            await ingest_one(
                db,
                conn,
                "gmail",
                raw=headers,
                external_id=mid,
                peer=headers.get("from", ""),
                body=headers.get("subject", ""),
                kind="email",
                connected_account=None,
            )

        # Same transaction as the inserts above — see the module docstring.
        new_cursor = str(page.get("historyId") or cursor)
        await self._store_cursor(db, row["id"], str(row["org_id"]), new_cursor)

    async def _reconcile_graph(self, db, row: dict, token: str, cursor: str | None) -> None:
        """Walk the delta for Outlook mail. Teams chat needs per-chat delta and
        is not wired here yet — see the module note on Protected API approval."""
        if row["provider"] != "outlook":
            return

        items, delta_link = await ms.walk_delta(token, cursor or ms.inbox_delta_url())
        conn = _ConnRow(row)
        for msg in items[:_MAX_MESSAGES_PER_SWEEP]:
            if msg.get("isDraft"):
                continue
            sender, _to, _cc = ms.addresses_of(msg)
            await ingest_one(
                db,
                conn,
                "outlook",
                raw=msg,
                external_id=str(msg.get("id") or ""),
                peer=sender,
                body=str(msg.get("subject") or ""),
                kind="email",
                connected_account=None,
            )

        # ONLY when the walk completed. A half-walked nextLink stored as the
        # cursor silently skips every message beyond it.
        if delta_link:
            await self._store_cursor(db, row["id"], str(row["org_id"]), delta_link)

    async def _store_cursor(self, db, conn_id, org_id: str, cursor: str) -> None:
        enc = await cryptor().encrypt(db, org_id, cursor)
        await db.execute(
            text("UPDATE integration_connections SET ingest_cursor_enc = :c WHERE id = :id"),
            {"id": conn_id, "c": enc},
        )

    # ── scheduling ───────────────────────────────────────────────────────────
    async def _schedule(
        self,
        db,
        conn_id,
        *,
        failures: int,
        retry_after: float | None = None,
        error: str | None = None,
    ) -> None:
        await db.execute(
            text(
                """
                UPDATE integration_connections
                   SET next_ingest_at  = :next,
                       ingest_failures = :f,
                       ingest_error    = :e
                 WHERE id = :id
                """
            ),
            {
                "id": conn_id,
                "next": next_attempt_at(failures, retry_after=retry_after),
                "f": failures,
                "e": (error or "")[:500] or None,
            },
        )


class _ConnRow:
    """Adapt a claimed dict row to the attribute access ingest_one expects."""

    def __init__(self, row: dict) -> None:
        self.id = row["id"]
        self.org_id = row["org_id"]
        self.owner_user_id = row["owner_user_id"]
        self.created_by = row["created_by"]
        self.external_account_id_bidx = row["external_account_id_bidx"]


def _epoch_ms_to_dt(value) -> datetime | None:
    """Gmail's watch `expiration` is epoch MILLISECONDS as a string.

    Reading it as seconds puts expiry in 1970, which makes needs_renewal() true
    forever and re-arms the watch on every single sweep.
    """
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def _parse_graph_datetime(value) -> datetime | None:
    """Graph returns ISO-8601 with a trailing Z, which fromisoformat rejects
    before Python 3.11 and still dislikes with 7-digit fractional seconds."""
    if not value:
        return None
    raw = str(value).replace("Z", "+00:00")
    # Graph emits 7 fractional digits; datetime accepts at most 6.
    if "." in raw:
        head, _, tail = raw.partition(".")
        digits = "".join(c for c in tail if c.isdigit())[:6]
        offset = tail[len(digits) :] if len(tail) > len(digits) else ""
        offset = offset.lstrip("0123456789")
        raw = f"{head}.{digits.ljust(6, '0')}{offset}"
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


worker = PushWorker()
