"""Dynamic UI-translation support: Google Cloud Translation, server-side only.

── What this replaces ────────────────────────────────────────────────────────
BlissWork used to ship a pre-generated Spanish (and only Spanish) catalog,
built by a manual/CI script and committed to the repo. That is gone. The app
now bundles English alone (packages/app/src/i18n/locales/en/), and every other
locale is translated on demand, here, the first time anyone asks for it.

── Why this lives in auth-svc ────────────────────────────────────────────────
Every other backend service is domain-scoped (messaging, tasks, integrations);
this is a cross-cutting, app-shell concern with no natural domain owner, and
auth-svc is the one service every authenticated client already depends on
regardless of which feature area it's in — see the architecture note this
followed for the full reasoning. It costs nothing new here: the Redis
dual-mode cache pattern (`_CaptchaStore` in captcha_service.py) and the
`Depends(get_principal)` auth dependency both already exist in this service.

── The English source ────────────────────────────────────────────────────────
`_i18n_source_dir()` reads the SAME namespace JSON files the client bundles —
copied into this image at build time by the Dockerfile (never fetched, never
duplicated by hand). This is the only source of strings this module will ever
translate: the client sends a locale code, never text, so there is no way to
route arbitrary content through this endpoint, and no path by which task
titles, chat messages or any other user/encrypted content could reach it.

── Caching ────────────────────────────────────────────────────────────────────
Two independent caches, both Redis-backed with an in-process-dict fallback
(same dual-mode shape as `_CaptchaStore`, but fail-OPEN here — a cache miss
just costs one extra Google call, not a security exposure):
  * the Google supported-language list, ~24h TTL (`_LanguageListCache`)
  * per-string translations, keyed by `locale + sha256(source string)`
    (`_TranslationCache`) — so the same English string, in the same catalog
    build, is never sent to Google twice, no matter how many users or pods ask
    for it. A changed English string simply hashes to a different key; nothing
    needs to be invalidated by hand.
"""
from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, HTTPException, status

from ..config import settings
from ..logging_config import log
from ..security.auth_dep import Principal, get_principal

router = APIRouter(prefix="/i18n", tags=["i18n"])

_GOOGLE_LANGUAGES_URL = "https://translation.googleapis.com/language/translate/v2/languages"
_GOOGLE_TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2"
_GOOGLE_TIMEOUT = 8.0

# One Google `q` array per request stays well under Google's documented
# per-request limits (128 strings / ~30 KB) with room to spare for BlissWork's
# short UI labels. A cold cache (a locale nobody has ever picked) costs at
# most a couple dozen sequential calls the first time; every request after
# that — from any user, any pod — is a cache hit.
_TRANSLATE_BATCH_SIZE = 100

_LANGUAGE_LIST_TTL_SECONDS = 24 * 60 * 60
# Translations don't need a short TTL — the cache key already encodes the
# exact source string, so a changed string is a cache MISS, not a stale HIT.
# The TTL here is purely a housekeeping ceiling against unbounded growth from
# strings that get renamed/removed over the app's lifetime.
_TRANSLATION_TTL_SECONDS = 90 * 24 * 60 * 60


# ── English source catalogs ───────────────────────────────────────────────────


def _i18n_source_dir() -> Path:
    # Copied in by the Dockerfile (COPY packages/app/src/i18n/locales/en
    # ./app/i18n_source/en) — see services/auth-svc/Dockerfile.
    return Path(__file__).resolve().parent.parent / "i18n_source" / "en"


def _flatten(obj: dict, prefix: str = "") -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in obj.items():
        dotted = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out.update(_flatten(value, dotted))
        else:
            out[dotted] = value
    return out


def _unflatten(flat: dict[str, str]) -> dict:
    out: dict = {}
    for dotted, value in flat.items():
        parts = dotted.split(".")
        node = out
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = value
    return out


class _EnglishSource:
    """Loaded once at import time — these files never change at runtime, the
    same way the client's own `import.meta.glob(..., { eager: true })` bakes
    them into its bundle once, at build time."""

    def __init__(self) -> None:
        self.namespaces: dict[str, dict] = {}
        source_dir = _i18n_source_dir()
        if source_dir.is_dir():
            for path in sorted(source_dir.glob("*.json")):
                self.namespaces[path.stem] = json.loads(path.read_text("utf-8"))
        else:
            # Never crash the service over this — see module docstring: a
            # missing source dir just means /i18n/catalog has nothing to
            # translate, not that auth-svc itself is unhealthy.
            log.warning("i18n_source_missing", path=str(source_dir))

        # (namespace, dotted_key) -> source string, flattened once so every
        # request just looks values up rather than re-walking the JSON tree.
        self.flat: dict[str, dict[str, str]] = {
            ns: _flatten(doc) for ns, doc in self.namespaces.items()
        }


