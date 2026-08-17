"""Application-layer at-rest column encryption (server-readable, transparent).

The service holds the keys and decrypts in-process, so search / previews /
notifications / offline-email all keep working — this is NOT client-side E2E.

Design (see the security plan):
  * AES-256-GCM with a random 96-bit nonce per encryption; AAD = org_id (a row
    copied into another org won't decrypt).
  * Envelope encryption: a per-ORG 32-byte Data Encryption Key (DEK), wrapped by
    a Key Encryption Key (KEK) and stored (wrapped) in the per-service `org_keys`
    table. Per-org DEKs enable crypto-shredding (delete the row -> unreadable).
  * Self-describing ciphertext: ``0x01 || key_version(uint16 BE) || nonce(12) ||
    AES-GCM(ct||tag)``. Embedding key_version makes DEK rotation lazy.
  * KEK provider is pluggable: DEV derives the KEK from a passphrase via Argon2id
    (honoring "use Argon2" as the KDF — Argon2 is not a cipher); PROD uses a
    KMS/Vault interface.
  * Blind index: ``HMAC-SHA256(static_key, lower(strip(value)))`` for equality
    lookup on encrypted columns (e.g. login by email) — matches citext semantics.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import os
import struct
import time
from typing import Protocol

from argon2.low_level import Type, hash_secret_raw
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

_FMT_V1 = 0x01
_NONCE_LEN = 12
_HEADER = struct.Struct(">BH")  # format byte + key_version (uint16 BE)

# Argon2id KDF parameters for the DEV master KEK. Pinned (and mirrored in the Go
# services) so a passphrase deterministically yields the same KEK across restarts
# and languages. DEV/TEST only — prod wraps DEKs via KMS/Vault.
_KDF_TIME_COST = 3
_KDF_MEMORY_KIB = 64 * 1024  # 64 MiB
_KDF_PARALLELISM = 4
_KDF_LEN = 32


class CryptoError(Exception):
    """Raised on a decrypt/unwrap failure (fail closed — never return plaintext)."""


# ── KEK providers ────────────────────────────────────────────────────────────
class KEKProvider(Protocol):
    """Wraps/unwraps a per-org DEK. ``version`` lets the KEK itself rotate.

    ``blocking`` declares whether wrap/unwrap perform NETWORK I/O. It exists so
    the Cryptor can push a provider that does off the event loop — see
    ``Cryptor._wrap``/``_unwrap``. Getting it wrong in the False direction
    stalls every request the pod is serving; in the True direction it costs a
    pointless thread hop, so the safe default for a new provider is True.
    """

    blocking: bool

    def wrap(self, org_id: str, dek: bytes) -> tuple[bytes, int]: ...
    def unwrap(self, org_id: str, wrapped: bytes, version: int) -> bytes: ...


class DevKEKProvider:
    """Local/dev KEK: a single master key derived from a passphrase via Argon2id.

    The wrapped DEK is ``nonce(12) || AES-256-GCM(dek)`` under the master KEK, with
    AAD = org_id. NOT for production — prod uses KMSKEKProvider.
    """

    # Pure CPU: an AES-GCM operation on 32 bytes, measured in microseconds. It
    # would cost more to hand to a thread than to run inline.
    blocking = False

    def __init__(self, passphrase: str, salt: bytes, version: int = 1) -> None:
        if not passphrase or len(salt) < 16:
            raise CryptoError("DATA_MASTER_PASSPHRASE/SALT not configured")
        self._kek = hash_secret_raw(
            passphrase.encode("utf-8"),
            salt,
            time_cost=_KDF_TIME_COST,
            memory_cost=_KDF_MEMORY_KIB,
            parallelism=_KDF_PARALLELISM,
            hash_len=_KDF_LEN,
            type=Type.ID,
        )
        self._version = version

    def wrap(self, org_id: str, dek: bytes) -> tuple[bytes, int]:
        nonce = os.urandom(_NONCE_LEN)
        ct = AESGCM(self._kek).encrypt(nonce, dek, org_id.encode("utf-8"))
        return nonce + ct, self._version

    def unwrap(self, org_id: str, wrapped: bytes, version: int) -> bytes:
        try:
            nonce, ct = wrapped[:_NONCE_LEN], wrapped[_NONCE_LEN:]
            return AESGCM(self._kek).decrypt(nonce, ct, org_id.encode("utf-8"))
        except Exception as exc:  # noqa: BLE001 — fail closed
            raise CryptoError("DEK unwrap failed") from exc


class KMSKEKProvider:
    """Production KEK via an external KMS. Backend ``vault-transit`` is WIRED
    (HashiCorp Vault Transit secrets engine — the master key never leaves Vault);
    ``aws-kms``/``gcp-kms`` raise NotImplemented until wired.

    The wrapped DEK we store is Vault's self-describing ``vault:vN:...`` ciphertext
    string, so a Vault-side KEK rotation is transparent on decrypt.

    The HTTP call is synchronous, and the per-org DEK cache means it runs only on
    a cache miss / rotation rather than per query — but "rare" is not "safe" on a
    single-worker event loop. A pod serving many orgs misses regularly, and a
    Vault that is merely SLOW then blocks the loop for up to the timeout on each
    miss, stalling every unrelated request the pod is handling. That is why
    ``blocking`` is set and the Cryptor dispatches these to a thread.
    """

    def __init__(
        self,
        backend: str,
        key_id: str,
        vault_addr: str = "",
        vault_token: str = "",
        version: int = 1,
    ) -> None:
        if not key_id:
            raise CryptoError("DATA_KMS_KEY_ID must be set when DATA_KEK_PROVIDER=kms")
        if backend != "vault-transit":
            raise CryptoError(
                f"KMS backend {backend!r} not wired — use vault-transit "
                "(or implement aws-kms/gcp-kms)"
            )
        if not vault_addr or not vault_token:
            raise CryptoError("VAULT_ADDR and VAULT_TOKEN are required for vault-transit")
        self._backend = backend
        self._key = key_id
        self._addr = vault_addr.rstrip("/")
        self._token = vault_token
        self._version = version

    # Network I/O. The Cryptor runs wrap/unwrap on a worker thread because of
    # this flag; see Cryptor._unwrap for why that matters more than it looks.
    blocking = True

    def _client(self):
        """One pooled client for the process, built on first use.

        `httpx.post` (the module-level helper) opens a NEW connection, does a
        TLS handshake and closes it, every single call. Against Vault that is
        an extra round trip plus a handshake on the path that a DEK cache miss
        already makes a user wait for. A shared Client keeps the connection
        alive between calls.

        Built lazily and cached on the instance: importing httpx at module
        scope would load it for every deployment, and only the KMS path needs
        it. `httpx.Client` is thread-safe, which is the precondition for
        handing it to `asyncio.to_thread` from several requests at once.
        """
        client = getattr(self, "_http", None)
        if client is None:
            import httpx  # lazy: only imported when KMS is actually selected

            client = httpx.Client(
                timeout=5.0,
                # Small: this is only touched on a DEK cache miss, and an
                # unbounded pool against a KEK service is a way to turn a Vault
                # slowdown into a connection storm.
                limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
            )
            self._http = client
        return client

    def _transit(self, op: str, payload: dict) -> dict:
        """One Vault Transit call. SYNCHRONOUS BY DESIGN — see the class note.

        This must only ever be reached from a worker thread (Cryptor dispatches
        via asyncio.to_thread when `blocking` is set). Calling it directly from
        a coroutine blocks the event loop for up to the 5s timeout, which on a
        one-worker uvicorn stalls every other in-flight request on the pod —
        turning a slow Vault into a total outage of unrelated traffic.
        """
        try:
            resp = self._client().post(
                f"{self._addr}/v1/transit/{op}/{self._key}",
                json=payload,
                headers={"X-Vault-Token": self._token},
            )
            resp.raise_for_status()
            return resp.json()["data"]
        except Exception as exc:  # noqa: BLE001 — fail closed; never leak token/DEK
            raise CryptoError(f"vault transit/{op} failed") from exc

    def wrap(self, org_id: str, dek: bytes) -> tuple[bytes, int]:
        data = self._transit("encrypt", {"plaintext": base64.b64encode(dek).decode("ascii")})
        return data["ciphertext"].encode("utf-8"), self._version

    def unwrap(self, org_id: str, wrapped: bytes, version: int) -> bytes:
        data = self._transit("decrypt", {"ciphertext": bytes(wrapped).decode("utf-8")})
        return base64.b64decode(data["plaintext"])


# ── Cryptor ──────────────────────────────────────────────────────────────────
class Cryptor:
    """Transparent column encryptor. Methods take the active DB ``conn`` so the
    per-org DEK can be loaded/created from ``org_keys`` (cached after first use).
    """

    def __init__(self, kek: KEKProvider, blind_index_key: bytes, cache_ttl: float = 300.0) -> None:
        if len(blind_index_key) < 32:
            raise CryptoError("DATA_BLIND_INDEX_KEY must be >= 32 bytes")
        self._kek = kek
        self._bidx_key = blind_index_key
        self._ttl = cache_ttl
        self._dek_cache: dict[tuple[str, int], tuple[bytes, float]] = {}
        self._current: dict[str, tuple[bytes, int, float]] = {}  # org -> (dek, version, expiry)
        self._locks: dict[str, asyncio.Lock] = {}

    # blind index is pure (no DB / no DEK) so it's usable pre-org-context (login).
    def blind_index(self, value: str) -> bytes:
        norm = value.strip().lower().encode("utf-8")
        return hmac.new(self._bidx_key, norm, hashlib.sha256).digest()

    # ── Keeping KEK I/O off the event loop ───────────────────────────────────
    #
    # These services run ONE uvicorn worker, so there is one event loop per pod.
    # A synchronous HTTP call from a coroutine does not merely make that request
    # slow — it stalls every other in-flight request on the pod: health probes,
    # token refreshes, unrelated reads, all of them queued behind a Vault round
    # trip. If Vault is slow rather than down, each DEK cache miss blocks for up
    # to the 5s timeout, which is enough to make a pod serve nothing at all. A
    # degraded dependency becomes a total outage of unrelated traffic.
    #
    # `asyncio.to_thread` is the same tool the Argon2 hashing already uses, for
    # the same reason and with the same shape. The dispatch is conditional on
    # the provider declaring `blocking`, so the dev provider — a microsecond of
    # AES-GCM — stays inline rather than paying a thread hop it does not need.
    #
    # LATENT UNTIL KMS IS TURNED ON: DATA_KEK_PROVIDER defaults to `dev`, so
    # this path does not run today. It is fixed now precisely because it would
    # otherwise be discovered by enabling KMS in production.

    async def _wrap(self, org_id: str, dek: bytes) -> tuple[bytes, int]:
        if getattr(self._kek, "blocking", True):
            return await asyncio.to_thread(self._kek.wrap, org_id, dek)
        return self._kek.wrap(org_id, dek)

    async def _unwrap(self, org_id: str, wrapped: bytes, version: int) -> bytes:
        if getattr(self._kek, "blocking", True):
            return await asyncio.to_thread(self._kek.unwrap, org_id, wrapped, version)
        return self._kek.unwrap(org_id, wrapped, version)

    async def encrypt(self, conn: AsyncConnection, org_id: str, plaintext: str | None) -> bytes | None:
        if plaintext is None:
            return None
        dek, version = await self._current_dek(conn, org_id)
        nonce = os.urandom(_NONCE_LEN)
        ct = AESGCM(dek).encrypt(nonce, plaintext.encode("utf-8"), org_id.encode("utf-8"))
        return _HEADER.pack(_FMT_V1, version) + nonce + ct

    async def decrypt(self, conn: AsyncConnection, org_id: str, blob: bytes | None) -> str | None:
        if blob is None:
            return None
        if isinstance(blob, memoryview):
            blob = bytes(blob)
        if len(blob) < _HEADER.size + _NONCE_LEN:
            raise CryptoError("ciphertext too short")
        fmt, version = _HEADER.unpack(blob[: _HEADER.size])
        if fmt != _FMT_V1:
            raise CryptoError(f"unknown ciphertext format {fmt}")
        nonce = blob[_HEADER.size : _HEADER.size + _NONCE_LEN]
        ct = blob[_HEADER.size + _NONCE_LEN :]
        dek = await self._dek_for_version(conn, org_id, version)
        try:
            return AESGCM(dek).decrypt(nonce, ct, org_id.encode("utf-8")).decode("utf-8")
        except Exception as exc:  # noqa: BLE001 — fail closed
            raise CryptoError("decrypt failed") from exc

    # ── DEK management (org_keys) ────────────────────────────────────────────
    def _lock(self, org_id: str) -> asyncio.Lock:
        lk = self._locks.get(org_id)
        if lk is None:
            lk = self._locks[org_id] = asyncio.Lock()
        return lk

    async def _current_dek(self, conn: AsyncConnection, org_id: str) -> tuple[bytes, int]:
        now = time.monotonic()
        cached = self._current.get(org_id)
        if cached and cached[2] > now:
            return cached[0], cached[1]
        async with self._lock(org_id):  # single-flight: avoid a cold-cache stampede
            cached = self._current.get(org_id)
            if cached and cached[2] > time.monotonic():
                return cached[0], cached[1]
            row = (
                await conn.execute(
                    text(
                        "SELECT key_version, wrapped_dek FROM org_keys "
                        "WHERE org_id = :o AND retired_at IS NULL "
                        "ORDER BY key_version DESC LIMIT 1"
                    ),
                    {"o": org_id},
                )
            ).first()
            if row is None:
                dek, version = await self._generate_dek(conn, org_id)
            else:
                version = int(row.key_version)
                dek = await self._unwrap(org_id, bytes(row.wrapped_dek), version)
            expiry = time.monotonic() + self._ttl
            self._current[org_id] = (dek, version, expiry)
            self._dek_cache[(org_id, version)] = (dek, expiry)
            return dek, version

    async def _dek_for_version(self, conn: AsyncConnection, org_id: str, version: int) -> bytes:
        now = time.monotonic()
        hit = self._dek_cache.get((org_id, version))
        if hit and hit[1] > now:
            return hit[0]
        row = (
            await conn.execute(
                text("SELECT wrapped_dek FROM org_keys WHERE org_id = :o AND key_version = :v"),
                {"o": org_id, "v": version},
            )
        ).first()
        if row is None:
            raise CryptoError(f"no DEK for org {org_id} version {version} (crypto-shredded?)")
        dek = await self._unwrap(org_id, bytes(row.wrapped_dek), version)
        self._dek_cache[(org_id, version)] = (dek, time.monotonic() + self._ttl)
        return dek

    async def _generate_dek(self, conn: AsyncConnection, org_id: str) -> tuple[bytes, int]:
        dek = os.urandom(32)
        version = 1
        wrapped, _kek_ver = await self._wrap(org_id, dek)
        await conn.execute(
            text(
                "INSERT INTO org_keys (org_id, key_version, wrapped_dek) "
                "VALUES (:o, :v, :w) ON CONFLICT (org_id, key_version) DO NOTHING"
            ),
            {"o": org_id, "v": version, "w": wrapped},
        )
        # Re-read to win any race: another tx may have inserted the canonical row.
        row = (
            await conn.execute(
                text("SELECT key_version, wrapped_dek FROM org_keys WHERE org_id = :o AND key_version = :v"),
                {"o": org_id, "v": version},
            )
        ).first()
        if row is None:
            return dek, version  # our INSERT is in-flight in this same tx
        return await self._unwrap(org_id, bytes(row.wrapped_dek), int(row.key_version)), int(row.key_version)

    async def rotate_dek(self, conn: AsyncConnection, org_id: str) -> tuple[int, int]:
        """Rotate the org's DEK: create a new generation and retire the current one.
        Rotation is LAZY — existing ciphertext keeps decrypting via its embedded
        key_version (old DEK rows are retained, just marked retired); only NEW writes
        use the new DEK. Returns (old_version, new_version)."""
        async with self._lock(org_id):
            cur = (
                await conn.execute(
                    text(
                        "SELECT key_version FROM org_keys WHERE org_id = :o "
                        "AND retired_at IS NULL ORDER BY key_version DESC LIMIT 1"
                    ),
                    {"o": org_id},
                )
            ).first()
            max_v = (
                await conn.execute(
                    text("SELECT COALESCE(MAX(key_version), 0) FROM org_keys WHERE org_id = :o"),
                    {"o": org_id},
                )
            ).scalar()
            old_version = int(cur.key_version) if cur is not None else 0
            new_version = int(max_v) + 1
            new_dek = os.urandom(32)
            wrapped, _ = await self._wrap(org_id, new_dek)
            await conn.execute(
                text(
                    "INSERT INTO org_keys (org_id, key_version, wrapped_dek) VALUES (:o, :v, :w)"
                ),
                {"o": org_id, "v": new_version, "w": wrapped},
            )
            if cur is not None:
                await conn.execute(
                    text(
                        "UPDATE org_keys SET retired_at = now() "
                        "WHERE org_id = :o AND key_version = :v AND retired_at IS NULL"
                    ),
                    {"o": org_id, "v": old_version},
                )
            # Bust caches so the next encrypt picks up the new generation.
            self._current.pop(org_id, None)
            self._dek_cache[(org_id, new_version)] = (new_dek, time.monotonic() + self._ttl)
            return old_version, new_version


# ── Process singleton ────────────────────────────────────────────────────────
_cryptor: Cryptor | None = None


def build_cryptor(settings) -> Cryptor:
    """Construct the Cryptor from settings (called once at startup)."""
    if settings.data_kek_provider == "kms":
        kek: KEKProvider = KMSKEKProvider(
            settings.data_kms_backend,
            settings.data_kms_key_id,
            settings.vault_addr,
            settings.vault_token,
            settings.data_kek_version,
        )
    else:
        salt = settings.data_master_salt.encode("utf-8")
        kek = DevKEKProvider(settings.data_master_passphrase, salt, settings.data_kek_version)
    bidx_key = hashlib.sha256(settings.data_blind_index_key.encode("utf-8")).digest()
    return Cryptor(kek, bidx_key, settings.data_dek_cache_ttl_seconds)


def init_cryptor(settings) -> Cryptor:
    global _cryptor
    _cryptor = build_cryptor(settings)
    return _cryptor


def cryptor() -> Cryptor:
    if _cryptor is None:
        raise CryptoError("cryptor not initialized")
    return _cryptor
