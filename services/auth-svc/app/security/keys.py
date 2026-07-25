"""Ed25519 signing key + JWKS publication and access-token minting."""
from __future__ import annotations

import base64
import os
import time
import uuid
from functools import lru_cache
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

from ..config import settings


def _b64url_no_pad(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


@lru_cache(maxsize=1)
def _load_private_key() -> Ed25519PrivateKey:
    with open(settings.jwt_private_key_path, "rb") as f:
        key = serialization.load_pem_private_key(f.read(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise RuntimeError("JWT_PRIVATE_KEY_PATH is not an Ed25519 private key")
    return key


@lru_cache(maxsize=1)
def _private_pem() -> bytes:
    return _load_private_key().private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def _public_key() -> Ed25519PublicKey:
    return _load_private_key().public_key()


def _jwk_from_public(pub: Ed25519PublicKey, kid: str) -> dict[str, Any]:
    raw = pub.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": _b64url_no_pad(raw),
        "kid": kid,
        "alg": "EdDSA",
        "use": "sig",
    }


@lru_cache(maxsize=1)
def _previous_public_jwk() -> dict[str, Any] | None:
    """Optional PREVIOUS public key, published alongside the current one to allow
    ZERO-DOWNTIME key rotation. Rollover procedure (see docs/OPERATIONS.md):

      1. Generate a new keypair. Deploy it as JWT_PRIVATE_KEY_PATH / JWT_KID
         (new tokens now sign with the new kid) AND set the OLD public key here
         via JWT_PUBLIC_KEY_PATH_PREVIOUS / JWT_KID_PREVIOUS.
      2. JWKS now publishes BOTH kids, so tokens signed just before the rollover
         still verify until they expire (access TTL + verifier JWKS cache TTL).
      3. After that window, remove the two _PREVIOUS env vars in a follow-up
         deploy. No request ever sees an unverifiable token.

    Returns None when not mid-rotation (the common case)."""
    path = os.getenv("JWT_PUBLIC_KEY_PATH_PREVIOUS")
    kid = os.getenv("JWT_KID_PREVIOUS")
    if not path or not kid:
        return None
    with open(path, "rb") as f:
        pub = serialization.load_pem_public_key(f.read())
    if not isinstance(pub, Ed25519PublicKey):
        raise RuntimeError("JWT_PUBLIC_KEY_PATH_PREVIOUS is not an Ed25519 public key")
    return _jwk_from_public(pub, kid)


def jwks() -> dict[str, Any]:
    """OKP/Ed25519 JWK set served at /.well-known/jwks.json. Publishes the current
    signing key, plus the previous key during an overlapping rotation window."""
    keys = [_jwk_from_public(_public_key(), settings.jwt_kid)]
    prev = _previous_public_jwk()
    if prev is not None and prev["kid"] != settings.jwt_kid:
        keys.append(prev)
    return {"keys": keys}


def mint_access_token(
    *, user_id: str, org_id: str, roles: list[str], username: str, plan: str = "free"
) -> tuple[str, int]:
    """Return (signed JWT, expires_in_seconds)."""
    now = int(time.time())
    ttl = settings.jwt_access_ttl_seconds
    claims = {
        "sub": user_id,
        "org_id": org_id,
        "roles": roles,
        "username": username,
        # Org plan entitlement — services gate enterprise-only features on this.
        "plan": plan,
        "jti": str(uuid.uuid4()),
        "iss": settings.jwt_issuer,
        "iat": now,
        "exp": now + ttl,
    }
    token = jwt.encode(
        claims,
        _private_pem(),
        algorithm="EdDSA",
        headers={"kid": settings.jwt_kid},
    )
    return token, ttl
