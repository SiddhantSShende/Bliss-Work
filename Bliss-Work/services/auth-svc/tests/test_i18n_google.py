"""Translation via translate-gw: gateway contract, locale list, placeholder safety.

Neither Google nor translate-gw is reached. `FakeGateway` replaces
`httpx.AsyncClient`, so the REAL request building, internal-token header,
placeholder protect/restore, caching and route code all run; only the network is
faked. (Google authentication — ADC — lives in, and is tested by, the Go
translate-gw module.) Companion to test_i18n_service.py (flatten/dedupe/
partial-failure logic) — this file covers what that one cannot: what is actually
SENT to the gateway and what comes back.
"""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import i18n_placeholders
from app.errors import register_exception_handlers
from app.routes import i18n_service
from app.security.auth_dep import Principal, get_principal

_REAL_ASYNC_CLIENT = httpx.AsyncClient  # FakeGateway replaces httpx.AsyncClient for the whole module
GW_URL = "http://translate-gw:8012"
INTERNAL_TOKEN = "internal-token-do-not-leak"

# Protected-HTML form of the synthetic English source → what "Google" answers.
# Keys go through the real `protect`, so a change to the wrapping breaks these
# tests loudly instead of silently diverging.
TRANSLATIONS = {
    "es": {"Loading…": "Cargando…", "Cancel": "Cancelar", "{{count}} tasks due": "{{count}} tareas pendientes"},
    "hi": {"Loading…": "लोड हो रहा है…", "Cancel": "रद्द करें", "{{count}} tasks due": "{{count}} कार्य बाकी"},
}
GATEWAY_LANGUAGES = [
    {"code": "en", "name": "English"},
    {"code": "es", "name": "Spanish"},
    {"code": "hi", "name": "Hindi"},
    {"code": "fr", "name": "French"},
    {"code": "tlh", "name": "Klingon"},  # supported by Google, NOT configured
]


def _html(source: str, translated: str) -> tuple[str, str]:
    """(what we send, what Google answers): the answer re-wraps the same
    protected tokens around the translated words, as Google's html mode does."""
    sent = i18n_placeholders.protect(source)
    return sent, i18n_placeholders.protect(translated)


class FakeGateway:
    """Stand-in for httpx.AsyncClient speaking translate-gw's protocol. `mangle`
    makes "Google" rewrite the placeholder, `post_status` sets the translate
    call's HTTP status, `languages_status` the language list's."""

    calls: list[dict] = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    mangle = False
    post_status = 200  # failing only the translate call keeps the language list reachable
    languages_status = 200

    def _response(self, url: str, payload: dict, status: int = 200) -> httpx.Response:
        return httpx.Response(status, json=payload, request=httpx.Request("POST", url))

    async def get(self, url, params=None, headers=None, **k):
        FakeGateway.calls.append({"url": url, "params": params or {}, "headers": headers or {}, "json": None})
        return self._response(url, {"languages": GATEWAY_LANGUAGES}, self.languages_status)

    async def post(self, url, params=None, headers=None, json=None, **k):
        FakeGateway.calls.append({"url": url, "params": params or {}, "headers": headers or {}, "json": json})
        table = {_html(src, out)[0]: _html(src, out)[1] for src, out in TRANSLATIONS[json["target"]].items()}
        out = []
        for q in json["q"]:
            answer = table.get(q, q)
            if self.mangle:
                answer = answer.replace("{{count}}", "{{cuenta}}")
            out.append(answer)
        return self._response(url, {"translations": out}, self.post_status)


def _app() -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(i18n_service.router)
    app.dependency_overrides[get_principal] = lambda: Principal(user_id="u1", org_id="o1", roles=["member"], username="sam")
    return app


@pytest.fixture
def client():
    return _REAL_ASYNC_CLIENT(transport=httpx.ASGITransport(app=_app()), base_url="http://test")


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    common = {"loading": "Loading…", "cancel": "Cancel", "due": "{{count}} tasks due"}
    english = i18n_service._EnglishSource.__new__(i18n_service._EnglishSource)
    english.namespaces = {"common": common}
    english.flat = {"common": i18n_service._flatten(common)}
    monkeypatch.setattr(i18n_service, "_english", english)
    monkeypatch.setattr(i18n_service, "_language_cache", i18n_service._LanguageListCache())
    monkeypatch.setattr(i18n_service, "_translation_cache", i18n_service._TranslationCache())
    s = i18n_service.settings
    monkeypatch.setattr(s, "translate_gw_url", GW_URL)
    monkeypatch.setattr(s, "translate_internal_token", INTERNAL_TOKEN)
    monkeypatch.setattr(s, "i18n_locales", "es,fr,de,hi,pt,ja,zh,ko")
    FakeGateway.calls = []
    FakeGateway.mangle = False
    FakeGateway.post_status = 200
    FakeGateway.languages_status = 200
    monkeypatch.setattr(i18n_service.httpx, "AsyncClient", FakeGateway)


