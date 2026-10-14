"""Shared OAuth2 authorization-code flow (PKCE) for Gmail + Microsoft Graph.

Gmail (Google) and Outlook/Teams (Microsoft Graph) both use authorization-code +
PKCE + a confidential client secret. This module builds the authorize URL,
exchanges the code for tokens, and resolves the connected account's identity. The
app's own client credentials come from settings; per-user tokens are stored
encrypted per-connection by the caller.

The redirect URI is `{PUBLIC_BASE_URL}/ext/{provider}/oauth/callback` — it must be
externally reachable (Caddy routes /ext/* to this service) and registered exactly
in each provider's app config.
"""
from __future__ import annotations

import base64
import hashlib
import secrets
import urllib.parse
from dataclasses import dataclass, field
from typing import NoReturn, Protocol

import httpx

from ..config import settings
from resilience import CircuitBreaker, retry_async

from . import httpclient


class AppCredentialsLike(Protocol):
    """The shape `config_for` needs from a credential set.

    A structural type rather than an import of `app_credentials.AppCredentials`:
    that module imports `crypto`, which imports the DB layer, and this file is
    deliberately I/O-free so it can be unit-tested with a plain stub.
    """

    client_id: str
    client_secret: str
    tenant: str | None

_TIMEOUT = 10.0
_oauth_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="oauth")


class OAuthError(Exception):
    """A definitive OAuth failure (bad code, provider error)."""


@dataclass
class OAuthConfig:
    name: str
    authorize_endpoint: str
    token_endpoint: str
    userinfo_endpoint: str
    scopes: list[str]
    client_id: str
    client_secret: str
    # Provider-specific authorize params (Google: offline access + forced consent
    # so a refresh token is always returned).
    extra_authorize: dict = field(default_factory=dict)
    # Where to read the account identity from the userinfo/Graph response.
    identity_field: str = "email"
    identity_name_field: str = "email"
    # Which response fields become MENTION handles for this account, as
    # (handle_kind, field) pairs. These are what an inbound message must name
    # for it to count as tagging the connecting user, so they have to match what
    # the provider actually puts in its payloads: mail providers address people
    # by e-mail, but Teams mentions carry the AAD OBJECT ID, not the address.
    identity_handle_fields: tuple[tuple[str, str], ...] = (("email", "email"),)