_english = _EnglishSource()


# ── Redis dual-mode caches (mirrors captcha_service._CaptchaStore's shape) ────


def _make_redis():
    uri = settings.redis_url or settings.slowapi_storage_uri
    if not uri.startswith(("redis://", "rediss://")):
        return None
    try:
        import redis.asyncio as aioredis

        return aioredis.from_url(uri, socket_timeout=2.0, socket_connect_timeout=2.0)
    except Exception as exc:  # noqa: BLE001 - degrade to in-process
        log.warning("i18n_redis_init_failed", error=str(exc))
        return None


class _LanguageListCache:
    """Whole-blob cache for Google's supported-language list. Fails OPEN on any
    Redis error: worst case is one extra live Google call, never a broken
    response."""

    _KEY = "i18n:languages"

    def __init__(self) -> None:
        self._redis = _make_redis()
        self._local: tuple[list[dict], float] | None = None

    async def get(self) -> list[dict] | None:
        if self._redis is not None:
            try:
                raw = await self._redis.get(self._KEY)
                return json.loads(raw) if raw else None
            except Exception as exc:  # noqa: BLE001
                log.warning("i18n_redis_error", op="languages_get", error=str(exc))
                return None
        if self._local is None:
            return None
        languages, expires_at = self._local
        return languages if time.monotonic() < expires_at else None

    async def set(self, languages: list[dict]) -> None:
        if self._redis is not None:
            try:
                await self._redis.set(self._KEY, json.dumps(languages), ex=_LANGUAGE_LIST_TTL_SECONDS)
                return
            except Exception as exc:  # noqa: BLE001
                log.warning("i18n_redis_error", op="languages_set", error=str(exc))
        self._local = (languages, time.monotonic() + _LANGUAGE_LIST_TTL_SECONDS)


class _TranslationCache:
    """Per-string cache, keyed by locale + sha256(source string) — see module
    docstring for why that key shape needs no manual invalidation."""

    @staticmethod
    def _key(locale: str, source: str) -> str:
        digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
        return f"i18n:tr:{locale}:{digest}"

    def __init__(self) -> None:
        self._redis = _make_redis()
        self._local: dict[str, str] = {}

    async def get_many(self, locale: str, sources: list[str]) -> dict[str, str]:
        """source string -> translated string, for whichever of `sources` are
        already cached."""
        if not sources:
            return {}
        keys = [self._key(locale, s) for s in sources]
        if self._redis is not None:
            try:
                values = await self._redis.mget(keys)
                return {
                    s: v.decode("utf-8")
                    for s, v in zip(sources, values)
                    if v is not None
                }
            except Exception as exc:  # noqa: BLE001 - degrade to "nothing cached"
                log.warning("i18n_redis_error", op="translation_mget", error=str(exc))
                return {}
        return {s: self._local[k] for s, k in zip(sources, keys) if k in self._local}

    async def set_many(self, locale: str, translations: dict[str, str]) -> None:
        if not translations:
            return
        if self._redis is not None:
            try:
                pipe = self._redis.pipeline()
                for source, translated in translations.items():
                    pipe.set(self._key(locale, source), translated, ex=_TRANSLATION_TTL_SECONDS)
                await pipe.execute()
                return
            except Exception as exc:  # noqa: BLE001 - best-effort; next request re-translates
                log.warning("i18n_redis_error", op="translation_set", error=str(exc))
                return
        for source, translated in translations.items():
            self._local[self._key(locale, source)] = translated


_language_cache = _LanguageListCache()
_translation_cache = _TranslationCache()


# ── Google Cloud Translation (Basic v2, REST, API-key auth) ──────────────────


