"""One pooled, reused httpx.AsyncClient for every provider/OAuth API call.

`httpx.AsyncClient(timeout=_TIMEOUT)` used to be opened fresh inside
`async with` on every single call in slack.py/gmail.py/oauth.py/microsoft.py —
a new TCP connection and TLS handshake to Slack/Google/Microsoft on every
send, every token exchange, every refresh. Worse, every one of those calls is
already wrapped in `retry_async(attempts=3, ...)`, so a call that needed even
one retry paid for three fresh handshakes instead of reusing one pooled
connection across the attempts — exactly backwards, since a retry is often
compensating for a slow/flaky network path in the first place.

Same fix `shared/crypto.py`'s `Cryptor._client()` already applies to the
Vault KMS path in this same codebase: build the client once, keep it alive,
let httpx's own connection pool do the reusing. Module-scoped rather than
per-provider-module because all four provider modules share the same shape
of call and there is no reason for Slack's pool and Gmail's pool to be
separate — they're going to different hosts anyway, so httpx's per-host
pooling already keeps them from interfering with each other.
"""
from __future__ import annotations

import httpx

_client: httpx.AsyncClient | None = None


def shared() -> httpx.AsyncClient:
    """The process-wide client. Built lazily so importing this module never
    pays for a client nobody ends up using.

    Bounded, not unlimited: this pool is shared across every provider this
    service talks to (Slack, Gmail, Microsoft Graph, generic OAuth token
    endpoints), but request concurrency into this process is itself bounded
    by its own connection pool (5+5) and rate limiting — an unbounded HTTP
    pool on top of a bounded request pipeline would just be dead capacity.
    No client-level `timeout=` default: each provider call passes its own
    `_TIMEOUT` per-request (10-15s, provider-specific, unchanged from before
    this file existed) rather than sharing one value across providers with
    different latency characteristics.
    """
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _client


async def aclose() -> None:
    """Close the pooled client. Call once, on service shutdown."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
