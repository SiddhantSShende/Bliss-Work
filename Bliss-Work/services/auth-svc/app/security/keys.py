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


# How many memberships the `memberships` claim will carry. See mint_access_token.
#
# A bound, not a guess at how many orgs anyone has. The claim rides in an
# Authorization header on every request to every service, and each entry is two
# uuids — so an unbounded list turns a pathological account into oversized
# headers platform-wide. Twenty-four is far above any real roster and still
# under 2 KB of claim.
MAX_PRESENCE_MEMBERSHIPS = 24


def mint_access_token(
    *,
    user_id: str,
    org_id: str,
    roles: list[str],
    username: str,
    plan: str = "free",
    memberships: list[dict] | None = None,
    session_id: str | None = None,
    ttl_seconds: int | None = None,
) -> tuple[str, int]:
    """Return (signed JWT, expires_in_seconds).

    `memberships` is every ACTIVE membership this person's identity holds, as
    ``[{"o": org_id, "u": user_id}, ...]`` including the current one. It exists
    for one consumer: ws-gateway marks a connected person online in all of their
    organizations at once, and it cannot ask a database — it holds only Redis and
    this token. See services/ws-gateway/internal/server/conn.go.

    Short keys because this is repeated per org on every request; "o"/"u" rather
    than "orgId"/"userId" saves ~10 bytes an entry for no loss of meaning at the
    one place that reads it.

    NOT an authorization claim. Nothing grants access on the strength of it —
    the org a request acts in is still `org_id` alone, and every service checks
    membership its own way. It is routing metadata for presence, and it is
    deliberately additive: a token minted without it (an older one, or a path
    that could not resolve the list) still works, and the gateway falls back to
    the single current membership.

    `session_id` is the refresh-token family this access token was minted
    alongside (service.build_session / rotate_refresh_token) — the same id
    routes/sessions.py exposes as a session's `id`. Also additive/optional and
    also not an authorization claim: it exists solely so ws-gateway can
    associate a live WebSocket with the session that opened it, and force-close
    it when that session is revoked (see services/ws-gateway/internal/events).
    Omitted when unknown for the same reason `memberships` is — a caller that
    cannot resolve it (there is none today, but the shape matches) still mints
    a valid, just less precisely revocable, token.
    """
    now = int(time.time())
    # Overridable per-mint: routes/super_admin.py has no refresh token to rotate
    # against (no `users` row to key one on), so its tokens use a longer TTL than
    # the org-session default. Omitted (the common case) keeps today's behavior.
    ttl = ttl_seconds if ttl_seconds is not None else settings.jwt_access_ttl_seconds
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
    # Omitted entirely when empty rather than sent as [], so a token from a path
    # that could not resolve memberships is indistinguishable from a pre-claim
    # one and takes the same fallback.
    if memberships:
        claims["memberships"] = memberships[:MAX_PRESENCE_MEMBERSHIPS]
    if session_id:
        claims["sid"] = session_id
    token = jwt.encode(
        claims,
        _private_pem(),
        algorithm="EdDSA",
        headers={"kid": settings.jwt_kid},
    )
    return token, ttl
