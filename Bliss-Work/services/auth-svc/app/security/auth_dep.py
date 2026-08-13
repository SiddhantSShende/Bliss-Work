"""Bearer-token verification against the JWKS (security keystone)."""
from __future__ import annotations

import asyncio
import base64
import time
from dataclasses import dataclass

import httpx
import jwt
import structlog
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import Depends, Header, HTTPException, status

from ..config import settings
from ..logging_config import log
from .resilience import CircuitBreaker, CircuitOpenError, retry_async

_JWKS_CACHE_TTL = 300  # ~5 minutes

# Per-attempt timeout for the JWKS fetch. Short + bounded so a slow auth-svc
# (this very service, but the well-known endpoint may be a separate replica)
# can't pin a request for the full original 5s on every attempt.
_JWKS_TIMEOUT = 3.0
_JWKS_ATTEMPTS = 3
# After this many consecutive transient failures the breaker opens and every
# get_key() fails fast for the cooldown instead of each request blocking on the
# per-attempt timeout (the cascade we're guarding against).
_jwks_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="jwks")


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


class _JwksCache:
    def __init__(self) -> None:
        self._keys: dict[str, Ed25519PublicKey] = {}
        self._fetched_at: float = 0.0
        # Serializes refreshes so a cache expiry under concurrent load triggers a
        # SINGLE fetch, not one per in-flight request (thundering herd on the
        # JWKS endpoint).
        self._lock = asyncio.Lock()

    async def _refresh(self) -> None:
        data = await self._fetch_jwks()
        keys: dict[str, Ed25519PublicKey] = {}
        for jwk in data.get("keys", []):
            if jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519":
                continue
            x = jwk["x"]
            raw = base64.urlsafe_b64decode(x + "=" * (-len(x) % 4))
            keys[jwk["kid"]] = Ed25519PublicKey.from_public_bytes(raw)
        self._keys = keys
        self._fetched_at = time.monotonic()

    async def _fetch_jwks(self) -> dict:
        """Fetch the JWKS document with a bounded per-attempt timeout, retries
        on transient failures (backoff+jitter) and a circuit breaker.

        When the breaker is OPEN we raise a 503 immediately instead of letting
        the caller block on the per-attempt timeout — that fail-fast is the
        whole point: a down JWKS endpoint degrades to fast 503s, not a pile of
        requests each waiting out the timeout (the cascade).
        """
        request_id = _current_request_id()
        headers = {"X-Request-Id": request_id} if request_id else None

        async def _attempt() -> dict:
            async with httpx.AsyncClient(timeout=_JWKS_TIMEOUT) as client:
                resp = await client.get(settings.jwks_url, headers=headers)
                resp.raise_for_status()
                return resp.json()

        def _on_retry(attempt: int, exc: BaseException, delay: float) -> None:
            log.warning("jwks_fetch_retry", attempt=attempt, delay_s=round(delay, 3),
                        error=str(exc))

        try:
            return await retry_async(
                _attempt,
                attempts=_JWKS_ATTEMPTS,
                breaker=_jwks_breaker,
                on_retry=_on_retry,
            )
        except CircuitOpenError as exc:
            log.warning("jwks_circuit_open", error=str(exc))
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, "auth keys unavailable"
            ) from exc
        except (httpx.HTTPError,) as exc:
            log.warning("jwks_fetch_failed", error=str(exc))
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, "auth keys unavailable"
            ) from exc

    async def _refresh_if_stale(self) -> None:
        async with self._lock:
            # Double-check inside the lock: a coroutine that waited may now find
            # the cache already refreshed by the one that held the lock.
            now = time.monotonic()
            if self._keys and (now - self._fetched_at) <= _JWKS_CACHE_TTL:
                return
            await self._refresh()

    async def get_key(self, kid: str) -> Ed25519PublicKey | None:
        now = time.monotonic()
        if not self._keys or (now - self._fetched_at) > _JWKS_CACHE_TTL:
            await self._refresh_if_stale()
        key = self._keys.get(kid)
        if key is None:
            # kid not present (key rotation): force one refresh under the lock,
            # re-checking so concurrent callers don't each refetch.
            async with self._lock:
                if kid not in self._keys:
                    await self._refresh()
            key = self._keys.get(kid)
        return key


_jwks_cache = _JwksCache()


async def get_principal(
    authorization: str | None = Header(default=None),
) -> Principal:
    """Verify the Bearer JWT; derive identity from VERIFIED claims only.

    Never trusts x-org-id / x-user-id headers. Forged/missing token -> 401.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    token = authorization.split(" ", 1)[1].strip()

    try:
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")
        if not kid:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing kid")
        key = await _jwks_cache.get_key(kid)
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


def require_org_admin(principal: Principal = Depends(get_principal)) -> Principal:
    if "org_admin" not in principal.roles:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "org_admin role required")
    return principal
