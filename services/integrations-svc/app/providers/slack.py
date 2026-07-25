"""Slack adapter.

Phase 2 provider. Connect is token-paste (bot token + signing secret). Outbound
send uses chat.postMessage; inbound events arrive at the public webhook and are
authenticated with the Slack signing secret (HMAC-SHA256 over `v0:{ts}:{body}`
with a 5-minute timestamp-skew window). auth.test validates a pasted token and
resolves the workspace identity used for the connection's label + dedupe key.
"""
from __future__ import annotations

import hashlib
import hmac
import time

import httpx

from ..resilience import CircuitBreaker, retry_async

_SLACK_API = "https://slack.com/api"
_TIMEOUT = 10.0
_SIG_MAX_SKEW = 300  # seconds — reject stale/replayed signatures
_slack_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="slack")


class SlackError(Exception):
    """A definitive Slack API failure (bad token, bad request)."""


def verify_signature(
    signing_secret: str,
    timestamp: str,
    raw_body: bytes,
    signature: str,
    *,
    now: float | None = None,
) -> bool:
    """Verify a Slack request signature (constant-time). Returns False on any
    malformed input, stale timestamp, or mismatch — fail closed."""
    if not signing_secret or not signature or not timestamp:
        return False
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    current = time.time() if now is None else now
    if abs(current - ts) > _SIG_MAX_SKEW:
        return False
    base = b"v0:" + str(ts).encode("utf-8") + b":" + raw_body
    expected = "v0=" + hmac.new(signing_secret.encode("utf-8"), base, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


async def auth_test(bot_token: str) -> dict:
    """Validate a bot token and return the workspace identity (team, team_id, …)."""

    async def _attempt() -> dict:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                f"{_SLACK_API}/auth.test",
                headers={"Authorization": f"Bearer {bot_token}"},
            )
            r.raise_for_status()
            return r.json()

    data = await retry_async(_attempt, attempts=3, breaker=_slack_breaker)
    if not data.get("ok"):
        raise SlackError(data.get("error", "auth.test failed"))
    return data


async def post_message(bot_token: str, channel: str, text: str) -> dict:
    """Send a message via chat.postMessage. Returns the Slack response (with `ts`)."""

    async def _attempt() -> dict:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                f"{_SLACK_API}/chat.postMessage",
                headers={
                    "Authorization": f"Bearer {bot_token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                json={"channel": channel, "text": text},
            )
            r.raise_for_status()
            return r.json()

    data = await retry_async(_attempt, attempts=3, breaker=_slack_breaker)
    if not data.get("ok"):
        raise SlackError(data.get("error", "chat.postMessage failed"))
    return data
