"""Security tests for the at-rest encryption primitives (``crypto``).

Covers the KEK envelope, blind index, and fail-closed behaviour WITHOUT a DB
(the per-org DEK management / column round-trip is exercised by the integration
suite and was validated by the live re-key migration). What matters here:

  * DEK wrap/unwrap round-trips under the same KEK.
  * org_id is the AEAD AAD — unwrapping a DEK under the WRONG org fails closed.
  * a DIFFERENT master passphrase/salt yields a different KEK that cannot unwrap.
  * blind index is deterministic, normalises case/whitespace, and differs per value.
  * KMS provider construction fails closed on missing/invalid config.

Skips cleanly if argon2/cryptography aren't installed in a bare interpreter.
"""
from __future__ import annotations

import os

import pytest

crypto = pytest.importorskip(
    "crypto",
    reason="deps (argon2/cryptography) not installed locally; CI installs requirements-dev.txt.",
)

SALT = "unit-test-salt-0123456789abcdef"  # >= 16 bytes
ORG_A = "00000000-0000-0000-0000-00000000000a"
ORG_B = "00000000-0000-0000-0000-00000000000b"


def _kek(passphrase="unit-test-passphrase", salt=SALT):
    return crypto.DevKEKProvider(passphrase, salt.encode("utf-8"), 1)


def test_dek_wrap_unwrap_roundtrip():
    kek = _kek()
    dek = os.urandom(32)
    wrapped, version = kek.wrap(ORG_A, dek)
    assert version == 1
    assert wrapped != dek
    assert kek.unwrap(ORG_A, wrapped, version) == dek


def test_unwrap_under_wrong_org_fails_closed():
    kek = _kek()
    wrapped, version = kek.wrap(ORG_A, os.urandom(32))
    # org_id is the AAD: a DEK row copied into another org must NOT unwrap.
    with pytest.raises(crypto.CryptoError):
        kek.unwrap(ORG_B, wrapped, version)


def test_different_master_secret_cannot_unwrap():
    dek = os.urandom(32)
    wrapped, version = _kek().wrap(ORG_A, dek)
    with pytest.raises(crypto.CryptoError):
        _kek(passphrase="a-totally-different-passphrase").unwrap(ORG_A, wrapped, version)
    with pytest.raises(crypto.CryptoError):
        _kek(salt="a-totally-different-salt-0123456789").unwrap(ORG_A, wrapped, version)


def test_devkek_requires_configured_secrets():
    with pytest.raises(crypto.CryptoError):
        crypto.DevKEKProvider("", SALT.encode(), 1)
    with pytest.raises(crypto.CryptoError):
        crypto.DevKEKProvider("pp", b"too-short", 1)  # salt < 16 bytes


def test_blind_index_deterministic_and_normalised():
    c = crypto.Cryptor(_kek(), b"x" * 32)
    assert c.blind_index("User@Example.com") == c.blind_index("  user@example.com  ")
    assert c.blind_index("a@b.com") != c.blind_index("c@d.com")
    assert len(c.blind_index("a@b.com")) == 32  # HMAC-SHA256


def test_blind_index_key_must_be_long_enough():
    with pytest.raises(crypto.CryptoError):
        crypto.Cryptor(_kek(), b"short")


def test_kms_provider_fails_closed_on_bad_config():
    with pytest.raises(crypto.CryptoError):
        crypto.KMSKEKProvider("vault-transit", "", "https://v", "tok", 1)  # no key id
    with pytest.raises(crypto.CryptoError):
        crypto.KMSKEKProvider("aws-kms", "k", "", "", 1)  # backend not wired
    with pytest.raises(crypto.CryptoError):
        crypto.KMSKEKProvider("vault-transit", "k", "", "", 1)  # missing vault addr/token
