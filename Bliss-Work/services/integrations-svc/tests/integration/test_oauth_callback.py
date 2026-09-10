"""The OAuth callback end to end: the credential-rotation pin and the
owner-mismatch guard, both against a real Postgres so RLS/constraints are real.
"""
from __future__ import annotations

import urllib.parse

import httpx
import pytest
import uuid6
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
USER_A = "33333333-3333-3333-3333-333333333333"
USER_B = "44444444-4444-4444-4444-444444444444"


def _principal(user_id: str, org_id: str = ORG, plan: str = "enterprise"):
    from app.auth import Principal

    return Principal(user_id=user_id, org_id=org_id, roles=["admin"], username="me", plan=plan)


async def _client(principal) -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: principal
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


def _extract_state(authorize_url: str) -> str:
    return urllib.parse.parse_qs(urllib.parse.urlsplit(authorize_url).query)["state"][0]


def _install_provider_stubs(monkeypatch, *, client_secret_seen: list, ext_id: str = "shared@x.test"):
    from app.providers import oauth as oauth_provider
    from app.providers.oauth import Identity

    async def fake_exchange_code(cfg, code, verifier, redirect_uri):
        client_secret_seen.append(cfg.client_secret)
        return {"access_token": f"tok-for-{cfg.client_secret}", "expires_in": 3600}

    async def fake_fetch_identity(cfg, access_token):
        return Identity(account_id=ext_id, label=ext_id, handles=(("email", ext_id),))

    monkeypatch.setattr(oauth_provider, "exchange_code", fake_exchange_code)
    monkeypatch.setattr(oauth_provider, "fetch_identity", fake_fetch_identity)


async def _connection_row(org_id: str, provider: str):
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        return (
            await conn.execute(
                text(
                    "SELECT owner_user_id, access_token_enc, status FROM integration_connections "
                    " WHERE org_id = :o AND provider = :p"
                ),
                {"o": org_id, "p": provider},
            )
        ).one_or_none()


# ── #B: a secret rotated mid-consent must not break (or silently swap onto)
#        the in-flight exchange ─────────────────────────────────────────────


async def test_a_secret_rotated_mid_consent_does_not_affect_the_in_flight_exchange(
    db_app, monkeypatch
):
    client_secret_seen: list[str] = []
    _install_provider_stubs(monkeypatch, client_secret_seen=client_secret_seen)

    async with await _client(_principal(USER_A)) as c:
        await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "id-v1", "clientSecret": "secret-v1"},
        )
        start = await c.post("/api/v1/integrations/gmail/connect/start", json={})
        state = _extract_state(start.json()["authorizeUrl"])

        # The admin rotates the secret WHILE the user is still on the consent
        # screen — before this fix, load_by_id would see this NEW secret.
        await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "id-v2", "clientSecret": "secret-v2"},
        )

        cb = await c.get(f"/ext/gmail/oauth/callback?code=abc123&state={state}")

    assert cb.status_code in (200, 302)
    # The exchange must have used the secret active when the flow STARTED,
    # never the rotated-in one.
    assert client_secret_seen == ["secret-v1"]

    row = await _connection_row(ORG, "gmail")
    assert row is not None
    assert row.status == "connected"


# ── #C: reconnecting an already-connected external account under a
#        different owner must be rejected, not silently overwritten ────────


async def test_reconnecting_a_teammates_mailbox_is_rejected(db_app, monkeypatch):
    client_secret_seen: list[str] = []
    _install_provider_stubs(monkeypatch, client_secret_seen=client_secret_seen, ext_id="shared@x.test")

    async with await _client(_principal(USER_A)) as c:
        await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "id-1", "clientSecret": "secret-1"},
        )
        start_a = await c.post("/api/v1/integrations/gmail/connect/start", json={})
        state_a = _extract_state(start_a.json()["authorizeUrl"])
        first = await c.get(f"/ext/gmail/oauth/callback?code=codeA&state={state_a}")
        assert first.status_code in (200, 302)

    before = await _connection_row(ORG, "gmail")
    assert str(before.owner_user_id) == USER_A

    async with await _client(_principal(USER_B)) as c:
        start_b = await c.post("/api/v1/integrations/gmail/connect/start", json={})
        state_b = _extract_state(start_b.json()["authorizeUrl"])
        second = await c.get(f"/ext/gmail/oauth/callback?code=codeB&state={state_b}")

    assert second.status_code in (200, 302)
    if second.status_code == 302:
        assert "already_connected_by_teammate" in second.headers["location"]

    after = await _connection_row(ORG, "gmail")
    # Ownership AND the stored token must be exactly what they were before
    # user B's attempt — nothing about the existing connection changed.
    assert str(after.owner_user_id) == USER_A
    assert bytes(after.access_token_enc) == bytes(before.access_token_enc)


async def test_reconnecting_your_own_mailbox_still_works(db_app, monkeypatch):
    # Guards the test above against a false positive: the SAME owner
    # reconnecting (a normal token refresh/re-auth) must still succeed.
    client_secret_seen: list[str] = []
    _install_provider_stubs(monkeypatch, client_secret_seen=client_secret_seen, ext_id="mine@x.test")

    async with await _client(_principal(USER_A)) as c:
        await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "id-1", "clientSecret": "secret-1"},
        )
        start_1 = await c.post("/api/v1/integrations/gmail/connect/start", json={})
        await c.get(f"/ext/gmail/oauth/callback?code=c1&state={_extract_state(start_1.json()['authorizeUrl'])}")

        start_2 = await c.post("/api/v1/integrations/gmail/connect/start", json={})
        second = await c.get(
            f"/ext/gmail/oauth/callback?code=c2&state={_extract_state(start_2.json()['authorizeUrl'])}"
        )

    assert second.status_code in (200, 302)
    if second.status_code == 302:
        assert "error" not in second.headers["location"]
    row = await _connection_row(ORG, "gmail")
    assert str(row.owner_user_id) == USER_A
    assert row.status == "connected"
