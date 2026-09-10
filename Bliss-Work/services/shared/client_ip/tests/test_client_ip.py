"""The per-IP limiter is only as good as the IP it keys on.

This suite exists because that identity was wrong in production and nothing
caught it. `slowapi.util.get_remote_address` returns `request.client.host`,
which behind our edge is Caddy's address on every request in the world, so a
"10 logins per minute per IP" style limit was enforced for the entire
platform.

The regression is invisible from the outside — the service works, the limiter
returns 429s, and only counting requests reveals that every caller shares one
bucket. So the assertions below are about the KEY, not about the behaviour.

Each consuming service (auth-svc, task-svc, integrations-svc, telemetry-svc)
keeps its own small test verifying its own settings wire the right `hops`
value into this package, plus its own `get_remote_address`-reintroduction
guard — both of those are specific to that service's code, not to this
algorithm, so they are not duplicated here.
"""
from __future__ import annotations

from starlette.datastructures import Headers

from client_ip import client_ip, rate_limit_key


class _Client:
    def __init__(self, host: str) -> None:
        self.host = host


class _Req:
    """Enough of a Request for the two functions under test."""

    def __init__(self, headers: dict[str, str], peer: str | None = "172.18.0.5") -> None:
        self.headers = Headers(headers)
        self.client = _Client(peer) if peer else None

        class _State:
            pass

        self.state = _State()


def test_reads_the_rightmost_forwarded_entry() -> None:
    """Only the last hop was observed by our own edge; everything before it is
    whatever the client chose to send."""
    req = _Req({"x-forwarded-for": "203.0.113.9"})
    assert client_ip(req, hops=1) == "203.0.113.9"


def test_a_spoofed_prefix_cannot_change_the_bucket() -> None:
    """The attack the leftmost reading enables: a fresh forged value per request
    puts every request in a fresh bucket and the limiter stops existing."""
    a = _Req({"x-forwarded-for": "1.1.1.1, 203.0.113.9"})
    b = _Req({"x-forwarded-for": "2.2.2.2, 203.0.113.9"})
    c = _Req({"x-forwarded-for": "9.9.9.9, 8.8.8.8, 203.0.113.9"})
    assert client_ip(a, hops=1) == client_ip(b, hops=1) == client_ip(c, hops=1) == "203.0.113.9"


def test_two_real_callers_do_not_share_a_bucket() -> None:
    """The actual production bug, stated as an assertion: distinct callers
    arriving through the same proxy must key differently."""
    one = _Req({"x-forwarded-for": "203.0.113.9"})
    two = _Req({"x-forwarded-for": "198.51.100.4"})
    assert rate_limit_key(one, hops=1) != rate_limit_key(two, hops=1)


def test_falls_back_to_the_peer_when_unproxied() -> None:
    """Direct calls (tests, in-cluster probes) have no header and must still
    key on something narrower than 'everyone'."""
    assert client_ip(_Req({}, peer="10.1.2.3"), hops=1) == "10.1.2.3"


def test_missing_peer_does_not_raise() -> None:
    assert client_ip(_Req({}, peer=None), hops=1) == "unknown"


def test_verified_user_beats_ip() -> None:
    """The second half of the bug this package's callers each fixed: a
    principal that middleware assigns before the limiter runs must win over
    keying by IP."""

    class _P:
        user_id = "11111111-1111-1111-1111-111111111111"

    req = _Req({"x-forwarded-for": "203.0.113.9"})
    req.state.principal = _P()
    assert rate_limit_key(req, hops=1) == "user:11111111-1111-1111-1111-111111111111"


def test_one_user_keeps_one_budget_across_networks() -> None:
    """Why keying by user matters in the other direction: a phone changing
    networks must not be handed a fresh allowance."""

    class _P:
        user_id = "22222222-2222-2222-2222-222222222222"

    wifi = _Req({"x-forwarded-for": "203.0.113.9"})
    cell = _Req({"x-forwarded-for": "198.51.100.4"})
    wifi.state.principal = _P()
    cell.state.principal = _P()
    assert rate_limit_key(wifi, hops=1) == rate_limit_key(cell, hops=1)


def test_unauthenticated_still_keys_by_ip() -> None:
    """Login carries no token — the IP bucket is the only protection it has."""
    req = _Req({"x-forwarded-for": "203.0.113.9"})
    assert rate_limit_key(req, hops=1) == "ip:203.0.113.9"


def test_hop_count_indexes_from_the_right() -> None:
    """Adding a proxy in front means skipping one more entry from the right,
    never reading further left than the number of proxies actually run."""
    req = _Req({"x-forwarded-for": "203.0.113.9, 10.0.0.7"})
    assert client_ip(req, hops=1) == "10.0.0.7"
    assert client_ip(req, hops=2) == "203.0.113.9"
