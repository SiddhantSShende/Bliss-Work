"""Gmail adapter — the pure parts and the error classification.

The error mapping is the part worth testing hardest: each of the three classes
sends the caller down a completely different path (enroll for token refresh /
back off and retry / give up), and getting one wrong is silent. A 403 quota
error misclassified as definitive drops that mailbox's mail permanently.
"""

import base64

import httpx
import pytest

from app.providers import gmail


def _resp(status: int, body: dict | None = None, headers: dict | None = None) -> httpx.Response:
    return httpx.Response(
        status_code=status,
        json=body if body is not None else {},
        headers=headers or {},
        request=httpx.Request("GET", "https://gmail.googleapis.com/x"),
    )


# ── error classification ──────────────────────────────────────────────────────
def test_401_is_an_auth_error_not_a_dead_connection():
    # The caller responds by setting token_expires_at = now() so the existing
    # refresh_worker renews it. Only a failed REFRESH marks the connection bad.
    with pytest.raises(gmail.GmailAuthError):
        gmail._raise_for_status(_resp(401, {"error": {"message": "Invalid Credentials"}}))


def test_429_is_rate_limited_and_carries_retry_after():
    with pytest.raises(gmail.GmailRateLimited) as ei:
        gmail._raise_for_status(_resp(429, {"error": {"message": "too many"}}, {"Retry-After": "30"}))
    assert ei.value.retry_after == 30.0


@pytest.mark.parametrize(
    "reason", ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]
)
def test_403_quota_is_rate_limiting_not_a_permanent_failure(reason):
    # THE subtle one: Google reports quota exhaustion as 403, not 429. Treating
    # it as definitive would drop the work instead of retrying it shortly.
    with pytest.raises(gmail.GmailRateLimited):
        gmail._raise_for_status(
            _resp(403, {"error": {"message": "quota", "errors": [{"reason": reason}]}})
        )


def test_403_permission_denied_stays_definitive():
    # A genuine scope/permission problem must NOT be retried forever.
    with pytest.raises(gmail.GmailError) as ei:
        gmail._raise_for_status(
            _resp(403, {"error": {"message": "insufficient", "errors": [{"reason": "forbidden"}]}})
        )
    assert not isinstance(ei.value, gmail.GmailRateLimited)


def test_404_is_definitive():
    with pytest.raises(gmail.GmailError):
        gmail._raise_for_status(_resp(404, {"error": {"message": "Not Found"}}))


def test_non_json_error_body_still_classifies():
    r = httpx.Response(
        status_code=500,
        text="<html>gateway error</html>",
        request=httpx.Request("GET", "https://gmail.googleapis.com/x"),
    )
    with pytest.raises(gmail.GmailError):
        gmail._raise_for_status(r)


@pytest.mark.parametrize("status", [200, 201, 204])
def test_success_statuses_do_not_raise(status):
    gmail._raise_for_status(_resp(status))


def test_missing_retry_after_is_none_not_zero():
    # None means "use our own backoff"; 0 would mean "retry immediately", which
    # is the worst possible response to being rate limited.
    with pytest.raises(gmail.GmailRateLimited) as ei:
        gmail._raise_for_status(_resp(429, {"error": {"message": "slow down"}}))
    assert ei.value.retry_after is None


# ── MIME building ─────────────────────────────────────────────────────────────
def _decode(raw: str) -> str:
    # Re-pad to decode; the point is that what we PRODUCE carries no padding.
    return base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode()


def test_build_mime_is_base64url_without_padding():
    # Gmail's `raw` field rejects a padded value. urlsafe_b64encode always pads,
    # so the stripping is required — and a body whose length happens to be a
    # multiple of 3 would hide the bug in any manual test.
    raw = gmail.build_mime(to="a@b.com", subject="Hi", body="x")
    assert "=" not in raw
    assert "+" not in raw and "/" not in raw  # url-safe alphabet


@pytest.mark.parametrize("body", ["a", "ab", "abc", "abcd", "abcde"])
def test_no_padding_at_any_body_length(body):
    assert "=" not in gmail.build_mime(to="a@b.com", subject="S", body=body)


def test_build_mime_round_trips_the_headers_and_body():
    raw = gmail.build_mime(to="dev@acme.com", subject="Ticket #4", body="Please look.")
    out = _decode(raw)
    assert "To: dev@acme.com" in out
    assert "Subject: Ticket #4" in out
    assert "Please look." in out


def test_build_mime_omits_from_when_not_supplied():
    # Gmail stamps the authenticated mailbox itself; an empty From: would be
    # worse than none.
    assert "From:" not in _decode(gmail.build_mime(to="a@b.com", subject="S", body="B"))


def test_build_mime_formats_a_display_name():
    out = _decode(
        gmail.build_mime(
            to="a@b.com", subject="S", body="B", from_addr="me@acme.com", from_name="Me Acme"
        )
    )
    assert "From: Me Acme <me@acme.com>" in out


def test_build_mime_handles_unicode():
    out = _decode(gmail.build_mime(to="a@b.com", subject="Café ☕", body="naïve — dash"))
    # Non-ASCII must survive; the transfer encoding is the library's business,
    # but the content must not be mangled or dropped.
    assert "naïve" in out or "bmHDr3Zl" in out or "=C3=AF" in out
