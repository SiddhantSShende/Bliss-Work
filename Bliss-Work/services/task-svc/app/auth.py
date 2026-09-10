from __future__ import annotations

from dataclasses import dataclass

import httpx
import jwt
import structlog
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import Depends, HTTPException, Header, Request, status

from .config import settings
from .logging_setup import log
from jwks_auth import JwksCache
from resilience import CircuitOpenError

_JWKS_TTL = 300  # cache JWKS ~5 minutes

# Short bounded per-attempt timeout (was a single 5s with no retry); up to 3
# retries on transient failures + a breaker that fails fast for a cooldown once
# the JWKS endpoint has been failing, so a down auth-svc degrades to fast 503s
# instead of every request blocking on the timeout (cascade).
_JWKS_TIMEOUT = 3.0
_JWKS_ATTEMPTS = 3
# Minimum gap between refreshes forced by a cache miss (unknown/absent kid).
# `kid` is unauthenticated caller-chosen input verified BEFORE the rate
# limiter runs (see PrincipalMiddleware in app/middleware.py), so without this
# a flood of bogus kids is a flood of JWKS fetches against auth-svc.
_KID_MISS_COOLDOWN = 10.0


def _current_request_id() -> str | None:
    """Best-effort: the request_id bound by RequestIDMiddleware, if any."""
    rid = structlog.contextvars.get_contextvars().get("request_id")
    return str(rid) if rid else None


@dataclass
class Principal:
    user_id: str
    org_id: str
    roles: list[str]
    username: str


_jwks_cache = JwksCache(
    settings.jwks_url,
    cache_ttl=_JWKS_TTL,
    timeout=_JWKS_TIMEOUT,
    attempts=_JWKS_ATTEMPTS,
    kid_miss_cooldown=_KID_MISS_COOLDOWN,
    breaker_name="jwks",
    request_id_fn=_current_request_id,
    on_refresh=lambda count: log.info("jwks_refreshed", count=count),
    on_retry=lambda attempt, exc, delay: log.warning(
        "jwks_fetch_retry", attempt=attempt, delay_s=round(delay, 3), error=str(exc)
    ),
)


async def get_key(kid: str | None) -> Ed25519PublicKey:
    """Resolve ``kid`` via the shared cache; a token that NAMES an unknown kid
    is rejected (matches auth-svc auth_dep strictness) — only a token with NO
    kid falls back to the sole active key, for legacy/kid-less tokens.
    """
    try:
        key = await _jwks_cache.get_key(kid)
    except CircuitOpenError as exc:
        log.warning("jwks_circuit_open", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="auth keys unavailable",
        ) from exc
    except httpx.HTTPError as exc:
        log.warning("jwks_fetch_failed", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="auth keys unavailable",
        ) from exc
    if key is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unknown signing key")
    return key


async def verify_bearer(authorization: str | None) -> Principal:
    """Verify the Bearer JWT; identity comes from VERIFIED claims only.

    Split out of the dependency so PrincipalMiddleware can call it before
    the rate limiter runs (see app/middleware.py). The middleware caches
    the result on request.state and require_principal below reuses it, so a
    request that reaches an authed route verifies its token exactly once.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer token")
    token = authorization.split(" ", 1)[1].strip()

    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="malformed token")

    key = await get_key(header.get("kid"))

    try:
        claims = jwt.decode(
            token,
            key=key,
            algorithms=["EdDSA"],
            issuer=settings.jwt_issuer,
            leeway=30,  # tolerate ≤30s cross-node clock drift (matches the Go verifiers)
            options={"require": ["sub", "exp", "iat"]},
        )
    except jwt.PyJWTError as exc:
        # Log the real reason server-side; the client gets a generic detail —
        # matches auth-svc/app/security/auth_dep.py's verify_bearer, which
        # doesn't leak PyJWT's internal exception text into the response.
        log.info("jwt_verify_failed", error=str(exc))
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid token")

    sub = claims.get("sub")
    org_id = claims.get("org_id")
    if not sub or not org_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing claims")

    roles = claims.get("roles") or []
    if not isinstance(roles, list):
        roles = [roles]

    return Principal(
        user_id=str(sub),
        org_id=str(org_id),
        roles=[str(r) for r in roles],
        username=str(claims.get("username", "")),
    )


async def require_principal(
    request: Request,
    authorization: str | None = Header(default=None),
) -> Principal:
    """The dependency routes depend on. Reuses PrincipalMiddleware's result.

    The middleware runs on every request and swallows every failure, so a
    principal on request.state means "this token verified"; its absence means
    either no token or a bad one, and re-running verify_bearer here is what
    turns that into the correct 401 with the canonical error envelope.
    Authorization decisions stay here — the middleware only caches an answer.
    """
    cached = getattr(request.state, "principal", None)
    if isinstance(cached, Principal):
        return cached
    return await verify_bearer(authorization)


PrincipalDep = Depends(require_principal)



def require_org_admin(principal: Principal = PrincipalDep) -> Principal:
    """Gate a route on the org_admin role carried in the access-token claims.

    Mirrors auth-svc/app/security/auth_dep.py:require_org_admin. Roles are minted
    into the JWT (auth-svc security/keys.py:mint_access_token), so a role change
    only takes effect once the ~15-min access token refreshes — acceptable for
    roster curation, NOT for anything security-critical.
    """
    if "org_admin" not in principal.roles:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="org_admin role required")
    return principal


OrgAdminDep = Depends(require_org_admin)
