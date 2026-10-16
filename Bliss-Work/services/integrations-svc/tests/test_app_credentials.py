"""OAuth app credential resolution — pure parts.

`config_for` converts resolved credentials into an authorize URL. Google may
use workspace credentials; Microsoft uses the central service configuration.
These tests cover resolution rules and the OAuth config builder.
"""

from dataclasses import dataclass

import pytest

from app import app_credentials
from app.config import settings
from app.providers import oauth


@dataclass
class FakeCreds:
    """Structural stand-in for app_credentials.AppCredentials.

    `config_for` takes a Protocol precisely so this file needs no DB, no crypto
    and no settings import.
    """

    client_id: str = "client-abc"
    client_secret: str = "secret-xyz"
    tenant: str | None = None


# ── vendor mapping ────────────────────────────────────────────────────────────
def test_teams_uses_the_microsoft_app():
    assert app_credentials.vendor_for("teams") == "microsoft"
    assert app_credentials.providers_for("microsoft") == ["teams"]


def test_gmail_maps_to_google():
    assert app_credentials.vendor_for("gmail") == "google"
    assert app_credentials.providers_for("google") == ["gmail"]


@pytest.mark.parametrize("provider", ["slack", "nonsense", ""])
def test_non_oauth_providers_have_no_vendor(provider):
    # Slack is token-paste; asking for its OAuth vendor must return None rather
    # than silently picking one.
    assert app_credentials.vendor_for(provider) is None


# ── config_for ────────────────────────────────────────────────────────────────
def test_gmail_config_uses_the_supplied_credentials():
    cfg = oauth.config_for("gmail", FakeCreds())
    assert cfg is not None
    assert cfg.client_id == "client-abc"
    assert cfg.client_secret == "secret-xyz"
    # offline + forced consent, or Google returns no refresh token on re-auth
    # and the connection dies silently an hour later.
    assert cfg.extra_authorize == {"access_type": "offline", "prompt": "consent"}


def test_teams_honors_a_single_tenant_id():
    cfg = oauth.config_for("teams", FakeCreds(tenant="contoso.onmicrosoft.com"))
    assert cfg is not None
    assert "/contoso.onmicrosoft.com/" in cfg.authorize_endpoint
    assert "/common/" not in cfg.authorize_endpoint


def test_teams_requests_chat_scope():
    teams = oauth.config_for("teams", FakeCreds())
    assert "Chat.ReadWrite" in teams.scopes
    # Needed or there is no refresh token to renew with.
    assert "offline_access" in teams.scopes


@pytest.mark.parametrize(
    "creds",
    [
        None,
        FakeCreds(client_id=""),
        FakeCreds(client_secret=""),
        FakeCreds(client_id="", client_secret=""),
    ],
)
@pytest.mark.parametrize("provider", ["gmail", "teams"])
def test_missing_credentials_return_none(provider, creds):
    # Returning None is what makes connect_start answer "not set up yet".
    # Building a config with an empty client_id instead would emit an authorize
    # URL that dies at the provider with an error the user cannot act on.
    assert oauth.config_for(provider, creds) is None


@pytest.mark.parametrize("provider", ["slack", "unknown"])
def test_non_oauth_providers_have_no_config(provider):
    assert oauth.config_for(provider, FakeCreds()) is None


def test_config_for_is_pure():
    # No I/O, no settings read — the credential source must be visible at the
    # call site. Two calls with the same input give the same output.
    a = oauth.config_for("gmail", FakeCreds())
    b = oauth.config_for("gmail", FakeCreds())
    assert a == b


# ── authorize URL ─────────────────────────────────────────────────────────────
def test_authorize_url_carries_the_org_client_id_and_pkce():
    cfg = oauth.config_for("gmail", FakeCreds(client_id="org-specific-id"))
    url = oauth.authorize_url(cfg, "state123", "challenge456", "https://x.example/cb")
    assert "client_id=org-specific-id" in url
    assert "state=state123" in url
    assert "code_challenge=challenge456" in url
    assert "code_challenge_method=S256" in url


def test_authorize_url_never_contains_the_client_secret():
    # The authorize URL is followed by the user's BROWSER. A secret here would
    # be in their history, the referrer chain, and any proxy log in between.
    cfg = oauth.config_for("gmail", FakeCreds(client_secret="super-secret-value"))
    url = oauth.authorize_url(cfg, "s", "c", "https://x.example/cb")
    assert "super-secret-value" not in url


@pytest.mark.asyncio
async def test_microsoft_load_uses_central_credentials_without_database(monkeypatch):
    class NoDatabaseAccess:
        async def execute(self, *_args, **_kwargs):
            raise AssertionError("Microsoft credential lookup must not query workspace rows")

    monkeypatch.setattr(settings, "ms_client_id", "central-client")
    monkeypatch.setattr(settings, "ms_client_secret", "central-secret")
    monkeypatch.setattr(settings, "ms_tenant", "common")

    creds = await app_credentials.load(NoDatabaseAccess(), "org-id", "microsoft")

    assert creds is not None
    assert creds.client_id == "central-client"
    assert creds.client_secret == "central-secret"
    assert creds.tenant == "common"
    assert creds.id is None


