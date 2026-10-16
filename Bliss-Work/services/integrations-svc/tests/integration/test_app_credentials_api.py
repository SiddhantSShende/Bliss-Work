"""Workspace credential management and per-connection webhook tokens.

The properties that matter here are isolation ones — Google credential sets
belong to exactly one org, Microsoft credentials are centrally managed, secrets
never come back out, and a webhook token resolves exactly one connection.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import uuid6
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
OTHER_ORG = "22222222-2222-2222-2222-222222222222"
ME = "33333333-3333-3333-3333-333333333333"


def _principal(user_id=ME, org_id=ORG, plan="enterprise", roles=None):
    from app.auth import Principal

    # Every fixture in this file predates the plan gate and exercises the
    # connect flow, so default to "enterprise" here — the free-plan case is
    # exercised explicitly, by name, in the connect-gating tests below.
    return Principal(
        user_id=user_id,
        org_id=org_id,
        roles=roles if roles is not None else ["org_admin"],
        username="me",
        plan=plan,
    )


async def _client(principal=None):
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: principal or _principal()
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


# ── CRUD ──────────────────────────────────────────────────────────────────────
async def test_put_then_get_round_trips_without_leaking_the_secret(db_app):
    async with await _client() as c:
        r = await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "goog-client-123", "clientSecret": "goog-secret-456"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["configured"] is True
        assert body["source"] == "org"
        assert body["clientId"] == "goog-client-123"

        # THE assertion: the secret must never come back, on any field, ever.
        assert "goog-secret-456" not in r.text

        r2 = await c.get("/api/v1/integrations/app-credentials")
        assert r2.status_code == 200
        assert "goog-secret-456" not in r2.text
        google = next(v for v in r2.json() if v["vendor"] == "google")
        assert google["clientId"] == "goog-client-123"


async def test_response_hands_over_the_exact_redirect_uris(db_app, monkeypatch):
    # PUBLIC_BASE_URL is empty by default outside production (config.py only
    # *requires* it there), so pin it — the joining is what's under test.
    from app.config import settings

    monkeypatch.setattr(settings, "public_base_url", "https://bliss.example/")

    async with await _client() as c:
        r = await c.get("/api/v1/integrations/app-credentials")
        by_vendor = {v["vendor"]: v for v in r.json()}

        # Redirect-URI mismatch is the #1 OAuth setup failure, so we hand over
        # the literal string to register rather than describing how to build it.
        # Note the single slash: the trailing one above must not double up.
        assert by_vendor["google"]["redirectUris"] == [
            "https://bliss.example/ext/gmail/oauth/callback"
        ]
        assert by_vendor["microsoft"]["redirectUris"] == [
            "https://bliss.example/ext/teams/oauth/callback",
        ]


async def test_put_is_idempotent_and_rotates_in_place(db_app):
    async with await _client() as c:
        await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "id-1", "clientSecret": "secret-1"},
        )
        r = await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "id-2", "clientSecret": "secret-2"},
        )
        assert r.status_code == 200
        assert r.json()["clientId"] == "id-2"

    # Exactly one row — a second would make the connect flow pick between two.
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        n = (
            await conn.execute(
                text(
                    "SELECT count(*) FROM provider_app_credentials "
                    "WHERE org_id = :o AND vendor = 'google'"
                ),
                {"o": ORG},
            )
        ).scalar_one()
    assert n == 1


async def test_delete_removes_it(db_app):
    async with await _client() as c:
        await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "google-id", "clientSecret": "google-secret"},
        )
        assert (await c.delete("/api/v1/integrations/app-credentials/google")).status_code == 204
        # Second delete has nothing to remove.
        assert (await c.delete("/api/v1/integrations/app-credentials/google")).status_code == 404

        google = next(
            v for v in (await c.get("/api/v1/integrations/app-credentials")).json()
            if v["vendor"] == "google"
        )
        assert google["configured"] is False


# ── validation ────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("vendor", ["slack", "teams"])
async def test_non_vendor_credential_path_is_404(db_app, vendor):
    async with await _client() as c:
        r = await c.put(
            f"/api/v1/integrations/app-credentials/{vendor}",
            json={"clientId": "a", "clientSecret": "b"},
        )
        assert r.status_code == 404


@pytest.mark.parametrize(
    "payload",
    [
        {"clientId": "", "clientSecret": "b"},
        {"clientId": "a", "clientSecret": ""},
        {"clientId": "   ", "clientSecret": "b"},
    ],
)
async def test_blank_credentials_are_rejected(db_app, payload):
    async with await _client() as c:
        assert (
            await c.put("/api/v1/integrations/app-credentials/google", json=payload)
        ).status_code == 400


async def test_placeholder_secret_is_rejected(db_app):
    # Caught here rather than surfacing as an opaque provider error mid-consent.
    async with await _client() as c:
        r = await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "real-id", "clientSecret": "your-client-secret"},
        )
        assert r.status_code == 400
        # errors.py wraps every failure as {"error": {"code", "message", ...}}.
        assert "placeholder" in r.json()["error"]["message"]


async def test_vendor_specific_fields_are_enforced(db_app):
    async with await _client() as c:
        # tenant is Microsoft-only; accepting it for Google would store a value
        # that is never read, so the admin believes they configured something.
        r = await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "a", "clientSecret": "b", "tenant": "contoso"},
        )
        assert r.status_code == 400


# ── isolation ─────────────────────────────────────────────────────────────────
async def test_another_org_cannot_see_or_use_these_credentials(db_app):
    async with await _client(_principal(org_id=ORG)) as c:
        await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "org-a-id", "clientSecret": "org-a-secret"},
        )

    async with await _client(_principal(org_id=OTHER_ORG)) as c:
        r = await c.get("/api/v1/integrations/app-credentials")
        assert "org-a-id" not in r.text
        assert "org-a-secret" not in r.text
        google = next(v for v in r.json() if v["vendor"] == "google")
        assert google["configured"] is False

        # And deleting is scoped too — org B must not be able to knock org A's
        # integration offline.
        assert (await c.delete("/api/v1/integrations/app-credentials/google")).status_code == 404

    async with await _client(_principal(org_id=ORG)) as c:
        google = next(
            v for v in (await c.get("/api/v1/integrations/app-credentials")).json()
            if v["vendor"] == "google"
        )
        assert google["configured"] is True


async def test_workspace_admin_cannot_upload_microsoft_credentials(db_app, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "ms_client_id", "")
    monkeypatch.setattr(settings, "ms_client_secret", "")

    async with await _client(_principal(org_id=ORG)) as c:
        upload = await c.put(
            "/api/v1/integrations/app-credentials/microsoft",
            json={"clientId": "org-a-ms-id", "clientSecret": "org-a-ms-secret"},
        )
        assert upload.status_code == 400
        assert "deployment operator" in upload.json()["error"]["message"].lower()
        status = await c.get("/api/v1/integrations/app-credentials")
        assert "org-a-ms-id" not in status.text
        assert "org-a-ms-secret" not in status.text
        microsoft = next(v for v in status.json() if v["vendor"] == "microsoft")
        assert microsoft["configured"] is False

    async with await _client(_principal(org_id=OTHER_ORG)) as c:
        status = await c.get("/api/v1/integrations/app-credentials")
        microsoft = next(v for v in status.json() if v["vendor"] == "microsoft")
        assert microsoft["configured"] is False
        connect = await c.post("/api/v1/integrations/teams/connect/start", json={})
        assert connect.status_code == 409
        assert "isn't set up for this workspace yet" in connect.json()["error"]["message"].lower()


# ── connect gating ────────────────────────────────────────────────────────────
async def test_connect_start_refuses_until_credentials_exist(db_app):
    async with await _client() as c:
        r = await c.post("/api/v1/integrations/gmail/connect/start", json={})
        assert r.status_code == 409
        # The message has to say what to DO, not just that it failed.
        assert "google" in r.json()["error"]["message"].lower()


async def test_teams_connect_start_refuses_until_microsoft_credentials_exist(
    db_app, monkeypatch
):
    from app.config import settings

    monkeypatch.setattr(settings, "ms_client_id", "")
    monkeypatch.setattr(settings, "ms_client_secret", "")

    async with await _client(_principal()) as c:
        r = await c.post("/api/v1/integrations/teams/connect/start", json={})

    assert r.status_code == 409
    assert "isn't set up for this workspace yet" in r.json()["error"]["message"].lower()


async def test_connect_start_works_once_credentials_exist(db_app):
    async with await _client() as c:
        await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "goog-live-id", "clientSecret": "goog-live-secret"},
        )
        r = await c.post("/api/v1/integrations/gmail/connect/start", json={})
        assert r.status_code == 200, r.text
        url = r.json()["authorizeUrl"]
        # The org's OWN client id drives the flow…
        assert "client_id=goog-live-id" in url
        # …and the secret never travels in the browser-followed URL.
        assert "goog-live-secret" not in url


async def test_connect_start_is_forbidden_for_a_non_enterprise_org(db_app):
    # External Integrations is an enterprise-only entitlement. A free-plan org
    # must not be able to acquire a new connection by calling the API
    # directly, even with valid app credentials on file — this is the actual
    # authorization boundary; the frontend gate is not one.
    async with await _client(_principal(plan="enterprise")) as c:
        await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "goog-live-id", "clientSecret": "goog-live-secret"},
        )

    async with await _client(_principal(plan="free")) as c:
        r = await c.post("/api/v1/integrations/gmail/connect/start", json={})
        assert r.status_code == 403
        assert "enterprise" in r.json()["error"]["message"].lower()

    # And nothing was created for it to abuse — no leftover oauth_states row.
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        n = (
            await conn.execute(
                text("SELECT count(*) FROM oauth_states WHERE org_id = :o"), {"o": ORG}
            )
        ).scalar_one()
    assert n == 0


async def test_connect_start_teams_uses_the_central_server_app_with_no_org_setup(
    db_app, monkeypatch
):
    # Members do not need workspace credentials. A central app serves every
    # workspace, including members without an org_admin role.
    from app.config import settings

    monkeypatch.setattr(settings, "ms_client_id", "central-app-id")
    monkeypatch.setattr(settings, "ms_client_secret", "central-app-secret")
    monkeypatch.setattr(settings, "ms_tenant", "common")

    async with await _client(_principal(plan="enterprise", roles=[])) as c:
        r = await c.post("/api/v1/integrations/teams/connect/start", json={})
        assert r.status_code == 200, r.text
        query = parse_qs(urlsplit(r.json()["authorizeUrl"]).query)
        assert query["client_id"] == ["central-app-id"]
        assert urlsplit(r.json()["authorizeUrl"]).netloc == "login.microsoftonline.com"
        assert urlsplit(r.json()["authorizeUrl"]).path == "/common/oauth2/v2.0/authorize"
        assert "central-app-secret" not in r.json()["authorizeUrl"]

    # A SECOND, unrelated org gets the exact same treatment — proving this
    # isn't a credential some earlier test/row left behind for THIS org.
    async with await _client(_principal(org_id=OTHER_ORG, plan="enterprise", roles=[])) as c:
        r = await c.post("/api/v1/integrations/teams/connect/start", json={})
        assert r.status_code == 200, r.text
        assert parse_qs(urlsplit(r.json()["authorizeUrl"]).query)["client_id"] == [
            "central-app-id"
        ]


async def test_the_oauth_state_is_pinned_to_the_credential_row(db_app):
    """A secret rotated mid-consent must not break an in-flight code exchange."""
    async with await _client() as c:
        await c.put(
            "/api/v1/integrations/app-credentials/google",
            json={"clientId": "id-v1", "clientSecret": "secret-v1"},
        )
        assert (
            await c.post("/api/v1/integrations/gmail/connect/start", json={})
        ).status_code == 200

    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        row = (
            await conn.execute(
                text(
                    "SELECT s.app_credential_id, c.id AS cred_id "
                    "  FROM oauth_states s "
                    "  JOIN provider_app_credentials c ON c.org_id = s.org_id "
                    " WHERE s.org_id = :o AND c.vendor = 'google'"
                ),
                {"o": ORG},
            )
        ).one()
    # Without the pin, the callback would re-resolve by (org, vendor) and redeem
    # the code against whatever secret is current — failing with invalid_client.
    assert row.app_credential_id is not None
    assert str(row.app_credential_id) == str(row.cred_id)


# ── per-connection webhook tokens ─────────────────────────────────────────────
async def _make_connection(org_id: str, provider: str, token: str, account: str) -> str:
    """Insert a connected row directly — the connect endpoint would call out to
    Slack/Meta to validate credentials, which this test isn't about."""
    from crypto import cryptor
    from app.db import get_engine

    conn_id = str(uuid6.uuid7())
    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text(
                """
                INSERT INTO integration_connections
                    (id, org_id, owner_user_id, created_by, scope_kind, provider,
                     status, display_label, external_account_id_bidx, webhook_token)
                VALUES (:id, :o, NULL, :u, 'org', :p, 'connected', 'T', :b, :t)
                """
            ),
            {
                "id": conn_id,
                "o": org_id,
                "u": ME,
                "p": provider,
                "b": cryptor().blind_index(account),
                "t": token,
            },
        )
    return conn_id


async def test_webhook_tokens_are_globally_unique(db_app):
    import asyncpg
    import sqlalchemy.exc

    await _make_connection(ORG, "slack", "collide", "T-1")
    # The lookup happens with NO org context, so the token alone must identify
    # one row — a duplicate across orgs would make resolution ambiguous.
    with pytest.raises((sqlalchemy.exc.IntegrityError, asyncpg.UniqueViolationError)):
        await _make_connection(OTHER_ORG, "gmail", "collide", "T-2")
