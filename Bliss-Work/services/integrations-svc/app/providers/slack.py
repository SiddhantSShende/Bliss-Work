"""Slack adapter.

Connect is token-paste (bot token + signing secret). Outbound send uses
chat.postMessage. auth.test validates a pasted token and resolves the
workspace identity used for the connection's label + dedupe key.
"""
from __future__ import annotations

import httpx

from resilience import CircuitBreaker, retry_async

from . import httpclient

_SLACK_API = "https://slack.com/api"
_TIMEOUT = 10.0
_slack_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="slack")


class SlackError(Exception):
    """A definitive Slack API failure (bad token, bad request)."""


class SlackRateLimited(SlackError):
    """429: Slack is throttling this token. `retry_after` is seconds, when
    Slack supplied one. Kept out of resilience.is_transient()'s view (like
    Gmail/MicrosoftRateLimited) deliberately: a per-token rate limit says
    nothing about whether Slack itself is healthy, so it should not trip the
    shared circuit breaker — callers handle backoff explicitly instead."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


def _raise_for_status(r: httpx.Response) -> None:
    if r.status_code == 429:
        retry_after = r.headers.get("Retry-After")
        delay = float(retry_after) if retry_after and retry_after.isdigit() else None
        raise SlackRateLimited(f"{r.status_code}: rate limited", delay)
    r.raise_for_status()


async def auth_test(bot_token: str) -> dict:
    """Validate a bot token and return the workspace identity (team, team_id, …)."""

    async def _attempt() -> dict:
        r = await httpclient.shared().post(
            f"{_SLACK_API}/auth.test",
            headers={"Authorization": f"Bearer {bot_token}"},
            timeout=_TIMEOUT,
        )
        _raise_for_status(r)
        return r.json()

    data = await retry_async(_attempt, attempts=3, breaker=_slack_breaker)
    if not data.get("ok"):
        raise SlackError(data.get("error", "auth.test failed"))
    return data


async def post_message(bot_token: str, channel: str, text: str) -> dict:
    """Send a message via chat.postMessage. Returns the Slack response (with `ts`)."""

    async def _attempt() -> dict:
        r = await httpclient.shared().post(
            f"{_SLACK_API}/chat.postMessage",
            headers={
                "Authorization": f"Bearer {bot_token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            json={"channel": channel, "text": text},
            timeout=_TIMEOUT,
        )
        _raise_for_status(r)
        return r.json()

    # idempotent=False: this creates a new outbound chat message on every
    # execution. A ReadTimeout after Slack already accepted the post must not
    # be retried.
    data = await retry_async(_attempt, attempts=3, breaker=_slack_breaker, idempotent=False)
    if not data.get("ok"):
        raise SlackError(data.get("error", "chat.postMessage failed"))
    return data
