"""Google Translation integration: auth modes, locale list, placeholder safety.

Google itself is never reached. `FakeGoogle` replaces `httpx.AsyncClient`, so the
REAL request building, header auth, placeholder protect/restore, caching and
route code all run; only the network is faked. Companion to test_i18n_service.py
(flatten/dedupe/partial-failure logic) — this file covers what that one cannot:
what is actually SENT to Google and what comes back.
"""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import i18n_auth, i18n_placeholders
from app.errors import register_exception_handlers
from app.routes import i18n_service
from app.security.auth_dep import Principal, get_principal

_REAL_ASYNC_CLIENT = httpx.AsyncClient  # FakeGoogle replaces httpx.AsyncClient for the whole module
SECRET_KEY = "AIza-secret-key-do-not-leak"
SECRET_TOKEN = "ya29.secret-token-do-not-leak"

# Protected-HTML form of the synthetic English source → what "Google" answers.
# Keys go through the real `protect`, so a change to the wrapping breaks these
# tests loudly instead of silently diverging.
TRANSLATIONS = {
    "es": {"Loading…": "Cargando…", "Cancel": "Cancelar", "{{count}} tasks due": "{{count}} tareas pendientes"},
    "hi": {"Loading…": "लोड हो रहा है…", "Cancel": "रद्द करें", "{{count}} tasks due": "{{count}} कार्य बाकी"},
}
GOOGLE_LANGUAGES = [
    {"language": "en", "name": "English"},
    {"language": "es", "name": "Spanish"},
    {"language": "hi", "name": "Hindi"},
    {"language": "fr", "name": "French"},
    {"language": "tlh", "name": "Klingon"},  # supported by Google, NOT configured
]


def _html(source: str, translated: str) -> tuple[str, str]:
    """(what we send, what Google answers): the answer re-wraps the same
    protected tokens around the translated words, as Google's html mode does."""
    sent = i18n_placeholders.protect(source)
    return sent, i18n_placeholders.protect(translated)


class FakeGoogle:
    """Stand-in for httpx.AsyncClient. `mangle` makes Google rewrite the
    placeholder, `post_status` sets the translate call's HTTP status."""

    calls: list[dict] = []

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    mangle = False
    post_status = 200  # failing only the translate call keeps the language list reachable

    def _response(self, url: str, payload: dict, status: int = 200) -> httpx.Response:
        return httpx.Response(status, json=payload, request=httpx.Request("POST", url))

    async def get(self, url, params=None, headers=None, **k):
        FakeGoogle.calls.append({"url": url, "params": params or {}, "headers": headers or {}, "json": None})
        return self._response(url, {"data": {"languages": GOOGLE_LANGUAGES}})

    async def post(self, url, params=None, headers=None, json=None, **k):
        FakeGoogle.calls.append({"url": url, "params": params or {}, "headers": headers or {}, "json": json})
        table = {_html(src, out)[0]: _html(src, out)[1] for src, out in TRANSLATIONS[json["target"]].items()}
        out = []
        for q in json["q"]:
            answer = table.get(q, q)
            if self.mangle:
                answer = answer.replace("{{count}}", "{{cuenta}}")
            out.append({"translatedText": answer})
        return self._response(url, {"data": {"translations": out}}, self.post_status)


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
    monkeypatch.setattr(i18n_auth, "_credentials", None)
    s = i18n_service.settings
    monkeypatch.setattr(s, "google_translate_api_key", SECRET_KEY)
    monkeypatch.setattr(s, "google_application_credentials", "")
    monkeypatch.setattr(s, "google_translate_use_adc", False)
    monkeypatch.setattr(s, "i18n_locales", "es,fr,de,hi,pt,ja,zh,ko")
    FakeGoogle.calls = []
    FakeGoogle.mangle = False
    FakeGoogle.post_status = 200
    monkeypatch.setattr(i18n_service.httpx, "AsyncClient", FakeGoogle)


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


