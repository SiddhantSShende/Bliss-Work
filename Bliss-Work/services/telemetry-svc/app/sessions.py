"""Session lifecycle: open on the first beat, advance on each one, close on the
last — or, when nothing arrives, close it where it was last seen.

A session here is ONE CLIENT INSTANCE, not one socket and not one refresh-token
family. Five tabs of the same browser share one id (the client coordinates over
the existing BroadcastChannel), because "Alice was online" is one fact, not five.

Why heartbeats are the source of truth for online/offline, rather than the
gateway's presence:

  * ws-gateway's presence is ephemeral Redis, scoped to "is a socket open"
    rather than "is someone at the keyboard" — a laptop left open all night is
    present to the gateway and idle to anyone who cares. (It used to be worse:
    a startup sweep deleted every presence key while publishing nothing, so a
    gateway restart left everyone then-online recorded as online forever. The
    keys now expire on their own, but the semantics are still the wrong ones
    for this service.)
  * Redis pub/sub is at-most-once. A transition lost while this service is
    restarting is lost permanently, and the row it should have closed stays open.

With heartbeats authoritative the failure mode is bounded instead: if we miss the
goodbye, the sweeper still closes the session and the error is at most one
timeout window, not infinity.
"""
from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timezone

import uuid6
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from crypto import cryptor
from .db import session, set_bypass_rls
from .logging_setup import log

# Advisory-lock key for the session sweeper. An arbitrary constant; it only has
# to be stable across replicas and distinct from any other advisory lock this
# database takes. Postgres advisory locks share one keyspace per database, and
# telemetrydb is this service's alone, so a single literal is sufficient.
_SWEEP_LOCK = 0x7E1E_5E55

# Ordered longest-first so "Edge" is not reported as "Chrome" (its UA contains
# both) and "Chrome" is not reported as "Safari" (ditto). Deliberately coarse:
# the goal is a label an admin can read ("Chrome · Windows"), not a fingerprint.
_BROWSERS = (("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"),
             ("Chrome/", "Chrome"), ("Safari/", "Safari"))
_PLATFORMS = (("Windows", "Windows"), ("Macintosh", "macOS"), ("Mac OS X", "macOS"),
              ("Android", "Android"), ("iPhone", "iOS"), ("iPad", "iPadOS"),
              ("Linux", "Linux"))


def device_label(user_agent: str | None, source: str) -> str:
    """A short, non-identifying description of the client, e.g. "Chrome · Windows".

    This — not the raw user agent — is what the UI renders. The raw UA is a
    fingerprint and stays encrypted; this is two words from a fixed vocabulary.
    """
    if source == "desktop":
        base = "BlissWork Desktop"
    else:
        base = next((name for token, name in _BROWSERS if user_agent and token in user_agent), "Browser")
    platform = next((name for token, name in _PLATFORMS if user_agent and token in user_agent), None)
    return f"{base} · {platform}" if platform else base


def ip_prefix(ip: str | None) -> str | None:
    """Coarsen an address to a /24 (v4) or /48 (v6).

    Enough to notice "they signed in from somewhere new" without decrypting
    anything, and not enough to identify a household. The full address is stored
    encrypted alongside for the cases where an investigation genuinely needs it.
    """
    if not ip:
        return None
    if ":" in ip:
        parts = [p for p in ip.split(":") if p != ""][:3]
        return ":".join(parts) + "::/48" if parts else None
    octets = ip.split(".")
    if len(octets) != 4:
        return None
    return ".".join(octets[:3]) + ".0/24"


