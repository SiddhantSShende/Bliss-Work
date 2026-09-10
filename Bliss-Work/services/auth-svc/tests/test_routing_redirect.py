"""The shared redirect helper: what a non-local key looks like on the wire.

One helper serves both the org-mismatch and the invite cases, so these tests are
about the properties that must hold for both — and about the two ways a redirect
helper goes wrong: the wrong status code, and trusting the request's own host.
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.routing.decision import Route, RouteDecision
from app.routing.redirect import (
    RETRY_AFTER_SECONDS,
    SiteEndpoints,
    enforce,
    redirect_target,
)

ENDPOINTS = SiteEndpoints(
    {"site-a": "https://a.blisswork.example", "site-b": "https://b.blisswork.example/"}
)


class FakeRequest:
    """Only what `enforce` reads. A real Request needs an ASGI scope, and this
    helper's contract is one attribute wide."""

    def __init__(self, url: str) -> None:
        self.url = url


def test_a_local_decision_produces_no_response_at_all():
    assert enforce(RouteDecision(Route.LOCAL, "site-a"), FakeRequest("https://a/x"), ENDPOINTS) is None


def test_a_remote_key_redirects_with_307_not_302():
    # 307 preserves the method and body. A 302 turns an invite redemption's POST
    # into a GET at the far site, and the password never arrives — the failure
    # is silent and looks like a bad password.
    response = enforce(
        RouteDecision(Route.REDIRECT, "site-b"),
        FakeRequest("https://a.blisswork.example/auth/invites/accept"),
        ENDPOINTS,
    )
    assert response is not None
    assert response.status_code == 307
    assert response.headers["location"] == "https://b.blisswork.example/auth/invites/accept"


def test_the_redirect_keeps_the_path_and_query_and_replaces_only_the_host():
    target = redirect_target("https://b.example", "https://a.example/auth/invites/accept?token=abc")
    assert target == "https://b.example/auth/invites/accept?token=abc"


def test_the_target_host_comes_from_configuration_not_from_the_request():
    # The open-redirect guard. The incoming Host header is attacker-controlled;
    # a redirect built from it is an open redirect wearing a routing decision's
    # clothes.
    target = redirect_target("https://b.example", "https://evil.test/auth/invites/accept")
    assert target.startswith("https://b.example/")
    assert "evil.test" not in target


def test_a_trailing_slash_on_the_configured_base_does_not_double_up():
    assert redirect_target("https://b.example/", "https://a/x") == "https://b.example/x"


def test_an_unknown_key_is_a_retryable_503_never_a_404():
    with pytest.raises(HTTPException) as raised:
        enforce(RouteDecision(Route.RETRY), FakeRequest("https://a/x"), ENDPOINTS)
    assert raised.value.status_code == 503
    assert raised.value.headers["Retry-After"] == str(RETRY_AFTER_SECONDS)
    assert "retry" in raised.value.detail.lower()


def test_an_expired_key_is_410_and_is_answered_here():
    with pytest.raises(HTTPException) as raised:
        enforce(RouteDecision(Route.GONE, "site-b"), FakeRequest("https://a/x"), ENDPOINTS, key_kind="this invite")
    assert raised.value.status_code == 410
    assert "no longer valid" in raised.value.detail


def test_a_site_we_have_no_endpoint_for_refuses_rather_than_guessing():
    # We know where the key lives and cannot say where that is. Refusing beats
    # inventing a hostname from anything a peer sent us.
    with pytest.raises(HTTPException) as raised:
        enforce(RouteDecision(Route.REDIRECT, "site-z"), FakeRequest("https://a/x"), ENDPOINTS)
    assert raised.value.status_code == 503
    assert raised.value.headers["Retry-After"]


def test_endpoint_parsing_drops_blanks():
    endpoints = SiteEndpoints({"site-a": "https://a", "": "https://nope", "site-c": ""})
    assert len(endpoints) == 1
    assert "site-a" in endpoints and "site-c" not in endpoints
