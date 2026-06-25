"""Async Redis client for the offline-relay presence gate.

Online check: `SCARD presence:user:<userId>` — the existing ws-gateway
maintains this set, adding a member on every connect and removing on
disconnect. Empty set ⇒ user has no live WS anywhere ⇒ they're offline and
need an email notification.

Why not a dedicated presence:lastseen:* key? It would double Redis writes on
every heartbeat (~50M/s at full scale) for negligible win — the SCARD lookup
is already O(1).
"""
from __future__ import annotations

import structlog
from redis.asyncio import Redis

_log = structlog.get_logger("presence")


class Presence:
    """Thin wrapper around an asyncio Redis client for online checks."""

    def __init__(self, url: str) -> None:
        self._redis: Redis = Redis.from_url(url, decode_responses=True)

    async def is_online(self, user_id: str) -> bool:
        """Return True iff the user has at least one live WS connection."""
        try:
            n = await self._redis.scard(f"presence:user:{user_id}")
            return int(n) > 0
        except Exception as exc:  # noqa: BLE001 - explicit log + fail-closed
            # Fail OPEN — when we can't tell, assume the user is online and
            # skip the email rather than spamming them. This is safer than
            # the alternative; lost notifications are rare and recoverable
            # (the in-app inbox always has the message).
            _log.warning("presence_check_failed", user_id=user_id, error=str(exc))
            return True

    async def aclose(self) -> None:
        try:
            await self._redis.aclose()
        except Exception:  # noqa: BLE001
            pass
