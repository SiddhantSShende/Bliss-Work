"""CAPTCHA generation + validation — required before every login and account
creation (`/auth/login`, `/auth/orgs`), except that login skips it for the
platforms in `CAPTCHA_EXEMPT_PLATFORMS` (see `is_exempt_platform`).

── Why a captcha_id + rendered image, never the plaintext ───────────────────
The value is never returned to the client in any form other than the
rendered PNG it's drawn into. `GET /auth/captcha` hands back an opaque
`captchaId` and an image; the server is the only party that ever holds the
plaintext, and only for as long as it takes to hash it.

── Storage: dual-mode, mirroring rate_limit.py's SensitiveRateLimitMiddleware ─
Redis-backed when REDIS_URL/SLOWAPI_STORAGE_URI is configured (honest across
pods), an in-process dict otherwise. This is deliberately the SAME dual-mode
pattern already established there rather than a second competing cache
mechanism — see `_CaptchaStore` below.

── Why plain SHA-256, not a keyed HMAC ───────────────────────────────────────
The plaintext is never stored — only `service.sha256_bytes(value)`, the exact
function `user_tokens.token_hash`/`refresh_tokens.token_hash` already hash
single-use secrets with. A keyed HMAC would resist offline precomputation
better, but a captcha's threat model doesn't call for it: the hash is never
exposed via any API, the value is short-lived (`CAPTCHA_TTL_SECONDS`, default
300s) and attempt-limited (`CAPTCHA_MAX_ATTEMPTS`), and reusing the existing
single-use-secret pattern is more consistent with this codebase than adding a
new keyed-HMAC mechanism (and a new key to manage) for a human-facing code
that was never meant to resist a targeted cryptographic attack — only casual
scripted abuse, which the TTL + attempt cap + per-IP rate limit already cover.

── Single validation path for both callers ───────────────────────────────────
`verify_and_consume` is the only place this is checked; auth.py's login and
create_org both call it directly rather than each re-implementing the
missing/expired/used/wrong-value logic.

── Rendering lives in captcha_image.py ───────────────────────────────────────
The actual pixel-pushing (style selection, background/interference,
per-character distortion, warp) is a separate module — a distinct concern
from generation/storage/validation, and large enough on its own to deserve
its own file. See captcha_image.py's docstring for the anti-OCR rationale.
"""
from __future__ import annotations

import secrets
import time

from fastapi import HTTPException, status

from . import captcha_image
from .captcha_alphabet import ALPHABET
from .. import service
from ..config import settings
from ..logging_config import log

def _generate_value(length: int) -> str:
    """Cryptographically secure — `secrets.choice` is CSPRNG-backed (os.urandom
    under the hood), unlike `random.choice`. Draws ONLY from
    captcha_alphabet.ALPHABET (mixed case, look-alikes removed — see there)."""
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


class _CaptchaStore:
    """Dual-mode store for (value_hash, attempts), keyed by captcha_id.

    Redis-backed when configured (honest across pods); an in-process dict
    otherwise. On any Redis error, falls back to treating the captcha as
    absent — fail CLOSED (reject the login/registration) rather than fail
    open, matching this service's existing security posture (e.g.
    `set_org_guc`'s fail-closed RLS GUC)."""

    def __init__(self) -> None:
        self._local: dict[str, tuple[bytes, float, int]] = {}  # id -> (hash, expires_at, attempts)
        self._redis = None
        uri = settings.redis_url or settings.slowapi_storage_uri
        if uri.startswith(("redis://", "rediss://")):
            try:
                import redis.asyncio as aioredis

                self._redis = aioredis.from_url(uri, socket_timeout=0.5, socket_connect_timeout=0.5)
            except Exception as exc:  # noqa: BLE001 - fall back to in-process
                log.warning("captcha_redis_init_failed", error=str(exc))
                self._redis = None

    async def put(self, captcha_id: str, value_hash: bytes, ttl_seconds: int) -> None:
        if self._redis is not None:
            try:
                key = f"captcha:{captcha_id}"
                await self._redis.hset(key, mapping={"h": value_hash, "a": 0})
                await self._redis.expire(key, ttl_seconds)
                return
            except Exception as exc:  # noqa: BLE001 - degrade to in-process
                log.warning("captcha_redis_error", error=str(exc))
        self._local[captcha_id] = (value_hash, time.monotonic() + ttl_seconds, 0)

    async def get(self, captcha_id: str) -> tuple[bytes, int] | None:
        """(value_hash, attempts), or None if absent/expired."""
        if self._redis is not None:
            try:
                data = await self._redis.hgetall(f"captcha:{captcha_id}")
                if not data:
                    return None
                return bytes(data[b"h"]), int(data[b"a"])
            except Exception as exc:  # noqa: BLE001 - fail closed on a Redis blip
                log.warning("captcha_redis_error", error=str(exc))
                return None
        entry = self._local.get(captcha_id)
        if entry is None:
            return None
        value_hash, expires_at, attempts = entry
        if time.monotonic() > expires_at:
            self._local.pop(captcha_id, None)
            return None
        return value_hash, attempts

    async def bump_attempts(self, captcha_id: str) -> int:
        """New attempt count after incrementing."""
        if self._redis is not None:
            try:
                return int(await self._redis.hincrby(f"captcha:{captcha_id}", "a", 1))
            except Exception as exc:  # noqa: BLE001 - degrade to in-process
                log.warning("captcha_redis_error", error=str(exc))
                return settings.captcha_max_attempts  # unknown -> treat as exhausted, fail closed
        entry = self._local.get(captcha_id)
        if entry is None:
            return settings.captcha_max_attempts
        value_hash, expires_at, attempts = entry
        attempts += 1
        self._local[captcha_id] = (value_hash, expires_at, attempts)
        return attempts

    async def invalidate(self, captcha_id: str) -> None:
        """Single-use enforcement point: called on successful validation AND
        once attempts are exhausted, so neither path leaves the entry usable."""
        if self._redis is not None:
            try:
                await self._redis.delete(f"captcha:{captcha_id}")
                return
            except Exception as exc:  # noqa: BLE001
                log.warning("captcha_redis_error", error=str(exc))
        self._local.pop(captcha_id, None)

    async def validate_and_consume(
        self, captcha_id: str, submitted_hash: bytes, max_attempts: int
    ) -> bool:
        """Atomically account for one guess and consume a successful captcha."""
        if self._redis is not None:
            script = """
                local key = KEYS[1]
                local stored = redis.call('HGET', key, 'h')
                if not stored then return 0 end
                local attempts = tonumber(redis.call('HGET', key, 'a') or '0')
                if attempts >= tonumber(ARGV[2]) then
                    redis.call('DEL', key)
                    return 0
                end
                local equal = (#stored == #ARGV[1])
                local diff = 0
                for i = 1, 32 do
                    local a = string.byte(stored, i) or 0
                    local b = string.byte(ARGV[1], i) or 0
                    if a ~= b then diff = 1 end
                end
                if equal and diff == 0 then
                    redis.call('DEL', key)
                    return 1
                end
                attempts = redis.call('HINCRBY', key, 'a', 1)
                if attempts >= tonumber(ARGV[2]) then redis.call('DEL', key) end
                return 0
            """
            try:
                result = await self._redis.eval(
                    script,
                    1,
                    f"captcha:{captcha_id}",
                    submitted_hash,
                    max_attempts,
                )
                return int(result) == 1
            except Exception as exc:  # noqa: BLE001 - fail closed on Redis errors
                log.warning("captcha_redis_error", error=str(exc))
                return False

        entry = self._local.get(captcha_id)
        if entry is None:
            return False
        value_hash, expires_at, attempts = entry
        if time.monotonic() > expires_at or attempts >= max_attempts:
            self._local.pop(captcha_id, None)
            return False
        if secrets.compare_digest(submitted_hash, value_hash):
            self._local.pop(captcha_id, None)
            return True
        attempts += 1
        if attempts >= max_attempts:
            self._local.pop(captcha_id, None)
        else:
            self._local[captcha_id] = (value_hash, expires_at, attempts)
        return False