# ── PKCE ──────────────────────────────────────────────────────────────────────
def pkce_challenge(verifier: str) -> str:
    """S256 code challenge for a verifier (base64url, no padding)."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def new_pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).rstrip(b"=").decode("ascii")
    return verifier, pkce_challenge(verifier)


def browser_session_cookie_name(state: str) -> str:
    suffix = hashlib.sha256(state.encode("utf-8")).hexdigest()[:32]
    return f"bw_oauth_{suffix}"


def browser_session_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def browser_session_matches(expected_hash: str | None, value: str | None) -> bool:
    return bool(
        expected_hash
        and value
        and secrets.compare_digest(expected_hash, browser_session_hash(value))
    )


# ── Per-provider config ───────────────────────────────────────────────────────
def config_for(provider: str, creds: AppCredentialsLike | None) -> OAuthConfig | None:
    """Build the OAuth config for a provider from an org's own app credentials.

    `creds` comes from `app_credentials.load(db, org_id, vendor)` — the org's own
    OAuth app, or the server-env fallback, or None. Passing None returns None,
    which callers surface as "not configured yet" rather than emitting an
    authorize URL with an empty client_id (which fails at the provider with an
    error the user cannot act on).

    This function stays PURE — no settings lookup, no I/O — so the credential
    source is always visible at the call site.
    """
    if creds is None or not creds.client_id or not creds.client_secret:
        return None

    if provider == "gmail":
        return OAuthConfig(
            name="gmail",
            authorize_endpoint="https://accounts.google.com/o/oauth2/v2/auth",
            token_endpoint="https://oauth2.googleapis.com/token",
            userinfo_endpoint="https://openidconnect.googleapis.com/v1/userinfo",
            scopes=[
                "openid",
                "email",
                "https://www.googleapis.com/auth/gmail.send",
                "https://www.googleapis.com/auth/gmail.readonly",
            ],
            client_id=creds.client_id,
            client_secret=creds.client_secret,
            extra_authorize={"access_type": "offline", "prompt": "consent"},
            identity_field="email",
            identity_name_field="email",
            identity_handle_fields=(("email", "email"),),
        )
    if provider in ("outlook", "teams"):
        # 'common' (multi-tenant) unless the org registered a single-tenant app
        # and supplied its tenant id. Getting this wrong is a very common Entra
        # setup failure: a single-tenant app authorized via /common returns
        # AADSTS50194 rather than anything self-explanatory.
        tenant = creds.tenant or "common"
        # Mail.ReadWrite (alongside Mail.Read/Mail.Send) is what lets a BlissWork-side
        # read/delete action write back to the connected user's own Outlook message
        # (mark read, move to Deleted Items) — see mail_sync_worker.py.
        graph_scopes = {
            "outlook": ["Mail.Read", "Mail.ReadWrite", "Mail.Send"],
            "teams": ["Chat.ReadWrite"],
        }[provider]
        return OAuthConfig(
            name=provider,
            authorize_endpoint=f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
            token_endpoint=f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
            userinfo_endpoint="https://graph.microsoft.com/v1.0/me",
            scopes=["openid", "email", "offline_access", "User.Read", *graph_scopes],
            client_id=creds.client_id,
            client_secret=creds.client_secret,
            identity_field="mail",
            identity_name_field="userPrincipalName",
            # Teams mentions reference the AAD object id; Outlook mail addresses
            # the mailbox. Register both so either style of tag resolves.
            identity_handle_fields=(
                ("account", "id"),
                ("email", "mail"),
                ("email", "userPrincipalName"),
            ),
        )
    return None


def redirect_uri_for(provider: str) -> str:
    base = settings.public_base_url.rstrip("/")
    return f"{base}/ext/{provider}/oauth/callback"


def authorize_url(cfg: OAuthConfig, state: str, challenge: str, redirect_uri: str) -> str:
    params = {
        "client_id": cfg.client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(cfg.scopes),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        **cfg.extra_authorize,
    }
    return cfg.authorize_endpoint + "?" + urllib.parse.urlencode(params)


def _raise_for_token_status(r: httpx.Response) -> NoReturn:
    """Classify a non-200 token-endpoint response.

    5xx and 429 are the endpoint throttling or unhealthy, not rejecting this
    specific code/refresh-token — raising via raise_for_status() keeps them as
    a plain httpx.HTTPStatusError, which resilience.is_transient() recognizes
    (letting retry_async retry a 5xx) and which callers like refresh_worker's
    `except oauth.OAuthError` does NOT catch, so it falls into their generic
    "transient, try again later" handling instead of being marked a definitive,
    terminal failure. Everything else (400 invalid_grant, 401, ...) is a real
    answer from the provider about this exact request and stays an OAuthError.
    """
    if r.status_code >= 500 or r.status_code == 429:
        r.raise_for_status()
    try:
        body = r.json()
        msg = body.get("error_description") or body.get("error") or r.text
    except Exception:  # noqa: BLE001
        msg = r.text
    raise OAuthError(f"{r.status_code}: {msg}")


async def exchange_code(cfg: OAuthConfig, code: str, verifier: str, redirect_uri: str) -> dict:
    """Swap an authorization code for tokens. Returns the token response
    ({access_token, refresh_token?, expires_in, scope, ...})."""

    async def _attempt() -> dict:
        r = await httpclient.shared().post(
            cfg.token_endpoint,
            data={
                "client_id": cfg.client_id,
                "client_secret": cfg.client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
                "code_verifier": verifier,
            },
            headers={"Accept": "application/json"},
            timeout=_TIMEOUT,
        )
        if r.status_code == 200:
            return r.json()
        _raise_for_token_status(r)

    # idempotent=False: authorization codes are single-use by spec. A
    # ReadTimeout after the provider already consumed the code must not be
    # retried with the same code — the retry would just fail with
    # invalid_grant instead of surfacing the original transient error.
    return await retry_async(_attempt, attempts=3, breaker=_oauth_breaker, idempotent=False)


async def refresh_access_token(cfg: OAuthConfig, refresh_token: str) -> dict:
    """Exchange a refresh token for a fresh access token. Google keeps the same
    refresh token; Microsoft rotates it (returns a new one to store). Raises
    OAuthError on a definitive failure (e.g. invalid_grant = revoked)."""

    async def _attempt() -> dict:
        r = await httpclient.shared().post(
            cfg.token_endpoint,
            data={
                "client_id": cfg.client_id,
                "client_secret": cfg.client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
                # Microsoft wants scope on refresh; Google ignores it.
                "scope": " ".join(cfg.scopes),
            },
            headers={"Accept": "application/json"},
            timeout=_TIMEOUT,
        )
        if r.status_code == 200:
            return r.json()
        _raise_for_token_status(r)

    # idempotent=False: Microsoft rotates the refresh token on every use (and
    # Google's is single-use per exchange in effect), so a ReadTimeout after
    # the provider already consumed this token must not be retried with the
    # same (now-stale) token — that would fail with invalid_grant and mark a
    # live connection as errored instead of surfacing the original timeout.
    return await retry_async(_attempt, attempts=3, breaker=_oauth_breaker, idempotent=False)


async def revoke_google_token(token: str) -> None:
    """Revoke a Google OAuth grant using its documented token-revocation API."""
    response = await httpclient.shared().post(
        "https://oauth2.googleapis.com/revoke",
        data={"token": token},
        timeout=_TIMEOUT,
    )
    response.raise_for_status()


@dataclass(frozen=True)
class Identity:
    """Who a connected account belongs to.

    `account_id`/`label` identify the CONNECTION; `handles` are the identifiers
    an inbound message can use to tag this person, which is what mention
    detection matches against.
    """

    account_id: str
    label: str
    handles: tuple[tuple[str, str], ...] = ()  # (handle_kind, value)


async def fetch_identity(cfg: OAuthConfig, access_token: str) -> Identity:
    """Resolve the connected account's identity from the userinfo/Graph endpoint."""

    async def _attempt() -> dict:
        r = await httpclient.shared().get(
            cfg.userinfo_endpoint,
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=_TIMEOUT,
        )
        r.raise_for_status()
        return r.json()

    info = await retry_async(_attempt, attempts=3, breaker=_oauth_breaker)
    account_id = info.get(cfg.identity_field) or info.get(cfg.identity_name_field) or ""
    label = info.get(cfg.identity_name_field) or account_id or cfg.name

    # Order-preserving dedupe: Graph often returns the same string in `mail` and
    # `userPrincipalName`, and storing it twice would just be two rows fighting
    # over one unique index.
    handles: list[tuple[str, str]] = []
    seen: set[str] = set()
    for kind, field_name in cfg.identity_handle_fields:
        value = str(info.get(field_name) or "").strip()
        if value and value.lower() not in seen:
            seen.add(value.lower())
            handles.append((kind, value))

    return Identity(account_id=str(account_id), label=str(label), handles=tuple(handles))
