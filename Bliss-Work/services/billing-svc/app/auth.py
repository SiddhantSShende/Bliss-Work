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

_JWKS_TTL = 300
_JWKS_TIMEOUT = 3.0
_JWKS_ATTEMPTS = 3
_KID_MISS_COOLDOWN = 10.0


def _current_request_id() -> str | None:
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
    try:
        key = await _jwks_cache.get_key(kid)
    except CircuitOpenError as exc:
        log.warning("jwks_circuit_open", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="auth keys unavailable"
        ) from exc
    except httpx.HTTPError as exc:
        log.warning("jwks_fetch_failed", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="auth keys unavailable"
        ) from exc
    if key is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unknown signing key")
    return key


async def verify_bearer(authorization: str | None) -> Principal:
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
            leeway=30,
            options={"require": ["sub", "exp", "iat"]},
        )
    except jwt.PyJWTError as exc:
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
    cached = getattr(request.state, "principal", None)
    if isinstance(cached, Principal):
        return cached
    return await verify_bearer(authorization)


PrincipalDep = Depends(require_principal)


def require_org_admin(principal: Principal = PrincipalDep) -> Principal:
    """Gate a route on the org_admin role. Mirrors task-svc/app/auth.py."""
    if "org_admin" not in principal.roles:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="org_admin role required")
    return principal


OrgAdminDep = Depends(require_org_admin)
