"""Unit tests for JWKS publication, focusing on dual-kid key rotation.

Target: ``app.security.keys.jwks`` (+ ``_jwk_from_public`` shape).

Pure logic: we generate a throwaway Ed25519 keypair into a tmp dir and point
``settings`` / env vars at it. No DB, no network. The module memoizes key loads
with ``lru_cache``, so each test clears those caches to stay isolated.
"""
from __future__ import annotations

import base64

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.config import settings
from app.security import keys


# ── helpers ──────────────────────────────────────────────────────────────────
def _write_private_pem(path) -> Ed25519PrivateKey:
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    path.write_bytes(pem)
    return key


def _write_public_pem(path, private: Ed25519PrivateKey) -> None:
    pem = private.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    path.write_bytes(pem)


def _raw_x(private: Ed25519PrivateKey) -> str:
    raw = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _clear_key_caches() -> None:
    keys._load_private_key.cache_clear()
    keys._private_pem.cache_clear()
    keys._previous_public_jwk.cache_clear()


@pytest.fixture(autouse=True)
def _isolate_caches_and_env(monkeypatch: pytest.MonkeyPatch):
    """Each test starts with cold key caches and no rotation env vars."""
    monkeypatch.delenv("JWT_PUBLIC_KEY_PATH_PREVIOUS", raising=False)
    monkeypatch.delenv("JWT_KID_PREVIOUS", raising=False)
    _clear_key_caches()
    yield
    _clear_key_caches()


@pytest.fixture
def current_key(tmp_path, monkeypatch: pytest.MonkeyPatch) -> Ed25519PrivateKey:
    """Provision a current signing key on disk + wire settings to it."""
    priv_path = tmp_path / "ed25519_private.pem"
    private = _write_private_pem(priv_path)
    monkeypatch.setattr(settings, "jwt_private_key_path", str(priv_path))
    monkeypatch.setattr(settings, "jwt_kid", "current-kid")
    return private


# ── single (current) key ─────────────────────────────────────────────────────
def test_jwks_publishes_only_current_key_when_no_previous(
    current_key: Ed25519PrivateKey,
) -> None:
    result = keys.jwks()
    assert list(result.keys()) == ["keys"]
    assert len(result["keys"]) == 1
    jwk = result["keys"][0]
    assert jwk["kid"] == "current-kid"
    assert jwk["kty"] == "OKP"
    assert jwk["crv"] == "Ed25519"
    assert jwk["alg"] == "EdDSA"
    assert jwk["use"] == "sig"
    # ``x`` is the base64url (unpadded) raw public key.
    assert jwk["x"] == _raw_x(current_key)
    assert "=" not in jwk["x"]


# ── dual-kid rotation window ─────────────────────────────────────────────────
def test_jwks_includes_previous_key_when_env_set(
    current_key: Ed25519PrivateKey, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """During rotation both kids are published; previous comes from PEM + env."""
    prev_private = Ed25519PrivateKey.generate()
    prev_pub_path = tmp_path / "ed25519_public_prev.pem"
    _write_public_pem(prev_pub_path, prev_private)
    monkeypatch.setenv("JWT_PUBLIC_KEY_PATH_PREVIOUS", str(prev_pub_path))
    monkeypatch.setenv("JWT_KID_PREVIOUS", "previous-kid")
    _clear_key_caches()  # re-read env on next call

    result = keys.jwks()
    kids = {k["kid"] for k in result["keys"]}
    assert kids == {"current-kid", "previous-kid"}
    assert len(result["keys"]) == 2

    prev_jwk = next(k for k in result["keys"] if k["kid"] == "previous-kid")
    assert prev_jwk["x"] == _raw_x(prev_private)
    assert prev_jwk["alg"] == "EdDSA"


def test_jwks_omits_previous_when_only_path_set(
    current_key: Ed25519PrivateKey, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both env vars are required; a half-configured rotation publishes only
    the current key (no crash, no partial previous entry)."""
    prev_private = Ed25519PrivateKey.generate()
    prev_pub_path = tmp_path / "ed25519_public_prev.pem"
    _write_public_pem(prev_pub_path, prev_private)
    monkeypatch.setenv("JWT_PUBLIC_KEY_PATH_PREVIOUS", str(prev_pub_path))
    # JWT_KID_PREVIOUS intentionally NOT set.
    _clear_key_caches()

    result = keys.jwks()
    assert len(result["keys"]) == 1
    assert result["keys"][0]["kid"] == "current-kid"


def test_jwks_omits_previous_when_only_kid_set(
    current_key: Ed25519PrivateKey, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("JWT_KID_PREVIOUS", "previous-kid")
    # JWT_PUBLIC_KEY_PATH_PREVIOUS intentionally NOT set.
    _clear_key_caches()

    result = keys.jwks()
    assert len(result["keys"]) == 1
    assert result["keys"][0]["kid"] == "current-kid"


def test_jwks_dedupes_previous_when_kid_matches_current(
    current_key: Ed25519PrivateKey, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the previous kid equals the current kid, it is NOT published twice."""
    prev_private = Ed25519PrivateKey.generate()
    prev_pub_path = tmp_path / "ed25519_public_prev.pem"
    _write_public_pem(prev_pub_path, prev_private)
    monkeypatch.setenv("JWT_PUBLIC_KEY_PATH_PREVIOUS", str(prev_pub_path))
    monkeypatch.setenv("JWT_KID_PREVIOUS", "current-kid")  # same as current
    _clear_key_caches()

    result = keys.jwks()
    assert len(result["keys"]) == 1
    assert result["keys"][0]["kid"] == "current-kid"
