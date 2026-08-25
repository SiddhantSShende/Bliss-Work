"""OAuth token-refresh worker.

Periodically refreshes OAuth access tokens (Gmail / Outlook / Teams) before they
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
_OAUTH_PROVIDERS = ("gmail", "outlook", "teams")


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

        # 2) Process each in its own transaction (failure isolation).
        for conn_id, org_id, provider, rt_enc in due:
            await self._refresh_one(conn_id, org_id, provider, rt_enc)

    async def _refresh_one(self, conn_id: str, org_id: str, provider: str, rt_enc: bytes) -> None:
        async with session() as db:
            await set_bypass_rls(db)
            vendor = app_credentials.vendor_for(provider)
            creds = await app_credentials.load(db, org_id, vendor) if vendor else None
            cfg = oauth.config_for(provider, creds)
            if cfg is None:
                return  # client creds removed — nothing we can do
            try:
                refresh_token = await cryptor().decrypt(db, org_id, rt_enc)
                tokens = await oauth.refresh_access_token(cfg, refresh_token or "")
            except oauth.OAuthError as exc:
                # Terminal (revoked/invalid) — mark so the UI prompts a reconnect.
                await db.execute(
                    text(
                        "UPDATE integration_connections SET status='error', last_error=:e, "
                        "updated_at=now() WHERE id=:id"
                    ),
                    {"e": f"token refresh failed: {exc}"[:500], "id": conn_id},
                )
                await db.commit()
                log.warning("refresh_failed_terminal", connection_id=conn_id, provider=provider)
                return
            except Exception as exc:  # noqa: BLE001 — transient; retry next sweep
                log.warning("refresh_failed_transient", connection_id=conn_id, error=str(exc))
                return

            access_enc = await cryptor().encrypt(db, org_id, tokens.get("access_token", ""))
            new_refresh = tokens.get("refresh_token")
            new_refresh_enc = (
                await cryptor().encrypt(db, org_id, new_refresh) if new_refresh else None
            )
            expires_in = int(tokens.get("expires_in") or 0)
            await db.execute(
                text(
                    """
                    UPDATE integration_connections SET
                        access_token_enc  = :a,
                        refresh_token_enc = COALESCE(:rf, refresh_token_enc),
                        token_expires_at  = CASE WHEN :exp > 0
                            THEN now() + (:exp * interval '1 second') ELSE token_expires_at END,
                        status = 'connected',
                        last_error = NULL,
                        updated_at = now()
                     WHERE id = :id
                    """
                ),
                {"a": access_enc, "rf": new_refresh_enc, "exp": expires_in, "id": conn_id},
            )
            await db.commit()


worker = RefreshWorker()