# ── auth ─────────────────────────────────────────────────────────────────────


async def test_api_key_goes_in_a_header_never_the_url():
    assert await i18n_auth.auth_headers() == {"x-goog-api-key": SECRET_KEY}


async def test_unconfigured_when_no_key_and_no_adc(monkeypatch):
    monkeypatch.setattr(i18n_service.settings, "google_translate_api_key", "")
    assert i18n_auth.is_configured() is False


class _Creds:
    def __init__(self, valid=False):
        self.valid, self.token, self.refreshed = valid, None, 0

    def refresh(self, _request):
        self.refreshed += 1
        self.valid, self.token = True, SECRET_TOKEN


async def test_adc_wins_over_the_key_and_refreshes_only_when_the_token_is_stale(monkeypatch):
    monkeypatch.setattr(i18n_service.settings, "google_translate_use_adc", True)
    creds = _Creds()
    monkeypatch.setattr(i18n_auth, "_load_credentials", lambda: creds)
    monkeypatch.setattr(i18n_auth, "_refresh", lambda c: c.refresh(None))
    h1 = await i18n_auth.auth_headers()
    h2 = await i18n_auth.auth_headers()
    assert h1 == h2 == {"authorization": f"Bearer {SECRET_TOKEN}"}
    assert creds.refreshed == 1  # second call reused the still-valid token


async def test_precedence_service_account_file_then_adc_then_api_key(monkeypatch):
    """1. GOOGLE_APPLICATION_CREDENTIALS file  2. GOOGLE_TRANSLATE_USE_ADC  3. API key."""
    import google.auth
    from google.oauth2 import service_account

    used: list[str] = []
    sa, adc = _Creds(), _Creds()
    monkeypatch.setattr(service_account.Credentials, "from_service_account_file", lambda path, scopes: (used.append(f"sa:{path}"), sa)[1])
    monkeypatch.setattr(google.auth, "default", lambda scopes: (used.append("adc"), (adc, "proj"))[1])
    monkeypatch.setattr(i18n_auth, "_refresh", lambda c: c.refresh(None))
    s = i18n_service.settings  # the key is already set by the autouse fixture

    # key + ADC + file → the file wins
    monkeypatch.setattr(s, "google_translate_use_adc", True)
    monkeypatch.setattr(s, "google_application_credentials", "/keys/sa.json")
    assert (await i18n_auth.auth_headers())["authorization"].startswith("Bearer ")
    assert used == ["sa:/keys/sa.json"]

    # key + ADC → ADC wins
    monkeypatch.setattr(i18n_auth, "_credentials", None)
    monkeypatch.setattr(s, "google_application_credentials", "")
    used.clear()
    assert (await i18n_auth.auth_headers())["authorization"].startswith("Bearer ")
    assert used == ["adc"]

    # key only → the key, and google-auth is never consulted
    monkeypatch.setattr(i18n_auth, "_credentials", None)
    monkeypatch.setattr(s, "google_translate_use_adc", False)
    used.clear()
    assert await i18n_auth.auth_headers() == {"x-goog-api-key": SECRET_KEY}
    assert used == []


async def test_service_account_path_alone_enables_adc_mode(monkeypatch):
    monkeypatch.setattr(i18n_service.settings, "google_translate_api_key", "")
    monkeypatch.setattr(i18n_service.settings, "google_application_credentials", "/keys/sa.json")
    assert i18n_auth.is_configured() is True


async def test_credential_failure_is_a_clean_error_that_leaks_nothing(monkeypatch):
    monkeypatch.setattr(i18n_service.settings, "google_application_credentials", "/keys/secret-path.json")

    def boom():
        raise FileNotFoundError("/keys/secret-path.json")

    monkeypatch.setattr(i18n_auth, "_load_credentials", boom)
    with pytest.raises(i18n_auth.TranslationAuthError) as err:
        await i18n_auth.auth_headers()
    assert "secret-path" not in str(err.value)


