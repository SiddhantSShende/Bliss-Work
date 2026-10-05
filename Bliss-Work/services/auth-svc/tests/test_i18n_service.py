"""Dynamic UI-translation endpoints — the whole point of not shipping a
pre-generated Spanish catalog any more.

Google itself is never called here — `_fetch_google_languages`/
`_translate_batch` are monkeypatched, and `_english` is replaced with a small
synthetic catalog, so these tests are entirely about THIS module's own logic:
flatten/unflatten round-tripping, per-string caching (never sending the same
source string to Google twice for a locale), batching only the cache misses,
locale validation against the live language list, and graceful degradation
when Google/the key is unavailable. See test_errors.py for the
FastAPI-app-plus-httpx.ASGITransport pattern this mirrors.
"""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app.errors import register_exception_handlers
from app.routes import i18n_service
from app.security.auth_dep import Principal, get_principal


def _make_app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(i18n_service.router)
    app.dependency_overrides[get_principal] = lambda: Principal(
        user_id="u1", org_id="o1", roles=["member"], username="sam"
    )
    return app


@pytest.fixture
def client():
    transport = httpx.ASGITransport(app=_make_app())
    return httpx.AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture(autouse=True)
def synthetic_english_source(monkeypatch):
    """Two namespaces, one repeated string ("Cancel") — enough to exercise
    flattening, nesting, and cross-key de-duplication without depending on the
    real (Docker-build-only) packages/app catalogs being present on disk."""
    common = {"loading": "Loading…", "buttons": {"cancel": "Cancel", "save": "Save"}}
    tasks = {"empty": "No tasks yet", "actions": {"cancel": "Cancel"}}
    english = i18n_service._EnglishSource.__new__(i18n_service._EnglishSource)
    english.namespaces = {"common": common, "tasks": tasks}
    english.flat = {
        "common": i18n_service._flatten(common),
        "tasks": i18n_service._flatten(tasks),
    }
    monkeypatch.setattr(i18n_service, "_english", english)
    # Fresh per-test cache instances so one test's writes never leak into the
    # next — the real singletons live for the process lifetime.
    monkeypatch.setattr(i18n_service, "_language_cache", i18n_service._LanguageListCache())
    monkeypatch.setattr(i18n_service, "_translation_cache", i18n_service._TranslationCache())


def test_flatten_unflatten_round_trip():
    nested = {"a": "1", "b": {"c": "2", "d": {"e": "3"}}}
    flat = i18n_service._flatten(nested)
    assert flat == {"a": "1", "b.c": "2", "b.d.e": "3"}
    assert i18n_service._unflatten(flat) == nested


async def test_languages_empty_without_a_translate_gateway(client, monkeypatch):
    monkeypatch.setattr(i18n_service.settings, "translate_gw_url", "")
    async with client as c:
        r = await c.get("/i18n/languages")
    assert r.status_code == 200
    assert r.json() == {"languages": []}


async def test_languages_excludes_english_and_caches_across_calls(client, monkeypatch):
    monkeypatch.setattr(i18n_service.settings, "translate_gw_url", "http://translate-gw:8010")
    monkeypatch.setattr(i18n_service.settings, "translate_internal_token", "fake-token")
    calls = []

    # Patched at the httpx boundary (not `_fetch_google_languages` itself), so
    # the real cache — the thing this test is actually about — runs for real:
    # the second /i18n/languages call must be answered from it, not Google.
    class _FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "languages": [
                    {"code": "en", "name": "English"},
                    {"code": "es", "name": "Spanish"},
                ]
            }

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *a, **k):
            calls.append(1)
            return _FakeResponse()

    monkeypatch.setattr(i18n_service.httpx, "AsyncClient", _FakeAsyncClient)

    async with client as c:
        r1 = await c.get("/i18n/languages")
        r2 = await c.get("/i18n/languages")

    assert r1.json() == {"languages": [{"code": "es", "name": "Spanish"}]}
    assert r2.json() == r1.json()
    # Two requests, ONE live call — the second is served from the language
    # cache (mirrors the ~24h Redis TTL; the in-process fallback is used here
    # since no REDIS_URL is set for this test run).
    assert len(calls) == 1


