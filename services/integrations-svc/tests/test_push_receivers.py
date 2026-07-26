"""Push receiver parsing + authentication decisions.

Both endpoints are reachable by anyone on the internet, so what they REJECT
matters more than what they accept. The Gmail audience check is the sharp edge:
Google signs OIDC tokens for every project on its platform, so verifying the
signature alone authenticates nothing — only pinning `aud` to our own endpoint
binds the token to us.
"""

import base64
import json

import pytest

from app.routes import push


def _envelope(payload: dict | str | bytes) -> dict:
    """Wrap a Gmail payload the way Pub/Sub push delivers it."""
    if isinstance(payload, dict):
        raw = json.dumps(payload).encode()
    elif isinstance(payload, str):
        raw = payload.encode()
    else:
        raw = payload
    return {"message": {"data": base64.b64encode(raw).decode(), "messageId": "1"}}


# ── Pub/Sub envelope decoding ─────────────────────────────────────────────────
def test_decodes_the_mailbox_and_history_id():
    env = _envelope({"emailAddress": "me@acme.com", "historyId": "987654"})
    assert push._decode_pubsub_message(env) == ("me@acme.com", "987654")


def test_history_id_is_returned_as_a_string():
    # Gmail sends it as a JSON number; the column and comparisons are textual.
    env = _envelope({"emailAddress": "me@acme.com", "historyId": 987654})
    assert push._decode_pubsub_message(env) == ("me@acme.com", "987654")


def test_tolerates_unpadded_base64():
    # Pub/Sub is inconsistent about padding; a strict b64decode would raise on
    # the unpadded form and take the receiver down for every message.
    payload = json.dumps({"emailAddress": "me@acme.com", "historyId": "5"}).encode()
    env = {"message": {"data": base64.b64encode(payload).decode().rstrip("=")}}
    assert push._decode_pubsub_message(env)[0] == "me@acme.com"


@pytest.mark.parametrize(
    "env",
    [
        {},
        {"message": {}},
        {"message": {"data": ""}},
        {"message": {"data": "!!!not base64!!!"}},
        {"message": None},
    ],
)
def test_malformed_envelopes_return_empty_rather_than_raising(env):
    # A malformed envelope must be ACKED, not retried: Pub/Sub redelivers on any
    # non-2xx, so raising here would loop the same dead message until it expires.
    assert push._decode_pubsub_message(env) == ("", "")


@pytest.mark.parametrize("inner", ["not json at all", "[1,2,3]", '"a string"', "null"])
def test_non_object_payloads_return_empty(inner):
    assert push._decode_pubsub_message(_envelope(inner)) == ("", "")


def test_payload_without_an_email_address_returns_empty():
    # Without a mailbox there is nothing to resolve a connection by.
    assert push._decode_pubsub_message(_envelope({"historyId": "5"})) == ("", "5")


# ── bearer extraction ─────────────────────────────────────────────────────────
class _Req:
    def __init__(self, headers: dict):
        self.headers = headers


@pytest.mark.parametrize(
    "header,expected",
    [
        ("Bearer abc.def.ghi", "abc.def.ghi"),
        ("bearer abc.def.ghi", "abc.def.ghi"),  # case-insensitive scheme
        ("BEARER abc.def.ghi", "abc.def.ghi"),
        ("Bearer   spaced  ", "spaced"),
    ],
)
def test_extracts_the_bearer_token(header, expected):
    assert push._bearer(_Req({"Authorization": header})) == expected


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": ""},
        {"Authorization": "Basic dXNlcjpwYXNz"},
        {"Authorization": "abc.def.ghi"},  # no scheme
    ],
)
def test_missing_or_wrong_scheme_yields_no_token(headers):
    # No token → _verify_google_oidc returns None → 401. Fail closed.
    assert push._bearer(_Req(headers)) == ""


# ── Google OIDC verification ──────────────────────────────────────────────────
async def test_empty_token_is_rejected_without_a_network_call(monkeypatch):
    def explode(*_a, **_kw):
        raise AssertionError("must not fetch JWKS for an absent token")

    monkeypatch.setattr(push._GOOGLE_JWKS, "get_signing_key_from_jwt", explode)
    assert await push._verify_google_oidc("") is None


async def test_a_garbage_token_is_rejected(monkeypatch):
    def boom(_token):
        raise ValueError("not a jwt")

    monkeypatch.setattr(push._GOOGLE_JWKS, "get_signing_key_from_jwt", boom)
    assert await push._verify_google_oidc("garbage") is None


async def test_verification_pins_the_audience_to_our_own_endpoint(monkeypatch):
    """THE security property.

    Google issues OIDC tokens for every project on its platform. A valid
    signature therefore proves only "Google signed this", not "this was meant
    for us" — so `aud` must be pinned to our push endpoint, or any Google
    customer could authenticate a forged mention.
    """
    from app.config import settings

    monkeypatch.setattr(settings, "public_base_url", "https://bliss.example")

    class _Key:
        key = "fake"

    monkeypatch.setattr(push._GOOGLE_JWKS, "get_signing_key_from_jwt", lambda _t: _Key())

    seen: dict = {}

    def fake_decode(_token, _key, **kw):
        seen.update(kw)
        return {"aud": kw.get("audience")}

    monkeypatch.setattr(push.jwt, "decode", fake_decode)

    await push._verify_google_oidc("tok")

    assert seen["audience"] == "https://bliss.example/ext/gmail/push"
    assert seen["algorithms"] == ["RS256"]  # never accept 'none' or HS256
    assert "accounts.google.com" in seen["issuer"]


async def test_a_wrong_audience_is_rejected(monkeypatch):
    class _Key:
        key = "fake"

    monkeypatch.setattr(push._GOOGLE_JWKS, "get_signing_key_from_jwt", lambda _t: _Key())

    def fake_decode(*_a, **_kw):
        # What PyJWT raises for an audience mismatch.
        raise Exception("Audience doesn't match")

    monkeypatch.setattr(push.jwt, "decode", fake_decode)
    assert await push._verify_google_oidc("tok") is None