async def test_bad_credentials_degrade_languages_and_catalog_not_500(client, monkeypatch):
    monkeypatch.setattr(i18n_service.settings, "google_translate_use_adc", True)
    monkeypatch.setattr(i18n_auth, "_load_credentials", lambda: (_ for _ in ()).throw(RuntimeError("no adc")))
    async with client as c:
        langs = await c.get("/i18n/languages")
        cat = await c.get("/i18n/catalog", params={"locale": "es"})
    assert langs.status_code == 200 and langs.json() == {"languages": []}
    assert cat.status_code == 503
    assert FakeGoogle.calls == []  # never reached Google without a token


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
    assert not [c for c in FakeGoogle.calls if c["json"]]  # nothing was translated


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


async def test_request_to_google_is_html_protected_and_authenticated_by_header(client):
    async with client as c:
        await c.get("/i18n/catalog", params={"locale": "es"})
    post = next(c for c in FakeGoogle.calls if c["json"])
    assert post["json"]["format"] == "html" and post["json"]["source"] == "en" and post["json"]["target"] == "es"
    assert '<span translate="no">{{count}}</span> tasks due' in post["json"]["q"]
    assert post["headers"] == {"x-goog-api-key": SECRET_KEY}
    assert "key" not in post["params"]  # credentials never in the URL


async def test_translations_are_cached_per_source_and_target_language(client):
    async with client as c:
        await c.get("/i18n/catalog", params={"locale": "es"})
        posts_after_es = len([x for x in FakeGoogle.calls if x["json"]])
        await c.get("/i18n/catalog", params={"locale": "es"})
        assert len([x for x in FakeGoogle.calls if x["json"]]) == posts_after_es  # all cache hits
        await c.get("/i18n/catalog", params={"locale": "hi"})
        assert len([x for x in FakeGoogle.calls if x["json"]]) == posts_after_es + 1  # other target ≠ hit


def test_cache_key_includes_source_language_target_language_and_source_text():
    key = i18n_service._TranslationCache._key
    assert ":en:es:" in key("es", "Cancel")
    assert key("es", "Cancel") != key("hi", "Cancel")
    assert key("es", "Cancel") != key("es", "Save")
    assert key("es", "Cancel") == key("es", "Cancel")


async def test_mangled_placeholder_falls_back_to_english_and_is_not_cached(client):
    FakeGoogle.mangle = True
    async with client as c:
        r1 = await c.get("/i18n/catalog", params={"locale": "es"})
        FakeGoogle.mangle = False
        r2 = await c.get("/i18n/catalog", params={"locale": "es"})
    b1 = r1.json()
    assert b1["partial"] is True
    assert b1["namespaces"]["common"]["due"] == "{{count}} tasks due"  # English, placeholder intact
    assert b1["namespaces"]["common"]["cancel"] == "Cancelar"  # the rest still translated
    # Not cached while broken, so the next healthy answer is picked up.
    assert r2.json()["partial"] is False
    assert r2.json()["namespaces"]["common"]["due"] == "{{count}} tareas pendientes"


async def test_google_http_failure_falls_back_to_english_and_never_logs_the_key(client, capsys):
    FakeGoogle.post_status = 503
    async with client as c:
        r = await c.get("/i18n/catalog", params={"locale": "es"})
    body = r.json()
    assert r.status_code == 200 and body["partial"] is True
    assert body["namespaces"]["common"] == {"loading": "Loading…", "cancel": "Cancel", "due": "{{count}} tasks due"}
    out = capsys.readouterr()
    assert SECRET_KEY not in out.out + out.err


def test_safe_error_hides_the_request_url():
    req = httpx.Request("POST", f"https://translation.googleapis.com/x?key={SECRET_KEY}")
    exc = httpx.HTTPStatusError("boom", request=req, response=httpx.Response(403, request=req))
    assert i18n_service._safe_error(exc) == "HTTP 403"
    assert SECRET_KEY not in i18n_service._safe_error(exc)