# ── placeholders ─────────────────────────────────────────────────────────────

PLACEHOLDER_SAMPLES = [
    "Hello {{name}}, you have {{count}} tasks",
    "{{- raw}} and {{count, number}}",
    "Click <bold>here</bold> or <0>there</0> <button>Go</button>",
    "Total: %s items, %1$d of %2$d, 50% done",
    "{count} selected",
    "See $t(common:loading) and https://example.com/a?b=1&c=2 now",
    "Fish & chips < 5 > 3",
]


@pytest.mark.parametrize("source", PLACEHOLDER_SAMPLES)
def test_protect_restore_round_trips_every_placeholder_style(source):
    assert i18n_placeholders.restore(i18n_placeholders.protect(source), source) == source


def test_protect_wraps_tokens_so_google_will_not_translate_them():
    out = i18n_placeholders.protect("Hello {{name}}")
    assert out == 'Hello <span translate="no">{{name}}</span>'


def test_restore_rejects_a_translation_that_lost_or_renamed_a_placeholder():
    src = "{{count}} tasks due"
    assert i18n_placeholders.restore("<span translate=\"no\">{{cuenta}}</span> tareas", src) is None
    assert i18n_placeholders.restore("tareas", src) is None
    # A reordered sentence is fine — same tokens, different position.
    assert i18n_placeholders.restore('vencen <span translate="no">{{count}}</span> tareas', src) == "vencen {{count}} tareas"


# ── gateway contract & configuration ─────────────────────────────────────────


@pytest.mark.parametrize("empty_field", ["translate_gw_url", "translate_internal_token"])
async def test_unconfigured_gateway_means_no_languages_and_no_traffic(client, monkeypatch, empty_field):
    monkeypatch.setattr(i18n_service.settings, empty_field, "")
    async with client as c:
        langs = await c.get("/i18n/languages")
        cat = await c.get("/i18n/catalog", params={"locale": "es"})
    assert langs.json() == {"languages": []}
    assert cat.status_code == 503
    assert FakeGateway.calls == []


async def test_gateway_is_called_with_the_internal_token_and_protocol(client):
    async with client as c:
        await c.get("/i18n/catalog", params={"locale": "es"})
    get = next(c for c in FakeGateway.calls if not c["json"])
    post = next(c for c in FakeGateway.calls if c["json"])
    assert get["url"] == f"{GW_URL}/v1/languages" and get["params"] == {"target": "en"}
    assert post["url"] == f"{GW_URL}/v1/translate"
    assert post["headers"] == get["headers"] == {"X-Internal-Token": INTERNAL_TOKEN}


async def test_gateway_unconfigured_adc_503_degrades_to_english_not_500(client):
    """translate-gw answers 503 when it has no ADC (operator hasn't run the login)."""
    FakeGateway.languages_status = 503
    async with client as c:
        langs = await c.get("/i18n/languages")
        cat = await c.get("/i18n/catalog", params={"locale": "hi"})
    assert langs.status_code == 200 and langs.json() == {"languages": []}
    assert cat.status_code == 503  # "translation service is unavailable" — the switcher stays English-only


# ── locale list ──────────────────────────────────────────────────────────────


async def test_languages_are_the_configured_ones_in_configured_order(client, monkeypatch):
    monkeypatch.setattr(i18n_service.settings, "i18n_locales", "hi, es ,xx")
    async with client as c:
        r = await c.get("/i18n/languages")
    # fr is supported by Google but not configured; xx is configured but unsupported.
    assert r.json() == {"languages": [{"code": "hi", "name": "Hindi"}, {"code": "es", "name": "Spanish"}]}


async def test_default_list_has_all_nine_required_locales_in_settings():
    codes = {c.strip() for c in i18n_service.settings.i18n_locales.split(",")} | {"en"}
    assert codes == {"en", "es", "fr", "de", "hi", "pt", "ja", "zh", "ko"}


