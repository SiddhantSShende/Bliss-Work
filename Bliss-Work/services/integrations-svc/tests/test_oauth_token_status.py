"""OAuth token-endpoint error classification.

The split matters to refresh_worker.py specifically: it catches oauth.OAuthError
as a DEFINITIVE failure (marks the connection status='error', prompting a user
to reconnect) and treats everything else as transient (retry next 60s sweep).
A transient outage at the token endpoint misclassified as an OAuthError would
mass-disconnect every due connection instead of just waiting it out.
"""

import httpx
import pytest

from app.providers import oauth


def _resp(status: int, body: dict | None = None) -> httpx.Response:
    return httpx.Response(
        status_code=status,
        json=body if body is not None else {},
        request=httpx.Request("POST", "https://oauth2.googleapis.com/token"),
    )


@pytest.mark.parametrize("status", [500, 502, 503, 504, 429])
def test_5xx_and_429_are_transient_not_a_definitive_oauth_error(status):
    # Must NOT be an OAuthError: refresh_worker's `except oauth.OAuthError`
    # would otherwise flip a perfectly-valid connection to status='error' over
    # a token-endpoint blip that would have cleared on the next sweep.
    with pytest.raises(httpx.HTTPStatusError):
        oauth._raise_for_token_status(_resp(status, {"error": "server_error"}))


@pytest.mark.parametrize("status", [400, 401, 403])
def test_other_4xx_are_a_definitive_oauth_error(status):
    # invalid_grant (revoked/expired refresh token) and friends ARE a real
    # answer about this exact request — must surface as terminal so the user
    # is prompted to reconnect rather than retried forever.
    with pytest.raises(oauth.OAuthError):
        oauth._raise_for_token_status(_resp(status, {"error": "invalid_grant"}))
