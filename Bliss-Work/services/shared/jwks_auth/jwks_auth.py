"""Hardened JWKS fetch-and-cache, shared across every Python service that
verifies bearer JWTs minted by auth-svc.

Single-flights refreshes (an ``asyncio.Lock``) so a cache expiry under
concurrent load triggers ONE fetch, not one per in-flight request, and rate-
limits refreshes forced by a cache miss — an unrecognized ``kid``, or no
usable key at all — behind a cooldown. ``kid`` is unauthenticated,
caller-chosen input (some services verify the bearer token before their rate
limiter runs), so without the cooldown a flood of misses becomes a flood of
JWKS fetches: an amplifier pointed at auth-svc's keystore.

Framework-agnostic on purpose (no FastAPI import): a failed fetch propagates
the underlying ``resilience.CircuitOpenError`` or ``httpx.HTTPError``, and
each service's own auth code maps that to whatever response its framework
needs (every current caller raises a 503 "auth keys unavailable").
"""
from __future__ import annotations

import asyncio
import base64
import time
from typing import Callable

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from resilience import CircuitBreaker, retry_async


class JwksCache:
    def __init__(
        self,
        jwks_url: str,
        *,
        cache_ttl: float = 300.0,
        timeout: float = 3.0,
        attempts: int = 3,
        kid_miss_cooldown: float = 10.0,
        fail_max: int = 5,
        reset_timeout: float = 30.0,
        breaker_name: str = "jwks",
        request_id_fn: Callable[[], str | None] | None = None,
        on_refresh: Callable[[int], None] | None = None,
        on_retry: Callable[[int, BaseException, float], None] | None = None,
    ) -> None:
        self._jwks_url = jwks_url
        self._cache_ttl = cache_ttl
        self._timeout = timeout
        self._attempts = attempts
        self._kid_miss_cooldown = kid_miss_cooldown
        self._request_id_fn = request_id_fn
        self._on_refresh = on_refresh
        self._on_retry = on_retry
        self._breaker = CircuitBreaker(fail_max=fail_max, reset_timeout=reset_timeout, name=breaker_name)

        self._keys: dict[str, Ed25519PublicKey] = {}
        self._fetched_at: float = 0.0
        self._last_kid_miss_refresh: float = -kid_miss_cooldown
        # Serializes refreshes so a cache expiry under concurrent load triggers
        # a SINGLE fetch, not one per in-flight request (thundering herd on
        # the JWKS endpoint).
        self._lock = asyncio.Lock()

    async def _fetch_jwks(self) -> dict:
        request_id = self._request_id_fn() if self._request_id_fn else None
        headers = {"X-Request-Id": request_id} if request_id else None

        async def _attempt() -> dict:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.get(self._jwks_url, headers=headers)
                resp.raise_for_status()
                return resp.json()

        def _on_retry(attempt: int, exc: BaseException, delay: float) -> None:
            if self._on_retry:
                self._on_retry(attempt, exc, delay)

        return await retry_async(
            _attempt,
            attempts=self._attempts,
            breaker=self._breaker,
            on_retry=_on_retry,
        )

    async def _refresh(self) -> None:
        data = await self._fetch_jwks()
        keys: dict[str, Ed25519PublicKey] = {}
        for jwk in data.get("keys", []):
            if jwk.get("kty") != "OKP" or jwk.get("crv") != "Ed25519":
                continue
            kid = jwk.get("kid")
            x = jwk.get("x")
            if not kid or not x:
                continue
            raw = base64.urlsafe_b64decode(x + "=" * (-len(x) % 4))
            keys[kid] = Ed25519PublicKey.from_public_bytes(raw)
        self._keys = keys
        self._fetched_at = time.monotonic()
        if self._on_refresh:
            self._on_refresh(len(keys))

    async def _refresh_if_stale(self) -> None:
        async with self._lock:
            # Double-check inside the lock: a coroutine that waited may now
            # find the cache already refreshed by the one that held the lock.
            now = time.monotonic()
            if self._keys and (now - self._fetched_at) <= self._cache_ttl:
                return
            await self._refresh()

    def _resolve(self, kid: str | None) -> Ed25519PublicKey | None:
        if kid:
            return self._keys.get(kid)
        # No kid on the token. Only ever resolves when exactly one key is
        # currently active — ambiguous otherwise. Callers that want to reject
        # kid-less tokens outright should do so before calling get_key.
        if len(self._keys) == 1:
            return next(iter(self._keys.values()))
        return None

    async def get_key(self, kid: str | None) -> Ed25519PublicKey | None:
        """Return the Ed25519 public key for ``kid`` (or the sole active key
        if ``kid`` is falsy and there is exactly one), refreshing the cache
        first if it's stale or empty.

        A miss forces at most one extra refresh per ``kid_miss_cooldown``
        window, single-flighted via the same lock as the TTL refresh above.
        """
        await self._refresh_if_stale()
        key = self._resolve(kid)
        if key is None and (time.monotonic() - self._last_kid_miss_refresh) >= self._kid_miss_cooldown:
            async with self._lock:
                # Re-check inside the lock so concurrent callers that queued
                # behind one refresh do not each trigger another.
                if self._resolve(kid) is None and (
                    time.monotonic() - self._last_kid_miss_refresh
                ) >= self._kid_miss_cooldown:
                    self._last_kid_miss_refresh = time.monotonic()
                    await self._refresh()
            key = self._resolve(kid)
        return key