async def _fetch_google_languages() -> list[dict]:
    """[{code, name}], English display names (target=en) — never Google's raw
    schema, so the client never has to know Google's field names."""
    if not settings.google_translate_api_key:
        return []
    cached = await _language_cache.get()
    if cached is not None:
        return cached
    try:
        async with httpx.AsyncClient(timeout=_GOOGLE_TIMEOUT) as client:
            res = await client.get(
                _GOOGLE_LANGUAGES_URL,
                params={"key": settings.google_translate_api_key, "target": "en"},
            )
            res.raise_for_status()
            body = res.json()
    except Exception as exc:  # noqa: BLE001 - quota/network/5xx all land here
        log.warning("i18n_google_languages_failed", error=str(exc))
        return []
    languages = [
        {"code": item["language"], "name": item.get("name", item["language"])}
        for item in body.get("data", {}).get("languages", [])
        # English is always separately available (it's bundled, never fetched)
        # — omitted here so the client never has to de-duplicate it.
        if item.get("language") != "en"
    ]
    await _language_cache.set(languages)
    return languages


async def _translate_batch(strings: list[str], target: str) -> list[str] | None:
    """None on total failure (caller treats every string in the batch as
    untranslated); otherwise one translated string per input, in order."""
    try:
        async with httpx.AsyncClient(timeout=_GOOGLE_TIMEOUT) as client:
            res = await client.post(
                _GOOGLE_TRANSLATE_URL,
                params={"key": settings.google_translate_api_key},
                json={"q": strings, "target": target, "source": "en", "format": "text"},
            )
            res.raise_for_status()
            body = res.json()
        return [t["translatedText"] for t in body["data"]["translations"]]
    except Exception as exc:  # noqa: BLE001 - quota/network/5xx: degrade, don't 500
        log.warning("i18n_google_translate_failed", target=target, count=len(strings), error=str(exc))
        return None


# ── Routes ─────────────────────────────────────────────────────────────────


@router.get("/languages")
async def list_languages(principal: Principal = Depends(get_principal)) -> dict:
    """The live set of languages BlissWork can translate into today — never a
    hardcoded list. Empty (not an error) when no Google key is configured, so
    the client's dropdown just shows the bundled English-only option — see
    the module docstring and .env.example's GOOGLE_TRANSLATE_API_KEY entry."""
    return {"languages": await _fetch_google_languages()}


@router.get("/catalog")
async def get_catalog(locale: str, principal: Principal = Depends(get_principal)) -> dict:
    """The full translated catalog for `locale`, namespace-shaped exactly like
    the English source — the client feeds each entry straight into
    i18next's `addResourceBundle(locale, namespace, ...)`."""
    if not locale:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "locale is required")

    if locale == "en":
        # Defensive only — the client never actually calls this for English
        # (see LanguageProvider), but answering it correctly costs nothing and
        # spends no Google quota.
        return {"locale": "en", "namespaces": _english.namespaces, "partial": False}

    supported = {lang["code"] for lang in await _fetch_google_languages()}
    if locale not in supported:
        # Distinguishes "not a real Google language" (client bug or a stale
        # dropdown) from "Google unreachable" (empty `supported` because the
        # key is absent or the call failed) — the latter must not silently
        # claim every locale is invalid.
        if not supported:
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "translation service is unavailable",
            )
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unsupported locale: {locale}")

    partial = False
    result_namespaces: dict[str, dict] = {}
    for namespace, flat_source in _english.flat.items():
        # De-duplicated: the same English string ("Cancel", "Delete", …) is the
        # value of many keys across a namespace, and each one only needs to be
        # looked up / sent to Google once.
        sources = list(dict.fromkeys(flat_source.values()))
        cached = await _translation_cache.get_many(locale, sources)
        missing = [s for s in sources if s not in cached]

        translated: dict[str, str] = dict(cached)
        for i in range(0, len(missing), _TRANSLATE_BATCH_SIZE):
            batch = missing[i : i + _TRANSLATE_BATCH_SIZE]
            results = await _translate_batch(batch, locale)
            if results is None or len(results) != len(batch):
                partial = True
                continue
            new_translations = dict(zip(batch, results))
            translated.update(new_translations)
            await _translation_cache.set_many(locale, new_translations)

        # A source string with no translation available (Google failed on its
        # batch) still resolves to a usable value — its own English text —
        # rather than a blank string; i18next's own fallbackLng covers the
        # same case again on the client, so a partial result never renders
        # empty either way.
        flat_result = {key: translated.get(source, source) for key, source in flat_source.items()}
        result_namespaces[namespace] = _unflatten(flat_result)

    return {"locale": locale, "namespaces": result_namespaces, "partial": partial}
