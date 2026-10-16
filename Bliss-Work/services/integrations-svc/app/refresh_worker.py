"""OAuth token-refresh worker.

Periodically refreshes OAuth access tokens (Gmail / Teams) before they
expire, using the stored refresh token, so long-lived connections keep working
without user interaction. A definitive refresh failure (e.g. the user revoked
access → invalid_grant) flips the connection to `status='error'` with a
`last_error`, which the UI surfaces so they can reconnect.

Runs in-process on the FastAPI lifespan (same shape as the outbox poller). Each
due connection is processed in its OWN transaction so one failure can't poison or
roll back the others.
"""
from __future__ import annotations

import asyncio

from sqlalchemy import text

from . import app_credentials
from crypto import cryptor
from .db import session, set_bypass_rls
from .logging_setup import log
from .providers import oauth

_INTERVAL = 60.0  # seconds between sweeps
_WINDOW_MINUTES = 10  # refresh when the token expires within this window
_BATCH = 50
_CONCURRENCY = 5
# Phase C (storing refreshed tokens) is retried: see _refresh_one.
_PERSIST_ATTEMPTS = 3
_PERSIST_BACKOFF = 0.5  # seconds, doubled per retry
_OAUTH_PROVIDERS = ("gmail", "teams")


class RefreshWorker:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="oauth-refresh-worker")
        log.info("refresh_worker_started")

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except asyncio.TimeoutError:
                self._task.cancel()
        log.info("refresh_worker_stopped")

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await self._refresh_due()
            except Exception:  # noqa: BLE001 — keep the worker alive
                log.exception("refresh_worker_error")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=_INTERVAL)
            except asyncio.TimeoutError:
                pass

    async def _refresh_due(self) -> None:
        # 1) Read the due batch in one short transaction, buffering the values.
        async with session() as db:
            await set_bypass_rls(db)  # cross-org worker
            rows = (
                await db.execute(
                    text(
                        """
                        SELECT id, org_id, provider, refresh_token_enc
                          FROM integration_connections
                         WHERE status = 'connected'
                           AND provider = ANY(:providers)
                           AND refresh_token_enc IS NOT NULL
                           AND token_expires_at IS NOT NULL
                           AND token_expires_at < now() + make_interval(mins => :win)
                           AND (refresh_next_attempt_at IS NULL OR refresh_next_attempt_at <= now())
                         ORDER BY token_expires_at ASC
                         LIMIT :lim
                        """
                    ),
                    {"providers": list(_OAUTH_PROVIDERS), "win": _WINDOW_MINUTES, "lim": _BATCH},
                )
            ).all()

        due = [(str(r.id), str(r.org_id), r.provider, bytes(r.refresh_token_enc)) for r in rows]
        if not due:
            return
        log.info("refresh_worker_due", count=len(due))

        # 2) Process each in its own transaction with a bounded number of
        # provider requests in flight. A failing row is deferred independently.
        semaphore = asyncio.Semaphore(_CONCURRENCY)

        async def refresh_one(row: tuple[str, str, str, bytes]) -> None:
            conn_id, org_id, provider, rt_enc = row
            async with semaphore:
                try:
                    await self._refresh_one(conn_id, org_id, provider, rt_enc)
                except Exception:  # noqa: BLE001 — one connection must not block the batch
                    log.exception("refresh_one_unexpected_error", connection_id=conn_id)
                    try:
                        await self._schedule_retry(conn_id)
                    except Exception:  # noqa: BLE001 — keep processing other rows
                        log.exception("refresh_retry_schedule_failed", connection_id=conn_id)

        await asyncio.gather(*(refresh_one(row) for row in due))

    async def _schedule_retry(self, conn_id: str) -> None:
        async with session() as db:
            await set_bypass_rls(db)
            await db.execute(
                text(
                    """
                    UPDATE integration_connections
                       SET refresh_failure_count = refresh_failure_count + 1,
                           refresh_next_attempt_at = now() + make_interval(
                               secs => LEAST(
                                   3600.0, 30.0 * power(2.0, LEAST(refresh_failure_count, 7))
                               )::double precision
                           ),
                           refresh_claimed_at = NULL,
                           updated_at = now()
                     WHERE id = :id AND status = 'connected'
                    """
                ),
                {"id": conn_id},
            )
            await db.commit()

    async def _refresh_one(self, conn_id: str, org_id: str, provider: str, rt_enc: bytes) -> None:
        # Phase A — claim the row and gather what the refresh call needs, in
        # one short transaction committed BEFORE any network call. Used to be
        # a single transaction holding `FOR UPDATE SKIP LOCKED` open across
        # oauth.refresh_access_token itself; a slow/unresponsive IdP then held
        # both a row lock and a pooled connection (10 total for this service)
        # for as long as the call took. The claim below still stops two
        # replicas from both calling the provider for the same connection —
        # see the UPDATE's own comment — it just no longer needs the lock to
        # stay open past this transaction's commit to do it.
        async with session() as db:
            await set_bypass_rls(db)

            # Claim this row before doing anything else. _refresh_due's own
            # SELECT (no lock) lets both of this service's 2 replicas see the
            # same connection as due in the same sweep — especially right
            # after a coordinated restart, when both workers' timers start
            # together. Without this, both call the provider's refresh
            # endpoint concurrently; Microsoft rotates the refresh token on
            # use, so whichever call lands second gets invalid_grant and
            # wrongly marks a healthy connection as errored.
            #
            # An UPDATE ... WHERE (refresh_claimed_at IS NULL OR ... stale)
            # does the same job FOR UPDATE SKIP LOCKED used to: two concurrent
            # UPDATEs on the same row serialize at the row-lock level exactly
            # as they always have, but that lock only lives for THIS
            # statement's duration, not for the network call after it. The
            # second UPDATE to run — whether it arrives after the first
            # commits, or blocks and resumes once the first commits — always
            # re-evaluates its WHERE against the now-committed
            # refresh_claimed_at and correctly matches zero rows, the same
            # "loses the race, backs off cleanly" outcome SKIP LOCKED gave.
            # The 2-minute staleness clause is only a backstop for a replica
            # that crashes between claiming and recording an outcome — every
            # normal exit path below clears refresh_claimed_at explicitly.

            claimed = (
                await db.execute(
                    text(
                        """
                        UPDATE integration_connections
                           SET refresh_claimed_at = now()
                         WHERE id = :id
                           AND status = 'connected'
                           AND refresh_token_enc IS NOT NULL
                           AND (refresh_next_attempt_at IS NULL OR refresh_next_attempt_at <= now())
                           AND (refresh_claimed_at IS NULL
                                OR refresh_claimed_at < now() - interval '2 minutes')
                        RETURNING refresh_token_enc, oauth_app_credential_id
                        """
                    ),
                    {"id": conn_id},
                )
            ).first()
            if claimed is None:
                log.info("refresh_skipped_locked_or_changed", connection_id=conn_id)
                return
            # Re-reads refresh_token_enc fresh rather than trusting the
            # `rt_enc` this was called with: that value is from _refresh_due's
            # batch SELECT, which could already be stale by the time this
            # claim succeeds (e.g. this exact connection was already refreshed
            # and committed by the other replica a moment earlier — in which
            # case the claim above would not have matched at all, but the
            # possibility is exactly why the batch SELECT's own value is never
            # trusted here).
            rt_enc = bytes(claimed.refresh_token_enc)

            vendor = app_credentials.vendor_for(provider)
            credential_id = claimed.oauth_app_credential_id
            if credential_id is not None:
                creds = await app_credentials.load_by_id(db, org_id, str(credential_id))
            else:
                creds = await app_credentials.load(db, org_id, vendor) if vendor else None
            cfg = oauth.config_for(provider, creds)
            if cfg is None:
                # OAuth app credentials are unavailable and no server
                # environment fallback is configured. Surface this instead of
                # leaving the connection marked connected while sends fail.
                await db.execute(
                    text(
                        "UPDATE integration_connections SET status='error', "
                        "refresh_failure_count=0, "
                        "last_error=:e, refresh_claimed_at=NULL, refresh_next_attempt_at=NULL, "
                        "updated_at=now() WHERE id=:id"
                    ),
                    {
                        "e": "OAuth app credentials are no longer configured for this provider",
                        "id": conn_id,
                    },
                )
                await db.commit()
                log.warning(
                    "refresh_skipped_no_app_credentials", connection_id=conn_id, provider=provider
                )
                return
            refresh_token = await cryptor().decrypt(db, org_id, rt_enc)
            await db.commit()  # claim recorded; connection released before Phase B

        # Phase B — the external call, deliberately outside any DB
        # transaction or held connection.
        try:
            tokens = await oauth.refresh_access_token(cfg, refresh_token or "")
        except oauth.OAuthError as exc:
            # Terminal (revoked/invalid) — mark so the UI prompts a reconnect.
            async with session() as db:
                await set_bypass_rls(db)
                # Guarded like Phase C below: a connection the user disconnected
                # (status 'revoked') or reconnected (new refresh token) while
                # this call was in flight must not be flipped to 'error' by the
                # outcome of the OLD credentials.
                await db.execute(
                    text(
                        "UPDATE integration_connections SET status='error', "
                        "refresh_failure_count=0, last_error=:e, "
                        "refresh_claimed_at=NULL, refresh_next_attempt_at=NULL, "
                        "updated_at=now() "
                        "WHERE id=:id AND status='connected' AND refresh_token_enc = :rt"
                    ),
                    {"e": f"token refresh failed: {exc}"[:500], "id": conn_id, "rt": rt_enc},
                )
                await db.commit()
            log.warning("refresh_failed_terminal", connection_id=conn_id, provider=provider)
            return
        except Exception as exc:  # noqa: BLE001 — transient; retry next sweep
            await self._schedule_retry(conn_id)
            log.warning("refresh_failed_transient", connection_id=conn_id, error=str(exc))
            return

        # Phase C — record the refreshed tokens, in a fresh short transaction.
        #
        # By now the provider may already have ROTATED the refresh token
        # (Microsoft does, on every use): if this write is lost, the only valid
        # token is gone and the next sweep's retry gets invalid_grant. So a
        # transient DB failure here is retried a few times before giving up.
        # refresh_claimed_at stays set on failure (it is cleared by the same
        # UPDATE that stores the tokens), so no other replica races in.
        for attempt in range(_PERSIST_ATTEMPTS):
            try:
                await self._persist_tokens(conn_id, org_id, provider, rt_enc, tokens)
                return
            except Exception:  # noqa: BLE001 — retried, then surfaced below
                if attempt == _PERSIST_ATTEMPTS - 1:
                    log.error(
                        "refresh_persist_failed",
                        connection_id=conn_id,
                        provider=provider,
                        detail="refreshed tokens could not be stored; a rotated "
                        "refresh token is lost and the connection will need a reconnect",
                    )
                    raise
                await asyncio.sleep(_PERSIST_BACKOFF * (2**attempt))

    async def _persist_tokens(
        self, conn_id: str, org_id: str, provider: str, rt_enc: bytes, tokens: dict
    ) -> None:
        async with session() as db:
            await set_bypass_rls(db)
            access_enc = await cryptor().encrypt(db, org_id, tokens.get("access_token", ""))
            new_refresh = tokens.get("refresh_token")
            new_refresh_enc = (
                await cryptor().encrypt(db, org_id, new_refresh) if new_refresh else None
            )
            expires_in = int(tokens.get("expires_in") or 0)
            # `status = 'connected' AND refresh_token_enc = :rt`: the row must
            # still be the connection this refresh started from. Phase B ran
            # outside any transaction, so the user may have disconnected it
            # meanwhile (status 'revoked', tokens NULLed) — an unguarded UPDATE
            # here set it back to 'connected' with fresh tokens, resurrecting a
            # connection the user explicitly removed — or reconnected it, in
            # which case these tokens derive from the OLD grant and must not
            # overwrite the new ones. The claim row's refresh_token_enc is
            # the identity of the credential generation (ciphertext is rewritten
            # only by a reconnect or by this very UPDATE).
            res = await db.execute(
                text(
                    """
                    UPDATE integration_connections SET
                        access_token_enc  = :a,
                        refresh_token_enc = COALESCE(:rf, refresh_token_enc),
                        token_expires_at  = CASE WHEN :exp > 0
                            THEN now() + (:exp * interval '1 second') ELSE token_expires_at END,
                        status = 'connected',
                        last_error = NULL,
                        refresh_failure_count = 0,
                        refresh_next_attempt_at = NULL,
                        refresh_claimed_at = NULL,
                        updated_at = now()
                     WHERE id = :id
                       AND status = 'connected'
                       AND refresh_token_enc = :rt
                    """
                ),
                {
                    "a": access_enc,
                    "rf": new_refresh_enc,
                    "exp": expires_in,
                    "id": conn_id,
                    "rt": rt_enc,
                },
            )
            await db.commit()
            if res.rowcount == 0:
                log.info(
                    "refresh_result_discarded_connection_changed",
                    connection_id=conn_id,
                    provider=provider,
                )


worker = RefreshWorker()