_store = _CaptchaStore()


async def generate_challenge(replaces: str | None = None) -> tuple[str, bytes, int]:
    """(captcha_id, png_bytes, ttl_seconds). Also the "regenerate" path: a
    client that is refreshing passes the id it is discarding as `replaces`, and
    that challenge is invalidated here — so a refresh cannot leave an older
    image still answerable (and its remaining attempts still spendable)
    alongside the new one. Knowing the id is the only authority needed: it is
    an unguessable one-time value only the page that holds it has seen, and
    invalidating it can at worst make that page ask for a new one."""
    if replaces:
        await _store.invalidate(replaces)
    value = _generate_value(settings.captcha_length)
    captcha_id = service.new_uuid()
    await _store.put(captcha_id, service.sha256_bytes(value), settings.captcha_ttl_seconds)
    return captcha_id, captcha_image.render(value), settings.captcha_ttl_seconds


_INVALID_CAPTCHA = HTTPException(status.HTTP_400_BAD_REQUEST, "invalid or expired captcha")


def is_exempt_platform(client_platform: str | None) -> bool:
    """True when the client DECLARES itself a platform that is not challenged
    (`CAPTCHA_EXEMPT_PLATFORMS`, default macOS + iOS). Exact token match after
    trim/lower-casing — anything unrecognised, empty or absent is NOT exempt.

    The declaration is unverifiable, so this is a product policy, not a
    control: any caller can claim it. Only /auth/login passes a platform in;
    /auth/orgs never does, so registration stays challenged everywhere."""
    if client_platform is None:
        return False
    return client_platform.strip().lower() in settings.captcha_exempt_platform_set


async def verify_and_consume(
    captcha_id: str | None,
    captcha_value: str | None,
    client_platform: str | None = None,
) -> None:
    """Raises `_INVALID_CAPTCHA` on ANY failure — missing, unknown id, expired,
    wrong value, or already used/over-attempted — always the SAME message, so
    a caller learns nothing about which case it was. No-op when
    `CAPTCHA_ENABLED` is false (the dev/CI escape hatch — see config.py), or
    when `client_platform` is one `is_exempt_platform` accepts.

    Called BEFORE any credential check in both login and registration: cheap
    to reject here, before an Argon2 verify or an identity lookup ever runs,
    and independent of whether the credentials themselves are valid — so a
    captcha failure never reveals whether an email/password would otherwise
    have succeeded.
    """
    if not settings.captcha_enabled:
        return
    if is_exempt_platform(client_platform):
        return
    if not captcha_id or not captcha_value:
        raise _INVALID_CAPTCHA

    # Whitespace only: a phone keyboard's autocomplete or a pasted answer often
    # adds a trailing space, and no character in the alphabet is whitespace.
    # The answer is otherwise compared exactly — it is CASE-SENSITIVE.
    submitted_hash = service.sha256_bytes(captcha_value.strip())
    if not await _store.validate_and_consume(
        captcha_id,
        submitted_hash,
        settings.captcha_max_attempts,
    ):
        raise _INVALID_CAPTCHA