async def open_or_touch(
    db: AsyncSession,
    *,
    session_id: str | None,
    org_id: str,
    user_id: str,
    source: str,
    at: datetime,
    active_ms: int = 0,
    idle_ms: int = 0,
    user_agent: str | None = None,
    ip: str | None = None,
) -> str:
    """Advance an existing session, or open one. Returns the session id.

    The caller owns the transaction and has already set the org RLS context.
    """
    sid = session_id or str(uuid6.uuid7())
    updated = await db.execute(
        text(
            """
            UPDATE user_sessions
               SET last_seen_at = GREATEST(last_seen_at, :at),
                   active_ms    = active_ms + :active,
                   idle_ms      = idle_ms + :idle
             WHERE id = :id AND org_id = :org AND user_id = :uid AND ended_at IS NULL
            """
        ),
        {"id": sid, "org": org_id, "uid": user_id, "at": at, "active": active_ms, "idle": idle_ms},
    )
    if updated.rowcount:
        return sid

    # No OPEN row. Two different situations, and they must not be conflated:
    #
    #   * the very first beat of a new client        -> insert with this id
    #   * a client whose session the sweeper closed  -> the id is TAKEN by a
    #     closed row, so the insert conflicts and does nothing. Reusing the id
    #     would silently drop every further beat that client sends; reviving the
    #     closed row would erase the gap, which is the very fact the record
    #     exists to show. So it gets a NEW session, and the ack hands the id back
    #     for the client to adopt.
    c = cryptor()
    ip_enc = await c.encrypt(db, org_id, ip)
    ua_enc = await c.encrypt(db, org_id, user_agent)
    params = {
        "org": org_id, "uid": user_id, "source": source,
        "label": device_label(user_agent, source), "at": at,
        "active": active_ms, "idle": idle_ms, "prefix": ip_prefix(ip),
        "ip_enc": ip_enc, "ua_enc": ua_enc,
    }
    inserted = await db.execute(_INSERT_SESSION, {**params, "id": sid})
    if inserted.rowcount:
        return sid

    sid = str(uuid6.uuid7())
    await db.execute(_INSERT_SESSION, {**params, "id": sid})
    return sid


_INSERT_SESSION = text(
    """
    INSERT INTO user_sessions (
        id, org_id, user_id, source, device_label, started_at, last_seen_at,
        active_ms, idle_ms, ip_prefix, ip_enc, user_agent_enc)
    VALUES (:id, :org, :uid, :source, :label, :at, :at,
            :active, :idle, :prefix, :ip_enc, :ua_enc)
    ON CONFLICT (id) DO NOTHING
    """
)


async def close(
    db: AsyncSession, *, session_id: str, org_id: str, user_id: str, reason: str,
    at: datetime | None = None,
) -> None:
    await db.execute(
        text(
            """
            UPDATE user_sessions
               SET ended_at = COALESCE(:at, last_seen_at), end_reason = :reason
             WHERE id = :id AND org_id = :org AND user_id = :uid AND ended_at IS NULL
            """
        ),
        {"id": session_id, "org": org_id, "uid": user_id, "reason": reason, "at": at},
    )


class Sweeper:
    """Closes sessions nobody said goodbye for.

    This is what resolves a killed tab, a crashed browser and a closed laptop
    lid — none of which send anything on the way out. `ended_at` is backdated to
    `last_seen_at`, not set to the sweep time, because the honest answer to "when
    did they go offline" is the last moment we heard from them; recording the
    sweep time would silently credit every user with up to one extra timeout
    window of online time, every single day.
    """

    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    async def start(self) -> None:
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="session-sweeper")
        log.info("sweeper_started", interval_s=settings.sweeper_interval_seconds)

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
        log.info("sweeper_stopped")

    async def _run(self) -> None:
        while not self._stop.is_set():
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(
                    self._stop.wait(), timeout=settings.sweeper_interval_seconds
                )
            if self._stop.is_set():
                return
            try:
                await self.sweep_once()
            except Exception:  # noqa: BLE001 — a bad sweep must not kill the loop
                log.exception("sweep_failed")

    async def sweep_once(self) -> int:
        async with session() as db:
            # Spans every org by definition, so it runs under bypass.
            await set_bypass_rls(db)

            # One sweeper at a time across the whole deployment.
            #
            # This loop is started unconditionally by every process, so N
            # replicas means N full scans of the open-session set every minute,
            # all contending on the same rows. The sweep is idempotent, so it
            # was never incorrect — just N times the work for one time the
            # result, on the table the ingest path is also writing to.
            #
            # try_ rather than plain advisory lock: a replica that loses the
            # race should skip this tick and try again in a minute, not queue up
            # behind the winner and then redo work that is already done.
            #
            # XACT-scoped, not session-scoped. A session-level lock leaks across
            # a pooled connection's next use and, under PgBouncer in transaction
            # mode, would be acquired on one backend and released on another —
            # which is to say, never released.
            got = await db.scalar(text("SELECT pg_try_advisory_xact_lock(:k)"), {"k": _SWEEP_LOCK})
            if not got:
                await db.rollback()
                return 0

            result = await db.execute(
                text(
                    """
                    UPDATE user_sessions
                       SET ended_at = last_seen_at, end_reason = 'timeout'
                     WHERE ended_at IS NULL
                       AND last_seen_at < now() - make_interval(secs => :ttl)
                    """
                ),
                {"ttl": settings.session_timeout_seconds},
            )
            await db.commit()
        if result.rowcount:
            log.info("sessions_swept", count=result.rowcount)
        return result.rowcount or 0


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


sweeper = Sweeper()
