"""auth-svc's /i18n routes are an authenticated pass-through to translate-gw.

The gateway is replaced by an in-process fake (httpx.MockTransport), so these
tests are about THIS module's own job: authenticate the caller, send the
shared secret, validate what goes out and what comes back, and degrade to
"English only" instead of failing. No translation logic lives here any more —
that is tested in services/translate-gw (`go test ./...`). The gateway side of
the contract is covered end to end there.
"""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app.config import settings
from app.errors import register_exception_handlers
from app.routes import i18n_proxy
from app.security.auth_dep import Principal, get_principal

GW = "http://translate-gw:8012"
TOKEN = "gw-secret"


def _make_app(authed: bool = True) -> FastAPI:
    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(i18n_proxy.router)
    if authed:
        app.dependency_overrides[get_principal] = lambda: Principal(
            user_id="u1", org_id="o1", roles=["member"], username="sam"
        )
    return app


@pytest.fixture
def client():
    transport = httpx.ASGITransport(app=_make_app())
    return httpx.AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(settings, "translate_gw_url", GW)
    monkeypatch.setattr(settings, "translate_internal_token", TOKEN)
    monkeypatch.setattr(i18n_proxy, "_transport", None)


def gateway(monkeypatch, handler):
    """Install a fake gateway; returns the list of requests it received."""
    seen: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    monkeypatch.setattr(i18n_proxy, "_transport", httpx.MockTransport(recording))
    return seen


CATALOG = {"locale": "es", "namespaces": {"common": {"loading": "Cargando…"}}, "partial": False}


# ── /i18n/languages ─────────────────────────────────────────────────────────


async def test_languages_are_whatever_the_gateway_offers(client, monkeypatch):
    seen = gateway(
        monkeypatch,
        lambda r: httpx.Response(200, json={"languages": [{"code": "es", "name": "Spanish"}, {"code": "hi", "name": "Hindi"}]}),
    )
    res = await client.get("/i18n/languages")
    assert res.status_code == 200
    assert res.json() == {"languages": [{"code": "es", "name": "Spanish"}, {"code": "hi", "name": "Hindi"}]}
    assert len(seen) == 1 and str(seen[0].url) == f"{GW}/v1/languages"
    assert seen[0].headers["x-internal-token"] == TOKEN


async def test_languages_contract_drops_unknown_gateway_fields(client, monkeypatch):
    gateway(monkeypatch, lambda r: httpx.Response(200, json={"languages": [{"code": "fr", "name": "French", "secret": "x"}], "debug": 1}))
    assert (await client.get("/i18n/languages")).json() == {"languages": [{"code": "fr", "name": "French"}]}


@pytest.mark.parametrize(
    "handler",
    [
        lambda r: httpx.Response(503, json={"error": "unconfigured"}),  # no ADC yet
        lambda r: httpx.Response(502, json={"error": "upstream"}),
        lambda r: httpx.Response(401, json={"error": "unauthorized"}),
        lambda r: httpx.Response(200, text="not json"),
        lambda r: httpx.Response(200, json={"nope": []}),
        lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused")),
    ],
)
async def test_languages_degrade_to_empty_not_an_error(client, monkeypatch, handler):
    gateway(monkeypatch, handler)
    res = await client.get("/i18n/languages")
    assert res.status_code == 200
    assert res.json() == {"languages": []}


@pytest.mark.parametrize("url,token", [("", TOKEN), (GW, ""), ("", "")])
async def test_languages_empty_and_no_call_when_unconfigured(client, monkeypatch, url, token):
    monkeypatch.setattr(settings, "translate_gw_url", url)
    monkeypatch.setattr(settings, "translate_internal_token", token)
    seen = gateway(monkeypatch, lambda r: httpx.Response(200, json={"languages": [{"code": "es", "name": "Spanish"}]}))
    assert (await client.get("/i18n/languages")).json() == {"languages": []}
    assert seen == []


# ── /i18n/catalog ───────────────────────────────────────────────────────────


async def test_catalog_is_passed_through_with_locale_and_token(client, monkeypatch):
    seen = gateway(monkeypatch, lambda r: httpx.Response(200, json=CATALOG))
    res = await client.get("/i18n/catalog", params={"locale": "es"})
    assert res.status_code == 200
    assert res.json() == CATALOG
    assert seen[0].url.path == "/v1/catalog" and seen[0].url.params["locale"] == "es"
    assert seen[0].headers["x-internal-token"] == TOKEN


async def test_catalog_partial_flag_survives(client, monkeypatch):
    gateway(monkeypatch, lambda r: httpx.Response(200, json={**CATALOG, "partial": True}))
    assert (await client.get("/i18n/catalog", params={"locale": "es"})).json()["partial"] is True


@pytest.mark.parametrize("locale", ["", "../etc/passwd", "es&x=1", "toolonglocale", "e", "es fr"])
async def test_catalog_rejects_malformed_locales_without_calling_the_gateway(client, monkeypatch, locale):
    seen = gateway(monkeypatch, lambda r: httpx.Response(200, json=CATALOG))
    res = await client.get("/i18n/catalog", params={"locale": locale})
    assert res.status_code == 400
    assert seen == []


async def test_catalog_locale_the_gateway_does_not_offer_is_400(client, monkeypatch):
    gateway(monkeypatch, lambda r: httpx.Response(400, json={"error": "unsupported_locale"}))
    res = await client.get("/i18n/catalog", params={"locale": "xx"})
    assert res.status_code == 400
    assert "xx" in res.text


@pytest.mark.parametrize(
    "handler",
    [
        lambda r: httpx.Response(503, json={"error": "unconfigured"}),
        lambda r: httpx.Response(502, json={"error": "upstream"}),
        lambda r: httpx.Response(401, json={"error": "unauthorized"}),
        lambda r: httpx.Response(200, text="<html>"),
        lambda r: httpx.Response(200, json={"locale": "es"}),
        lambda r: httpx.Response(200, json={**CATALOG, "namespaces": []}),
        lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slow")),
    ],
)
async def test_catalog_is_503_when_the_gateway_cannot_deliver(client, monkeypatch, handler):
    gateway(monkeypatch, handler)
    res = await client.get("/i18n/catalog", params={"locale": "es"})
    assert res.status_code == 503


async def test_catalog_is_503_when_unconfigured(client, monkeypatch):
    monkeypatch.setattr(settings, "translate_gw_url", "")
    seen = gateway(monkeypatch, lambda r: httpx.Response(200, json=CATALOG))
    assert (await client.get("/i18n/catalog", params={"locale": "es"})).status_code == 503
    assert seen == []


async def test_gateway_error_text_never_reaches_the_client(client, monkeypatch):
    gateway(monkeypatch, lambda r: httpx.Response(502, json={"error": "https://translation.googleapis.com/?key=SECRET"}))
    res = await client.get("/i18n/catalog", params={"locale": "es"})
    assert "SECRET" not in res.text


# ── authentication boundary ─────────────────────────────────────────────────


async def test_both_routes_require_a_session_and_never_reach_the_gateway(monkeypatch):
    seen = gateway(monkeypatch, lambda r: httpx.Response(200, json=CATALOG))
    anon = httpx.AsyncClient(transport=httpx.ASGITransport(app=_make_app(authed=False)), base_url="http://test")
    assert (await anon.get("/i18n/languages")).status_code == 401
    assert (await anon.get("/i18n/catalog", params={"locale": "es"})).status_code == 401
    assert seen == []