@pytest.mark.asyncio
async def test_microsoft_load_without_central_credentials_returns_none(monkeypatch):
    class NoDatabaseAccess:
        async def execute(self, *_args, **_kwargs):
            raise AssertionError("Microsoft credential lookup must not query workspace rows")

    monkeypatch.setattr(settings, "ms_client_id", "")
    monkeypatch.setattr(settings, "ms_client_secret", "central-secret")

    assert await app_credentials.load(NoDatabaseAccess(), "org-id", "microsoft") is None


class _FakeSession:
    def __init__(self, db):
        self.db = db

    async def __aenter__(self):
        return self.db

    async def __aexit__(self, *_exc):
        return False


class _FakeConnectDb:
    def __init__(self):
        self.executed = []

    async def execute(self, statement, params=None):
        self.executed.append((str(statement), params))

    async def commit(self):
        pass


def _connect_request():
    from starlette.requests import Request

    async def receive():
        return {"type": "http.request", "body": b"{}", "more_body": False}

    return Request(
        {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "path": "/api/v1/integrations/teams/connect/start",
            "query_string": b"",
            "headers": [(b"content-type", b"application/json")],
            "server": ("test", 443),
            "client": ("test", 1234),
        },
        receive,
    )


@pytest.mark.asyncio
async def test_teams_connect_start_uses_central_credentials_for_a_member(monkeypatch):
    from urllib.parse import parse_qs, urlsplit

    from starlette.responses import Response

    from app.auth import Principal
    from app.routes import integrations as integrations_route

    async def set_org_context(*_args):
        pass

    monkeypatch.setattr(settings, "ms_client_id", "central-client")
    monkeypatch.setattr(settings, "ms_client_secret", "central-secret")
    monkeypatch.setattr(settings, "ms_tenant", "org-tenant")
    monkeypatch.setattr(settings, "public_base_url", "https://bliss.example")
    monkeypatch.setattr(integrations_route, "set_org_context", set_org_context)

    class FakeCryptor:
        async def encrypt(self, _db, _org, value):
            return f"encrypted:{value}".encode()

    monkeypatch.setattr(integrations_route, "cryptor", FakeCryptor)
    db = _FakeConnectDb()
    monkeypatch.setattr(integrations_route, "session", lambda: _FakeSession(db))

    result = await integrations_route.connect_start(
        "teams",
        _connect_request(),
        Response(),
        Principal(
            user_id="member-id", org_id="workspace-id", roles=[], username="member",
            plan="enterprise",
        ),
    )

    parsed = urlsplit(result.authorizeUrl)
    query = parse_qs(parsed.query)
    assert parsed.netloc == "login.microsoftonline.com"
    assert parsed.path == "/org-tenant/oauth2/v2.0/authorize"
    assert query["client_id"] == ["central-client"]
    assert query["redirect_uri"] == [
        "https://bliss.example/ext/teams/oauth/callback"
    ]
    assert query["code_challenge_method"] == ["S256"]
    assert query["code_challenge"][0]
    assert query["state"][0]
    assert "central-secret" not in result.authorizeUrl
    assert len(db.executed) == 1
    statement, params = db.executed[0]
    assert "INSERT INTO oauth_states" in statement
    assert params["o"] == "workspace-id"
    assert params["u"] == "member-id"
    assert params["ac"] is None
    assert params["cid"] == b"encrypted:central-client"
    assert params["csec"] == b"encrypted:central-secret"


@pytest.mark.asyncio
async def test_teams_connect_start_without_central_credentials_is_actionable(
    monkeypatch,
):
    from fastapi import HTTPException
    from starlette.responses import Response

    from app.auth import Principal
    from app.routes import integrations as integrations_route

    async def set_org_context(*_args):
        pass

    monkeypatch.setattr(settings, "ms_client_id", "")
    monkeypatch.setattr(settings, "ms_client_secret", "")
    monkeypatch.setattr(integrations_route, "set_org_context", set_org_context)
    db = _FakeConnectDb()
    monkeypatch.setattr(integrations_route, "session", lambda: _FakeSession(db))

    with pytest.raises(HTTPException) as exc_info:
        await integrations_route.connect_start(
            "teams",
            _connect_request(),
            Response(),
            Principal(
                user_id="member-id", org_id="workspace-id", roles=[], username="member",
                plan="enterprise",
            ),
        )

    assert exc_info.value.status_code == 409
    assert "isn't set up for this workspace yet" in str(exc_info.value.detail).lower()
    assert db.executed == []
