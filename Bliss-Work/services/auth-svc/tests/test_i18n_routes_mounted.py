"""The i18n routes are mounted on the REAL application, not just on a test app.

test_i18n_proxy.py builds its own FastAPI app around the router, so it would pass
even if app/main.py never included it. That is exactly the failure users saw when an
auth-svc image predating the router served the web app: `GET /api/auth/i18n/languages`
→ 404 in the browser console. This asserts against `app.main.app` itself.

Without a token the route must answer 401 (authenticated, so it exists), and an
unknown /i18n path must still 404 — otherwise "401" would prove nothing.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_i18n_routes_are_registered_on_the_real_app():
    # OpenAPI, not app.routes: include_router nests routers, so they are not flat there.
    paths = app.openapi()["paths"]
    assert "get" in paths["/i18n/languages"]
    assert "get" in paths["/i18n/catalog"]


def test_languages_and_catalog_require_a_session_not_404():
    # No lifespan context: nothing here touches Postgres, Kafka or Redis.
    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/i18n/languages").status_code == 401
    assert client.get("/i18n/catalog", params={"locale": "es"}).status_code == 401
    assert client.get("/i18n/not-a-route").status_code == 404
