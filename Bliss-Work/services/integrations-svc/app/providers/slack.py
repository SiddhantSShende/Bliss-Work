"""Slack adapter.

Connect is token-paste (bot token + signing secret). Outbound send uses
chat.postMessage. auth.test validates a pasted token and resolves the
workspace identity used for the connection's label + dedupe key.
"""
from __future__ import annotations

import httpx

from resilience import CircuitBreaker, retry_async

_SLACK_API = "https://slack.com/api"
_TIMEOUT = 10.0
_slack_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="slack")


class SlackError(Exception):
    """A definitive Slack API failure (bad token, bad request)."""


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

    # idempotent=False: this creates a new outbound chat message on every
    # execution. A ReadTimeout after Slack already accepted the post must not
    # be retried.
    data = await retry_async(_attempt, attempts=3, breaker=_slack_breaker, idempotent=False)
    if not data.get("ok"):
        raise SlackError(data.get("error", "chat.postMessage failed"))
    return data
