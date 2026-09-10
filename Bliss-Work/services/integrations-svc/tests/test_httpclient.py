"""Phase 3: the shared, pooled `httpx.AsyncClient` every provider module
(slack/gmail/microsoft/oauth) calls through instead of opening a fresh client
per request (see app/providers/httpclient.py's own module docstring for why).

This suite was never committed at the time and was later lost along with the
rest of this service's test directory (see Phase 10.1's test-durability
findings) — recreated here against the CURRENT implementation. No mocking:
`shared()` returns a real httpx.AsyncClient, so these tests exercise the
module's actual lazy-singleton/close/reset logic directly rather than a stand-in.
"""
from __future__ import annotations

import httpx
import pytest

from app.providers import httpclient


@pytest.fixture(autouse=True)
async def _reset_shared_client():
    """The module holds a process-wide global — leaving a client from one test
    alive (or closed) would leak into the next, so force a clean slate before
    and after every test regardless of how the test left it."""
    await httpclient.aclose()
    yield
    await httpclient.aclose()


def test_shared_returns_the_same_client_on_repeated_calls():
    first = httpclient.shared()
    second = httpclient.shared()
    assert first is second


def test_shared_builds_a_real_bounded_client():
    client = httpclient.shared()
    assert isinstance(client, httpx.AsyncClient)
    assert not client.is_closed
    # httpx doesn't expose the configured Limits back on the client publicly;
    # the connection pool underneath the default transport does. Worth
    # asserting anyway — the exact bound (20/10) is the specific, documented
    # design decision in httpclient.py's own docstring ("bounded, not
    # unlimited"), and a regression here (e.g. limits=None) would silently
    # remove that bound rather than raise anywhere.
    pool = client._transport._pool
    assert pool._max_connections == 20
    assert pool._max_keepalive_connections == 10


async def test_aclose_closes_the_client_and_clears_the_singleton():
    client = httpclient.shared()
    await httpclient.aclose()
    assert client.is_closed


async def test_a_new_client_is_built_after_aclose():
    """Confirms the module-level singleton is actually cleared (set back to
    None) by aclose — not just closed while still cached, which would make
    every call after shutdown reuse a dead client."""
    first = httpclient.shared()
    await httpclient.aclose()
    second = httpclient.shared()
    assert second is not first
    assert not second.is_closed


async def test_aclose_is_safe_to_call_when_nothing_was_ever_built():
    # Should not raise even though the fixture already reset _client to None.
    await httpclient.aclose()


async def test_aclose_is_idempotent():
    httpclient.shared()
    await httpclient.aclose()
    await httpclient.aclose()  # second call: _client is already None, must be a no-op