async def test_empty_locale_setting_offers_everything_google_supports(client, monkeypatch):
    monkeypatch.setattr(i18n_service.settings, "i18n_locales", "")
    async with client as c:
        r = await c.get("/i18n/languages")
    assert {lang["code"] for lang in r.json()["languages"]} == {"es", "hi", "fr", "tlh"}


async def test_unsupported_locale_is_a_400_even_if_google_could_translate_it(client):
    async with client as c:
        r = await c.get("/i18n/catalog", params={"locale": "tlh"})  # Google yes, configured no
    assert r.status_code == 400
    assert not [c for c in FakeGateway.calls if c["json"]]  # nothing was translated


# ── translation flows (en → es, en → hi) ─────────────────────────────────────


@pytest.mark.parametrize("locale", ["es", "hi"])
async def test_catalog_translates_and_preserves_placeholders(client, locale):
    async with client as c:
        r = await c.get("/i18n/catalog", params={"locale": locale})
    assert r.status_code == 200
    body = r.json()
    assert body["partial"] is False
    common = body["namespaces"]["common"]
    assert common["cancel"] == TRANSLATIONS[locale]["Cancel"]
    assert common["loading"] == TRANSLATIONS[locale]["Loading…"]
    assert common["due"] == TRANSLATIONS[locale]["{{count}} tasks due"]
    assert "{{count}}" in common["due"]


async def test_request_is_html_protected(client):
    async with client as c:
        await c.get("/i18n/catalog", params={"locale": "es"})
    post = next(c for c in FakeGateway.calls if c["json"])
    assert post["json"]["format"] == "html" and post["json"]["source"] == "en" and post["json"]["target"] == "es"
    assert '<span translate="no">{{count}}</span> tasks due' in post["json"]["q"]
    assert "key" not in post["params"]  # nothing credential-like in the URL


async def test_translations_are_cached_per_source_and_target_language(client):
    async with client as c:
        await c.get("/i18n/catalog", params={"locale": "es"})
        posts_after_es = len([x for x in FakeGateway.calls if x["json"]])
        await c.get("/i18n/catalog", params={"locale": "es"})
        assert len([x for x in FakeGateway.calls if x["json"]]) == posts_after_es  # all cache hits
        await c.get("/i18n/catalog", params={"locale": "hi"})
        assert len([x for x in FakeGateway.calls if x["json"]]) == posts_after_es + 1  # other target ≠ hit


def test_cache_key_includes_source_language_target_language_and_source_text():
    key = i18n_service._TranslationCache._key
    assert ":en:es:" in key("es", "Cancel")
    assert key("es", "Cancel") != key("hi", "Cancel")
    assert key("es", "Cancel") != key("es", "Save")
    assert key("es", "Cancel") == key("es", "Cancel")


async def test_mangled_placeholder_falls_back_to_english_and_is_not_cached(client):
    FakeGateway.mangle = True
    async with client as c:
        r1 = await c.get("/i18n/catalog", params={"locale": "es"})
        FakeGateway.mangle = False
        r2 = await c.get("/i18n/catalog", params={"locale": "es"})
    b1 = r1.json()
    assert b1["partial"] is True
    assert b1["namespaces"]["common"]["due"] == "{{count}} tasks due"  # English, placeholder intact
    assert b1["namespaces"]["common"]["cancel"] == "Cancelar"  # the rest still translated
    # Not cached while broken, so the next healthy answer is picked up.
    assert r2.json()["partial"] is False
    assert r2.json()["namespaces"]["common"]["due"] == "{{count}} tareas pendientes"


async def test_google_failure_falls_back_to_english_and_never_logs_secrets(client, capsys):
    FakeGateway.post_status = 503
    async with client as c:
        r = await c.get("/i18n/catalog", params={"locale": "es"})
    body = r.json()
    assert r.status_code == 200 and body["partial"] is True
    assert body["namespaces"]["common"] == {"loading": "Loading…", "cancel": "Cancel", "due": "{{count}} tasks due"}
    out = capsys.readouterr()
    assert INTERNAL_TOKEN not in out.out + out.err


def test_safe_error_hides_the_request_url():
    req = httpx.Request("POST", "http://translate-gw:8012/v1/translate?key=SECRET")
    exc = httpx.HTTPStatusError("boom", request=req, response=httpx.Response(403, request=req))
    assert i18n_service._safe_error(exc) == "HTTP 403"
    assert "SECRET" not in i18n_service._safe_error(exc)
