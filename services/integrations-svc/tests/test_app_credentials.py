"""Per-org OAuth app credentials — the pure parts.

`config_for` is where an org's own client id/secret becomes an authorize URL.
It used to read server env directly; now it takes credentials as an argument,
which is what makes "every org brings its own app" possible. These tests cover
the mapping and the refusal cases; the DB round-trip is in the integration
suite.
"""

from dataclasses import dataclass

import pytest

from app import app_credentials
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
def test_outlook_and_teams_share_one_microsoft_app():
    # The whole reason credentials are keyed by vendor: an org registers ONE
    # Entra app and both providers light up. If these ever diverge, users would
    # have to create two identical app registrations and keep them in sync.
    assert app_credentials.vendor_for("outlook") == "microsoft"
    assert app_credentials.vendor_for("teams") == "microsoft"
    assert sorted(app_credentials.providers_for("microsoft")) == ["outlook", "teams"]


def test_gmail_maps_to_google():
    assert app_credentials.vendor_for("gmail") == "google"
    assert app_credentials.providers_for("google") == ["gmail"]


@pytest.mark.parametrize("provider", ["slack", "whatsapp", "nonsense", ""])
def test_non_oauth_providers_have_no_vendor(provider):
    # Slack and WhatsApp are token-paste; asking for their OAuth vendor must
    # return None rather than silently picking one.
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


def test_microsoft_defaults_to_the_common_tenant():
    cfg = oauth.config_for("outlook", FakeCreds(tenant=None))
    assert cfg is not None
    assert "/common/" in cfg.authorize_endpoint


def test_microsoft_honors_a_single_tenant_id():
    # A single-tenant app authorized via /common fails with AADSTS50194, which
    # is not self-explanatory — so the tenant has to reach the endpoint URL.
    cfg = oauth.config_for("teams", FakeCreds(tenant="contoso.onmicrosoft.com"))
    assert cfg is not None
    assert "/contoso.onmicrosoft.com/" in cfg.authorize_endpoint
    assert "/common/" not in cfg.authorize_endpoint


def test_teams_and_outlook_request_different_scopes():
    outlook = oauth.config_for("outlook", FakeCreds())
    teams = oauth.config_for("teams", FakeCreds())
    assert "Mail.Send" in outlook.scopes
    assert "Chat.ReadWrite" in teams.scopes
    # Both need offline_access or there is no refresh token to renew with.
    assert "offline_access" in outlook.scopes
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
@pytest.mark.parametrize("provider", ["gmail", "outlook", "teams"])
def test_missing_credentials_return_none(provider, creds):
    # Returning None is what makes connect_start answer "not set up yet".
    # Building a config with an empty client_id instead would emit an authorize
    # URL that dies at the provider with an error the user cannot act on.
    assert oauth.config_for(provider, creds) is None


@pytest.mark.parametrize("provider", ["slack", "whatsapp", "unknown"])
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
