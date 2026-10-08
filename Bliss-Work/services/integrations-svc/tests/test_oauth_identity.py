"""OAuth identity → mention handles.

Connecting an account must make the connecting user immediately taggable, so the
handles we derive have to match what the provider actually puts in its payloads.
The subtle one is Teams: `chatMessage.mentions[].mentioned.user.id` is an AAD
OBJECT ID, not an address, so registering only the mailbox would silently never
match a Teams mention.
"""

from dataclasses import FrozenInstanceError, dataclass

import pytest

from app.providers import oauth


@dataclass
class _Creds:
    """A stand-in for one org's OAuth app.

    `config_for` takes credentials as an argument (they come from the org's own
    `provider_app_credentials` row), so these tests supply them directly rather
    than monkeypatching server settings.
    """

    client_id: str = "cid"
    client_secret: str = "csecret"
    tenant: str | None = None


@pytest.fixture
def creds():
    return _Creds()


def test_gmail_tags_by_email_address(creds):
    cfg = oauth.config_for("gmail", creds)
    assert cfg is not None
    assert cfg.identity_handle_fields == (("email", "email"),)


@pytest.mark.parametrize("provider", ["outlook", "teams"])
def test_microsoft_registers_the_aad_object_id_and_the_mailbox(creds, provider):
    cfg = oauth.config_for(provider, creds)
    assert cfg is not None
    kinds = dict((field, kind) for kind, field in cfg.identity_handle_fields)
    # Teams mentions carry `id`; Outlook mail addresses `mail`/UPN.
    assert kinds["id"] == "account"
    assert kinds["mail"] == "email"
    assert kinds["userPrincipalName"] == "email"


def test_unconfigured_provider_has_no_config():
    # No org credentials → the provider is simply not connectable.
    assert oauth.config_for("gmail", None) is None


def test_identity_is_immutable():
    ident = oauth.Identity(account_id="a", label="b", handles=(("email", "x@y.z"),))
    with pytest.raises(FrozenInstanceError):
        ident.account_id = "c"  # type: ignore[misc]


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _Client:
    """Minimal async httpx.AsyncClient stand-in for fetch_identity."""

    def __init__(self, payload):
        self._payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, *_a, **_kw):
        return _Resp(self._payload)


def _patch_userinfo(monkeypatch, payload):
    monkeypatch.setattr(oauth.httpx, "AsyncClient", lambda **_kw: _Client(payload))


async def test_fetch_identity_derives_gmail_handle(creds, monkeypatch):
    _patch_userinfo(monkeypatch, {"email": "me@acme.com"})
    ident = await oauth.fetch_identity(oauth.config_for("gmail", creds), "tok")
    assert ident.account_id == "me@acme.com"
    assert ident.handles == (("email", "me@acme.com"),)


async def test_fetch_identity_dedupes_mail_and_upn(creds, monkeypatch):
    # Graph very often returns the same string in both fields; storing it twice
    # would be two rows fighting over one unique index.
    _patch_userinfo(
        monkeypatch,
        {"id": "aad-oid", "mail": "me@acme.com", "userPrincipalName": "me@acme.com"},
    )
    ident = await oauth.fetch_identity(oauth.config_for("teams", creds), "tok")
    assert ident.handles == (("account", "aad-oid"), ("email", "me@acme.com"))


async def test_fetch_identity_skips_missing_fields(creds, monkeypatch):
    _patch_userinfo(monkeypatch, {"id": "aad-oid", "userPrincipalName": "me@acme.com"})
    ident = await oauth.fetch_identity(oauth.config_for("outlook", creds), "tok")
    assert ident.handles == (("account", "aad-oid"), ("email", "me@acme.com"))


async def test_fetch_identity_tolerates_an_empty_userinfo_response(creds, monkeypatch):
    # A provider that returns nothing useful must not crash the callback — the
    # connection is still valid, it just has no auto-derived handles.
    _patch_userinfo(monkeypatch, {})
    ident = await oauth.fetch_identity(oauth.config_for("gmail", creds), "tok")
    assert ident.handles == ()
    assert ident.label == "gmail"