async def test_catalog_locale_en_is_a_passthrough_with_no_google_call(client, monkeypatch):
    async def fail(*a, **k):
        raise AssertionError("Google must never be called for locale=en")

    monkeypatch.setattr(i18n_service, "_translate_batch", fail)
    async with client as c:
        r = await c.get("/i18n/catalog", params={"locale": "en"})
    assert r.status_code == 200
    body = r.json()
    assert body["locale"] == "en"
    assert body["namespaces"]["common"]["buttons"]["cancel"] == "Cancel"
    assert body["partial"] is False


async def test_catalog_rejects_a_locale_google_does_not_support(client, monkeypatch):
    monkeypatch.setattr(i18n_service, "_fetch_google_languages", _stub_languages(["es"]))
    async with client as c:
        r = await c.get("/i18n/catalog", params={"locale": "xx-not-real"})
    assert r.status_code == 400


async def test_catalog_returns_503_when_the_language_list_itself_is_unavailable(client, monkeypatch):
    # Empty supported set — no key configured, or Google unreachable — must
    # not be misread as "every locale is invalid".
    monkeypatch.setattr(i18n_service, "_fetch_google_languages", _stub_languages([]))
    async with client as c:
        r = await c.get("/i18n/catalog", params={"locale": "es"})
    assert r.status_code == 503


async def test_catalog_translates_deduplicates_and_caches(client, monkeypatch):
    monkeypatch.setattr(i18n_service, "_fetch_google_languages", _stub_languages(["es"]))
    calls: list[list[str]] = []

    async def fake_translate(strings, target):
        calls.append(list(strings))
        return [f"[{target}] {s}" for s in strings]

    monkeypatch.setattr(i18n_service, "_translate_batch", fake_translate)

    async with client as c:
        r1 = await c.get("/i18n/catalog", params={"locale": "es"})
        calls_after_first_request = len(calls)
        r2 = await c.get("/i18n/catalog", params={"locale": "es"})

    assert r1.status_code == 200
    body = r1.json()
    assert body["locale"] == "es"
    assert body["partial"] is False
    assert body["namespaces"]["common"] == {
        "loading": "[es] Loading…",
        "buttons": {"cancel": "[es] Cancel", "save": "[es] Save"},
    }
    # "Cancel" is the value of two different keys, in two different
    # namespaces (common.buttons.cancel and tasks.actions.cancel) — it must
    # be translated once, not twice, across the whole request.
    all_sent = [s for batch in calls for s in batch]
    assert all_sent.count("Cancel") == 1

    # Second request: everything was already cached by the first, so it makes
    # no further Google calls at all.
    assert r2.json() == body
    assert len(calls) == calls_after_first_request


async def test_catalog_partial_result_falls_back_to_english_on_google_failure(client, monkeypatch):
    monkeypatch.setattr(i18n_service, "_fetch_google_languages", _stub_languages(["fr"]))

    async def failing_translate(strings, target):
        return None  # Google errored (quota, 5xx, timeout — see docstring)

    monkeypatch.setattr(i18n_service, "_translate_batch", failing_translate)

    async with client as c:
        r = await c.get("/i18n/catalog", params={"locale": "fr"})

    assert r.status_code == 200  # never a 500 — a degraded catalog, not an error
    body = r.json()
    assert body["partial"] is True
    # Untranslated strings fall back to their own English text — never blank,
    # and i18next's fallbackLng covers the exact same case again client-side.
    assert body["namespaces"]["common"]["buttons"]["cancel"] == "Cancel"


def _stub_languages(codes: list[str]):
    async def _stub():
        return [{"code": c, "name": c} for c in codes]

    return _stub
