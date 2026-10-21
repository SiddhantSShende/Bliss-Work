"""Super Admin login: a distinct, env-configured credential — no `users`
row, no org, no DB access at all. See app/routes/super_admin.py."""
from __future__ import annotations

import httpx
import pytest

pytestmark = pytest.mark.asyncio


def _client() -> httpx.AsyncClient:
    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def _stub_jwks_fetch(monkeypatch) -> None:
    """get_principal verifies the bearer JWT against JWKS fetched over HTTP
    from settings.jwks_url (normally auth-svc's own /.well-known endpoint,
    reached through the network in real deployments). There's no HTTP server
    in this test process, so stub the cache lookup to hand back the same
    public key keys.jwks() publishes, keyed the same way the real fetch is."""
    from app.config import settings
    from app.security import auth_dep, keys

    public_key = keys._public_key()  # same key keys.jwks() publishes

    async def _fake_get_key(kid: str):
        return public_key if kid == settings.jwt_kid else None

    monkeypatch.setattr(auth_dep._jwks_cache, "get_key", _fake_get_key)


async def _configure(monkeypatch, email: str = "admin@example.com", password: str = "Sup3r-Secret!1"):
    from app.config import settings
    from app.security.passwords import hash_password_async

    monkeypatch.setattr(settings, "super_admin_email", email)
    monkeypatch.setattr(settings, "super_admin_password_hash", await hash_password_async(password))
    return email, password


async def test_disabled_when_not_configured(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "super_admin_email", "")
    monkeypatch.setattr(settings, "super_admin_password_hash", "")
    async with _client() as c:
        r = await c.post("/auth/super-admin/login", json={"email": "a@b.com", "password": "whatever123!"})
    assert r.status_code == 503


async def test_correct_credentials_issue_a_token_that_passes_me(monkeypatch):
    _stub_jwks_fetch(monkeypatch)
    email, password = await _configure(monkeypatch)
    async with _client() as c:
        r = await c.post("/auth/super-admin/login", json={"email": email, "password": password})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["email"] == email
        assert body["expiresIn"] > 0
        token = body["accessToken"]

        me = await c.get("/auth/super-admin/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["email"] == email


async def test_wrong_password_rejected(monkeypatch):
    email, _ = await _configure(monkeypatch)
    async with _client() as c:
        r = await c.post("/auth/super-admin/login", json={"email": email, "password": "definitely-wrong-1!"})
    assert r.status_code == 401


async def test_unknown_email_rejected(monkeypatch):
    await _configure(monkeypatch)
    async with _client() as c:
        r = await c.post(
            "/auth/super-admin/login", json={"email": "nobody@example.com", "password": "whatever123!"}
        )
    assert r.status_code == 401


async def test_ordinary_org_session_cannot_reach_super_admin_me(monkeypatch):
    await _configure(monkeypatch)
    from app.main import app
    from app.security.auth_dep import Principal, get_principal

    app.dependency_overrides[get_principal] = lambda: Principal(
        user_id="u1", org_id="org1", roles=["org_admin"], username="u"
    )
    try:
        async with _client() as c:
            r = await c.get("/auth/super-admin/me", headers={"Authorization": "Bearer irrelevant"})
        assert r.status_code == 403
    finally:
        app.dependency_overrides.clear()


async def test_no_token_rejected(monkeypatch):
    await _configure(monkeypatch)
    async with _client() as c:
        r = await c.get("/auth/super-admin/me")
    assert r.status_code == 401
