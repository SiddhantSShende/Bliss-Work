"""Slack request-signature verification (security-critical; deterministic)."""
import hashlib
import hmac

from app.providers import slack


def _sign(secret: str, ts: str, body: bytes) -> str:
    base = b"v0:" + ts.encode() + b":" + body
    return "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()


NOW = 1_700_000_000.0  # fixed clock so timestamp-skew checks are deterministic


def test_accepts_valid_signature():
    secret, ts, body = "shhh", str(int(NOW)), b'{"type":"event_callback"}'
    sig = _sign(secret, ts, body)
    assert slack.verify_signature(secret, ts, body, sig, now=NOW) is True


def test_rejects_tampered_body():
    secret, ts = "shhh", str(int(NOW))
    sig = _sign(secret, ts, b'{"amount":1}')
    assert slack.verify_signature(secret, ts, b'{"amount":1000000}', sig, now=NOW) is False


def test_rejects_wrong_secret():
    ts, body = str(int(NOW)), b"hello"
    sig = _sign("real-secret", ts, body)
    assert slack.verify_signature("attacker-secret", ts, body, sig, now=NOW) is False


def test_rejects_stale_timestamp():
    secret, body = "shhh", b"hello"
    old_ts = str(int(NOW) - 600)  # 10 min old > 5 min window
    sig = _sign(secret, old_ts, body)
    assert slack.verify_signature(secret, old_ts, body, sig, now=NOW) is False


def test_rejects_missing_inputs():
    assert slack.verify_signature("", "1", b"x", "v0=abc", now=NOW) is False
    assert slack.verify_signature("s", "", b"x", "v0=abc", now=NOW) is False
    assert slack.verify_signature("s", "1", b"x", "", now=NOW) is False
    assert slack.verify_signature("s", "not-an-int", b"x", "v0=abc", now=NOW) is False
