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


# ── Batch decrypt: peek_version / decrypt_batch_cached ──────────────────────
#
# Both are connection-free by design (see crypto.py's "Batch decrypt" section
# comment), so — unlike encrypt()/decrypt()/warm_dek_versions(), which need
# org_keys and are exercised by task-svc's tests/integration/test_inbox_batch_
# decrypt.py against a real Postgres — these are testable here without a DB:
# decrypt_batch_cached only ever reads Cryptor's in-process _dek_cache dict,
# which this file seeds directly with a real DEK from the real KEK provider.


def _cryptor():
    return crypto.Cryptor(_kek(), b"x" * 32)


def _seed_cache(c, org_id: str, version: int, dek: bytes):
    import time

    c._dek_cache[(org_id, version)] = (dek, time.monotonic() + 300)


def _AESGCM_blob(dek: bytes, org_id: str, version: int, plaintext: str) -> bytes:
    """Build a ciphertext blob in exactly decrypt()/decrypt_batch_cached's wire
    format (see crypto.py: 0x01 || key_version(u16 BE) || nonce(12) || ct||tag,
    AAD=org_id), without going through Cryptor.encrypt — that needs a DB conn
    to look up the CURRENT version, whereas these tests choose an arbitrary
    one directly to exercise multi-version batches and rotation."""
    import struct

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(12)
    ct = AESGCM(dek).encrypt(nonce, plaintext.encode("utf-8"), org_id.encode("utf-8"))
    return struct.Struct(">BH").pack(0x01, version) + nonce + ct


def test_peek_version_reads_the_embedded_version_without_decrypting():
    dek = os.urandom(32)
    blob = _AESGCM_blob(dek, ORG_A, 7, "hello")
    assert _cryptor().peek_version(blob) == 7


def test_peek_version_of_a_null_blob_is_none():
    assert _cryptor().peek_version(None) is None


def test_peek_version_rejects_a_too_short_blob():
    with pytest.raises(crypto.CryptoError):
        _cryptor().peek_version(b"\x01\x00")


def test_peek_version_rejects_an_unknown_format_byte():
    dek = os.urandom(32)
    blob = bytearray(_AESGCM_blob(dek, ORG_A, 1, "hello"))
    blob[0] = 0x02  # only format 0x01 is defined
    with pytest.raises(crypto.CryptoError):
        _cryptor().peek_version(bytes(blob))


def test_decrypt_batch_cached_round_trips_a_warm_batch():
    c = _cryptor()
    dek = os.urandom(32)
    _seed_cache(c, ORG_A, 1, dek)
    blobs = [
        _AESGCM_blob(dek, ORG_A, 1, "first"),
        _AESGCM_blob(dek, ORG_A, 1, "second"),
        None,  # a null column (e.g. an unreviewed task's review_enc)
    ]
    assert c.decrypt_batch_cached(ORG_A, blobs) == ["first", "second", None]


def test_decrypt_batch_cached_resolves_each_blob_against_its_own_version():
    """A batch spanning a DEK rotation must decrypt each item under the
    key_version embedded in THAT item, not the last one warmed."""
    c = _cryptor()
    dek_v1, dek_v2 = os.urandom(32), os.urandom(32)
    _seed_cache(c, ORG_A, 1, dek_v1)
    _seed_cache(c, ORG_A, 2, dek_v2)
    blobs = [
        _AESGCM_blob(dek_v1, ORG_A, 1, "old"),
        _AESGCM_blob(dek_v2, ORG_A, 2, "new"),
    ]
    assert c.decrypt_batch_cached(ORG_A, blobs) == ["old", "new"]


def test_decrypt_batch_cached_fails_closed_on_a_cold_version():
    """The whole point of the peek_version/warm_dek_versions split is that
    decrypt_batch_cached NEVER reaches for the database — a version nobody
    warmed must raise, not silently fetch it."""
    c = _cryptor()
    blob = _AESGCM_blob(os.urandom(32), ORG_A, 1, "never warmed")
    with pytest.raises(crypto.CryptoError):
        c.decrypt_batch_cached(ORG_A, [blob])


def test_decrypt_batch_cached_fails_closed_on_tampered_ciphertext():
    c = _cryptor()
    dek = os.urandom(32)
    _seed_cache(c, ORG_A, 1, dek)
    blob = bytearray(_AESGCM_blob(dek, ORG_A, 1, "hello"))
    blob[-1] ^= 0xFF  # flip a byte inside the GCM tag
    with pytest.raises(crypto.CryptoError):
        c.decrypt_batch_cached(ORG_A, [bytes(blob)])


def test_decrypt_batch_cached_rejects_a_ciphertext_replayed_into_another_org():
    """org_id is the AEAD AAD (see decrypt()/encrypt()) — decrypt_batch_cached
    must honour that too, since it reimplements decrypt()'s crypto inline
    rather than calling it."""
    c = _cryptor()
    dek = os.urandom(32)
    _seed_cache(c, ORG_A, 1, dek)
    _seed_cache(c, ORG_B, 1, dek)  # same DEK bytes under both orgs' cache keys
    blob = _AESGCM_blob(dek, ORG_A, 1, "hello")
    with pytest.raises(crypto.CryptoError):
        c.decrypt_batch_cached(ORG_B, [blob])
