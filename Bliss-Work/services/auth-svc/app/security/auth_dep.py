"""Bearer-token verification against the JWKS (security keystone)."""
from __future__ import annotations

from dataclasses import dataclass

import httpx
import jwt
import structlog
from fastapi import Depends, Header, HTTPException, Request, status

from ..config import settings
from ..logging_config import log
from jwks_auth import JwksCache
from resilience import CircuitOpenError

_JWKS_CACHE_TTL = 300  # ~5 minutes

# Per-attempt timeout for the JWKS fetch. Short + bounded so a slow auth-svc
# (this very service, but the well-known endpoint may be a separate replica)
# can't pin a request for the full original 5s on every attempt.
_JWKS_TIMEOUT = 3.0
_JWKS_ATTEMPTS = 3

# Minimum gap between refreshes forced by an UNKNOWN kid. `kid` is an
# unauthenticated caller-chosen string, so without this a flood of random kids
# is a flood of JWKS fetches. See jwks_auth.JwksCache.get_key.
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


# kid rotation is documented in docs/KEY-ROTATION.md: publish the new key
# before minting tokens with it, and the TTL refresh above picks it up. Worst
# case a token minted under a brand-new kid is rejected for up to
# _KID_MISS_COOLDOWN, and the client retries.
_jwks_cache = JwksCache(
    settings.jwks_url,
    cache_ttl=_JWKS_CACHE_TTL,
    timeout=_JWKS_TIMEOUT,
    attempts=_JWKS_ATTEMPTS,
    kid_miss_cooldown=_KID_MISS_COOLDOWN,
    breaker_name="jwks",
    request_id_fn=_current_request_id,
    on_retry=lambda attempt, exc, delay: log.warning(
        "jwks_fetch_retry", attempt=attempt, delay_s=round(delay, 3), error=str(exc)
    ),
)


async def _get_jwks_key(kid: str):
    """Fetch ``kid`` from the shared cache, mapping a fetch failure to a 503.

    When the breaker is OPEN (or the fetch itself fails) we raise 503
    immediately instead of letting the caller block on the per-attempt
    timeout — that fail-fast is the whole point: a down JWKS endpoint
    degrades to fast 503s, not a pile of requests each waiting out the
    timeout (the cascade).
    """
    try:
        return await _jwks_cache.get_key(kid)
    except CircuitOpenError as exc:
        log.warning("jwks_circuit_open", error=str(exc))
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "auth keys unavailable"
        ) from exc
    except httpx.HTTPError as exc:
        log.warning("jwks_fetch_failed", error=str(exc))
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "auth keys unavailable"
        ) from exc


async def verify_bearer(authorization: str | None) -> Principal:
    """Verify the Bearer JWT; derive identity from VERIFIED claims only.

    Never trusts x-org-id / x-user-id headers. Forged/missing token -> 401.

    Split out of the FastAPI dependency so PrincipalMiddleware can call it
    before the rate limiter runs (see app/middleware.py). The middleware caches
    the result on request.state and `get_principal` below reuses it, so a
    request that reaches an authenticated route verifies its token exactly once.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    token = authorization.split(" ", 1)[1].strip()

    try:
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")
        if not kid:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing kid")
        key = await _get_jwks_key(kid)
        if key is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "unknown signing key")
        claims = jwt.decode(
            token,
            key,
            algorithms=["EdDSA"],
            issuer=settings.jwt_issuer,
            options={"require": ["exp", "iat", "sub"]},
        )
    except HTTPException:
        raise
    except jwt.PyJWTError as exc:
        log.info("jwt_verify_failed", error=str(exc))
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token") from exc

    org_id = claims.get("org_id")
    sub = claims.get("sub")
    if not org_id or not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "incomplete claims")

    return Principal(
        user_id=sub,
        org_id=org_id,
        roles=list(claims.get("roles", [])),
        username=claims.get("username", ""),
    )


async def get_principal(
    request: Request,
    authorization: str | None = Header(default=None),
) -> Principal:
    """The dependency routes depend on. Reuses PrincipalMiddleware's result.

    The middleware runs on every request and swallows every failure, so a
    principal on request.state means "this token verified"; its absence means
    either no token or a bad one, and re-running verify_bearer here is what
    turns that into the correct 401 (or 503) with the canonical error envelope.
    Authorization decisions stay here, in the dependency — the middleware only
    ever caches an answer.
    """
    cached = getattr(request.state, "principal", None)
    if isinstance(cached, Principal):
        return cached
    return await verify_bearer(authorization)


def require_org_admin(principal: Principal = Depends(get_principal)) -> Principal:
    if "org_admin" not in principal.roles:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "org_admin role required")
    return principal
