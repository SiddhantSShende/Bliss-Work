"""The per-IP limiter is only as good as the IP it keys on.

This suite exists because that identity was wrong in production and nothing
caught it. `slowapi.util.get_remote_address` returns `request.client.host`,
which behind our edge is Caddy's address on every request in the world, so
the 600/minute per-caller budget was enforced as 600/minute for the entire
platform.

The regression is invisible from the outside — the service works, the limiter
returns 429s, and only counting requests reveals that every caller shares one
bucket. So the assertions below are about the KEY, not about the behaviour.
"""
from __future__ import annotations

import pytest
from starlette.datastructures import Headers

from app.net import client_ip, rate_limit_key


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
    assert client_ip(req) == "203.0.113.9"


def test_a_spoofed_prefix_cannot_change_the_bucket() -> None:
    """The attack the leftmost reading enables: a fresh forged value per request
    puts every request in a fresh bucket and the limiter stops existing."""
    a = _Req({"x-forwarded-for": "1.1.1.1, 203.0.113.9"})
    b = _Req({"x-forwarded-for": "2.2.2.2, 203.0.113.9"})
    c = _Req({"x-forwarded-for": "9.9.9.9, 8.8.8.8, 203.0.113.9"})
    assert client_ip(a) == client_ip(b) == client_ip(c) == "203.0.113.9"


def test_two_real_callers_do_not_share_a_bucket() -> None:
    """The actual production bug, stated as an assertion: distinct callers
    arriving through the same proxy must key differently."""
    one = _Req({"x-forwarded-for": "203.0.113.9"})
    two = _Req({"x-forwarded-for": "198.51.100.4"})
    assert rate_limit_key(one) != rate_limit_key(two)


def test_falls_back_to_the_peer_when_unproxied() -> None:
    """Direct calls (tests, in-cluster probes) have no header and must still
    key on something narrower than 'everyone'."""
    assert client_ip(_Req({}, peer="10.1.2.3")) == "10.1.2.3"


def test_missing_peer_does_not_raise() -> None:
    assert client_ip(_Req({}, peer=None)) == "unknown"


def test_verified_user_beats_ip() -> None:
    """The second half of the bug: `request.state.principal` was read but never
    assigned, so the user branch was dead code. PrincipalMiddleware assigns it;
    this asserts the key function actually prefers it."""

    class _P:
        user_id = "11111111-1111-1111-1111-111111111111"

    req = _Req({"x-forwarded-for": "203.0.113.9"})
    req.state.principal = _P()
    assert rate_limit_key(req) == "user:11111111-1111-1111-1111-111111111111"


def test_one_user_keeps_one_budget_across_networks() -> None:
    """Why keying by user matters in the other direction: a phone changing
    networks must not be handed a fresh allowance."""

    class _P:
        user_id = "22222222-2222-2222-2222-222222222222"

    wifi = _Req({"x-forwarded-for": "203.0.113.9"})
    cell = _Req({"x-forwarded-for": "198.51.100.4"})
    wifi.state.principal = _P()
    cell.state.principal = _P()
    assert rate_limit_key(wifi) == rate_limit_key(cell)


def test_unauthenticated_still_keys_by_ip() -> None:
    """Login carries no token — the IP bucket is the only protection it has."""
    req = _Req({"x-forwarded-for": "203.0.113.9"})
    assert rate_limit_key(req) == "ip:203.0.113.9"


@pytest.mark.parametrize("hops", [1, 2])
def test_hop_count_indexes_from_the_right(monkeypatch: pytest.MonkeyPatch, hops: int) -> None:
    """Adding a proxy in front means skipping one more entry from the right,
    never reading further left than the number of proxies we actually run."""
    from app import net

    monkeypatch.setattr(net.settings, "trusted_proxy_hops", hops, raising=False)
    req = _Req({"x-forwarded-for": "203.0.113.9, 10.0.0.7"})
    assert net.client_ip(req) == ("10.0.0.7" if hops == 1 else "203.0.113.9")


def test_slowapi_remote_address_is_not_called_anywhere() -> None:
    """A guard on the mistake itself. get_remote_address reads through to
    request.client.host, so any reintroduction silently restores the global
    bucket — and would pass every behavioural test in this file.

    Checks the AST rather than the text, so the comments in net.py and
    rate_limit.py that explain WHY it is banned don't trip it. Naming the
    hazard in prose is the point; calling it is the bug.
    """
    import ast
    import pathlib

    app_dir = pathlib.Path(__file__).resolve().parent.parent / "app"
    offenders: list[str] = []
    for path in app_dir.rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            called = (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id == "get_remote_address"
            )
            imported = isinstance(node, ast.ImportFrom) and any(
                a.name == "get_remote_address" for a in node.names
            )
            if called or imported:
                offenders.append(str(path.relative_to(app_dir)))
                break
    assert offenders == [], f"get_remote_address reintroduced in: {offenders}"
