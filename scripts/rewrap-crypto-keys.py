#!/usr/bin/env python3
"""Re-key the at-rest column encryption: re-wrap every per-org DEK under a NEW
master KEK and recompute the email blind index under a NEW blind-index key.

WHEN TO USE
  * Rotating off a compromised / dev-default DATA_MASTER_PASSPHRASE/SALT or
    DATA_BLIND_INDEX_KEY (the original reason this exists — prod had shipped on
    the public dev defaults).
  * Any future master-secret rotation while staying on the "dev" KEK provider.
  (Moving to a KMS/Vault provider is a different path — see docs/OPERATIONS.md.)

WHY IT'S SAFE
  * The per-org DEK VALUE never changes — only its wrapping (under the KEK) is
    rewritten — so every *_enc column stays decryptable untouched. Only
    org_keys.wrapped_dek (all service DBs) and users.email_bidx (authdb) change.
  * --dry-run verifies the whole plan read-only. --apply runs each DB in ONE
    transaction with verify-before-commit and ROLLS BACK that DB on any failure.

USAGE (run from a container that has argon2/cryptography/asyncpg, e.g. auth-svc,
and can reach Postgres as the SUPERUSER over TLS):

  OLD_MASTER_PASSPHRASE=... OLD_MASTER_SALT=... OLD_BLIND_INDEX_KEY=... \
  NEW_MASTER_PASSPHRASE=... NEW_MASTER_SALT=... NEW_BLIND_INDEX_KEY=... \
  POSTGRES_USER=... POSTGRES_PASSWORD=... POSTGRES_HOST=postgres \
  python scripts/rewrap-crypto-keys.py --dry-run        # then --apply

OLD_* default to the public dev sentinels so the first rotation off them needs
only the NEW_* set. ALWAYS back up first (scripts/backup-db.sh) and run --dry-run
before --apply. After --apply, set the NEW_* values as DATA_* in the env and
recreate auth-svc/task-svc/messaging-svc so they use the new KEK.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import ssl
import struct
import sys

import asyncpg
from argon2.low_level import Type, hash_secret_raw
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# Argon2id KDF params — MUST match crypto.py (Python) and crypto.go (Go).
_KDF = dict(time_cost=3, memory_cost=64 * 1024, parallelism=4, hash_len=32, type=Type.ID)
_NONCE = 12
_HEADER = struct.Struct(">BH")  # format byte + key_version (uint16 BE)

OLD_PASSPHRASE = os.environ.get("OLD_MASTER_PASSPHRASE", "dev-master-passphrase-change-me")
OLD_SALT = os.environ.get("OLD_MASTER_SALT", "dev-master-salt-change-me-16+bytes")
OLD_BIK = os.environ.get("OLD_BLIND_INDEX_KEY", "dev-blind-index-key-change-me-32+bytes")
NEW_PASSPHRASE = os.environ["NEW_MASTER_PASSPHRASE"]
NEW_SALT = os.environ["NEW_MASTER_SALT"]
NEW_BIK = os.environ["NEW_BLIND_INDEX_KEY"]

# DBs holding org_keys. Extend if a new service adds column encryption.
DBS = os.environ.get("REWRAP_DBS", "authdb,taskdb,messagingdb").split(",")


def kek(passphrase: str, salt: str) -> bytes:
    return hash_secret_raw(passphrase.encode(), salt.encode(), **_KDF)


def unwrap(k: bytes, org_id: str, wrapped: bytes) -> bytes:
    wrapped = bytes(wrapped)
    return AESGCM(k).decrypt(wrapped[:_NONCE], wrapped[_NONCE:], org_id.encode())


def wrap(k: bytes, org_id: str, dek: bytes) -> bytes:
    n = os.urandom(_NONCE)
    return n + AESGCM(k).encrypt(n, dek, org_id.encode())


def col_decrypt(dek: bytes, org_id: str, blob: bytes) -> str:
    blob = bytes(blob)
    n = blob[_HEADER.size : _HEADER.size + _NONCE]
    return AESGCM(dek).decrypt(n, blob[_HEADER.size + _NONCE :], org_id.encode()).decode("utf-8")


def col_version(blob: bytes) -> int:
    return _HEADER.unpack(bytes(blob)[: _HEADER.size])[1]


def bidx(key32: bytes, value: str) -> bytes:
    return hmac.new(key32, value.strip().lower().encode("utf-8"), hashlib.sha256).digest()


async def connect(db: str) -> asyncpg.Connection:
    ctx = ssl.create_default_context(cafile=os.environ.get("PGSSLROOTCERT", "/etc/ssl/db/ca.crt"))
    return await asyncpg.connect(
        host=os.environ.get("POSTGRES_HOST", "postgres"),
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        user=os.environ["POSTGRES_USER"],
        password=os.environ["POSTGRES_PASSWORD"],
        database=db,
        ssl=ctx,
    )


async def migrate_db(db: str, apply: bool) -> None:
    old_k, new_k = kek(OLD_PASSPHRASE, OLD_SALT), kek(NEW_PASSPHRASE, NEW_SALT)
    old_bik = hashlib.sha256(OLD_BIK.encode()).digest()
    new_bik = hashlib.sha256(NEW_BIK.encode()).digest()
    conn = await connect(db)
    try:
        rows = await conn.fetch("SELECT org_id::text, key_version, wrapped_dek FROM org_keys")
        if not rows:
            print(f"  [{db}] no org_keys — skipped")
            return
        deks = {}
        for r in rows:
            dek = unwrap(old_k, r["org_id"], r["wrapped_dek"])
            deks[(r["org_id"], int(r["key_version"]))] = dek
            assert unwrap(new_k, r["org_id"], wrap(new_k, r["org_id"], dek)) == dek
        print(f"  [{db}] {len(rows)} org_keys verified under new KEK")

        has_users = bool(
            await conn.fetchval(
                "SELECT 1 FROM information_schema.tables WHERE table_name='users'"
            )
        )
        if has_users:
            for u in await conn.fetch("SELECT id::text, org_id::text, email_enc, email_bidx FROM users"):
                dek = deks[(u["org_id"], col_version(u["email_enc"]))]
                email = col_decrypt(dek, u["org_id"], u["email_enc"])
                assert hmac.compare_digest(bytes(u["email_bidx"]), bidx(old_bik, email)), (
                    f"user {u['id']}: stored bidx != OLD-key bidx"
                )
            print(f"  [{db}] user emails decrypted; old bidx verified")

        if not apply:
            print(f"  [{db}] DRY-RUN ok")
            return

        async with conn.transaction():
            for r in rows:
                dek = deks[(r["org_id"], int(r["key_version"]))]
                await conn.execute(
                    "UPDATE org_keys SET wrapped_dek=$1 WHERE org_id=$2 AND key_version=$3",
                    wrap(new_k, r["org_id"], dek), r["org_id"], r["key_version"],
                )
            if has_users:
                for u in await conn.fetch("SELECT id::text, org_id::text, email_enc FROM users"):
                    dek = deks[(u["org_id"], col_version(u["email_enc"]))]
                    email = col_decrypt(dek, u["org_id"], u["email_enc"])
                    await conn.execute(
                        "UPDATE users SET email_bidx=$1 WHERE id=$2", bidx(new_bik, email), u["id"]
                    )
            for r in await conn.fetch("SELECT org_id::text, key_version, wrapped_dek FROM org_keys"):
                assert unwrap(new_k, r["org_id"], r["wrapped_dek"]) == deks[
                    (r["org_id"], int(r["key_version"]))
                ], f"{db}: post-update DEK mismatch"
            print(f"  [{db}] APPLIED + verified-before-commit")
    finally:
        await conn.close()


async def main() -> int:
    apply = "--apply" in sys.argv
    if not apply and "--dry-run" not in sys.argv:
        print("specify --dry-run or --apply")
        return 2
    print(f"=== crypto re-wrap [{'APPLY' if apply else 'DRY-RUN'}] DBs={DBS} ===")
    for db in DBS:
        await migrate_db(db, apply)
    print("=== done ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
