"""Async Redis client for the offline-relay presence gate.

Online check: the user has at least one connection entry in
`presence:u:<userId>` whose heartbeat is recent.

That key is owned by ws-gateway (`internal/store/store.go`) and its shape is
load-bearing here, so the two must be read together. It is a SORTED SET whose
members are `nodeId:connId` and whose scores are the epoch-milliseconds of the
last heartbeat, refreshed by every connection's 20s ping.

The freshness check is the whole point and cannot be skipped. Membership alone
used to be the test, back when this was a plain SET — and it was wrong for the
case that matters most: a gateway killed rather than shut down never removes
its entries, so the user stayed "online" indefinitely and their email
notifications were suppressed forever. Scoring by heartbeat means a dead node's
entries simply age out. ws-gateway reaps them on read; here we just ignore
anything older than the stale window.

Keep `PRESENCE_STALE_MS` in step with `presenceStaleAfter` in
ws-gateway/internal/store/store.go. A value that is too small emails people who
are sitting right there; too large re-creates the bug above, bounded.
"""
from __future__ import annotations

import time

import structlog
from redis.asyncio import Redis

_log = structlog.get_logger("presence")

# Three missed 20s heartbeats plus slack. Mirrors ws-gateway's presenceStaleAfter.
PRESENCE_STALE_MS = 70_000


class Presence:
    """Thin wrapper around an asyncio Redis client for online checks."""

    def __init__(self, url: str) -> None:
        self._redis: Redis = Redis.from_url(url, decode_responses=True)

    async def is_online(self, user_id: str) -> bool:
        """Return True iff the user has at least one live, recently-seen WS connection."""
        try:
            cutoff = (time.time() * 1000) - PRESENCE_STALE_MS
            # ZCOUNT over the fresh range, not ZCARD over the whole key: a stale
            # member is an entry from a node that died, and counting it would
            # suppress this user's email indefinitely.
            n = await self._redis.zcount(f"presence:u:{user_id}", cutoff, "+inf")
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
