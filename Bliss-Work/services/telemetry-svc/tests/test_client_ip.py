"""This service's own wiring onto the shared client_ip package
(services/shared/client_ip/client_ip.py), plus a regression guard specific to
this service's code.

The identity algorithm itself — rightmost-entry reading, spoof-proofing,
user-vs-IP keying — is tested once in
services/shared/client_ip/tests/test_client_ip.py. What's specific to THIS
service is only: does app/rate_limit.py's `rate_limit_key` correctly thread
`settings.trusted_proxy_hops` into it, and has nothing in this service's code
reintroduced the banned `slowapi.util.get_remote_address`.
"""
from __future__ import annotations

import pytest
from starlette.datastructures import Headers


class _Client:
    def __init__(self, host: str) -> None:
        self.host = host


class _Req:
    """Enough of a Request for rate_limit_key."""

    def __init__(self, headers: dict[str, str], peer: str | None = "172.18.0.5") -> None:
        self.headers = Headers(headers)
        self.client = _Client(peer) if peer else None

        class _State:
            pass

        self.state = _State()


@pytest.mark.parametrize("hops", [1, 2])
def test_hop_count_indexes_from_the_right(monkeypatch: pytest.MonkeyPatch, hops: int) -> None:
    """Adding a proxy in front means skipping one more entry from the right,
    never reading further left than the number of proxies we actually run."""
    from app import rate_limit

    monkeypatch.setattr(rate_limit.settings, "trusted_proxy_hops", hops)
    req = _Req({"x-forwarded-for": "203.0.113.9, 10.0.0.7"})
    expected = "10.0.0.7" if hops == 1 else "203.0.113.9"
    assert rate_limit.rate_limit_key(req) == f"ip:{expected}"


def test_slowapi_remote_address_is_not_called_anywhere() -> None:
    """A guard on the mistake itself. get_remote_address reads through to
    request.client.host, so any reintroduction silently restores the global
    bucket — and would pass every behavioural test for the shared algorithm.

    Checks the AST rather than the text, so comments explaining WHY it is
    banned don't trip it. Naming the hazard in prose is the point; calling it
    is the bug.
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
