"""The gate that decides whether a message becomes an email.

This reads a key that ws-gateway owns, so the two are coupled whether or not
anyone writes it down. These tests write it down.

The case that matters is a STALE entry. A gateway that is killed rather than
shut down never removes its connection entries, and under the old
membership-only check that user counted as online forever — so they silently
stopped receiving offline notifications, with nothing anywhere reporting a
fault. Freshness is what turns that from permanent into bounded.
"""
from __future__ import annotations

import time

import pytest

presence = pytest.importorskip(
    "app.presence",
    reason="email-worker deps not installed locally; CI installs requirements.txt.",
)


class FakeRedis:
    """Just enough Redis to answer ZCOUNT over a scored member set."""

    def __init__(self, members: dict[str, float] | None = None, *, fail: bool = False) -> None:
        self.members = members or {}
        self.fail = fail
        self.calls: list[tuple[str, float]] = []

    async def zcount(self, key: str, cutoff: float, _max: str) -> int:
        if self.fail:
            raise ConnectionError("redis is down")
        self.calls.append((key, cutoff))
        return sum(1 for score in self.members.values() if score >= cutoff)


def _presence(fake: FakeRedis) -> "presence.Presence":
    p = presence.Presence.__new__(presence.Presence)
    p._redis = fake  # noqa: SLF001 — bypassing __init__ avoids a real connection
    return p


def _ms_ago(seconds: float) -> float:
    return (time.time() * 1000) - seconds * 1000


@pytest.mark.asyncio
async def test_a_freshly_heartbeating_connection_counts_as_online():
    p = _presence(FakeRedis({"node-1:conn-a": _ms_ago(5)}))
    assert await p.is_online("alice") is True


@pytest.mark.asyncio
async def test_no_connections_at_all_is_offline():
    p = _presence(FakeRedis({}))
    assert await p.is_online("alice") is False


@pytest.mark.asyncio
async def test_an_entry_left_behind_by_a_dead_node_is_not_online():
    # The regression this whole change exists for: the member is still in the
    # key because nothing removed it, but nobody has heartbeated for it.
    stale = presence.PRESENCE_STALE_MS / 1000 + 30
    p = _presence(FakeRedis({"dead-node:conn-a": _ms_ago(stale)}))
    assert await p.is_online("alice") is False


@pytest.mark.asyncio
async def test_one_live_tab_keeps_a_user_online_despite_a_dead_sibling():
    stale = presence.PRESENCE_STALE_MS / 1000 + 30
    p = _presence(FakeRedis({"dead-node:conn-a": _ms_ago(stale), "node-2:conn-b": _ms_ago(3)}))
    assert await p.is_online("alice") is True


@pytest.mark.asyncio
async def test_it_reads_the_key_ws_gateway_actually_writes():
    # The prefix is a cross-service contract; a rename on either side must fail
    # here rather than in production as silently-suppressed email.
    fake = FakeRedis({})
    await _presence(fake).is_online("alice")
    assert fake.calls[0][0] == "presence:u:alice"


@pytest.mark.asyncio
async def test_it_fails_open_when_redis_is_unreachable():
    # Assume online and skip the email. Being unable to tell must not turn into
    # a mail-out to everyone the moment Redis blips.
    p = _presence(FakeRedis(fail=True))
    assert await p.is_online("alice") is True
