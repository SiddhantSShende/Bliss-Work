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

import httpx

from ..config import settings
from ..resilience import CircuitBreaker, retry_async

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


# ── PKCE ──────────────────────────────────────────────────────────────────────
def pkce_challenge(verifier: str) -> str:
    """S256 code challenge for a verifier (base64url, no padding)."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def new_pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).rstrip(b"=").decode("ascii")
    return verifier, pkce_challenge(verifier)


# ── Per-provider config ───────────────────────────────────────────────────────
def config_for(provider: str) -> OAuthConfig | None:
    """Return the OAuth config for a provider, or None when its client credentials
    aren't configured on this server (the provider then reports 'not configured')."""
    if provider == "gmail":
        if not (settings.google_client_id and settings.google_client_secret):
            return None
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
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
            extra_authorize={"access_type": "offline", "prompt": "consent"},
            identity_field="email",
            identity_name_field="email",
        )
    if provider in ("outlook", "teams"):
        if not (settings.ms_client_id and settings.ms_client_secret):
            return None
        tenant = settings.ms_tenant or "common"
        graph_scopes = {"outlook": ["Mail.Read", "Mail.Send"], "teams": ["Chat.ReadWrite"]}[provider]
        return OAuthConfig(
            name=provider,
            authorize_endpoint=f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize",
            token_endpoint=f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
            userinfo_endpoint="https://graph.microsoft.com/v1.0/me",
            scopes=["openid", "email", "offline_access", "User.Read", *graph_scopes],
            client_id=settings.ms_client_id,
            client_secret=settings.ms_client_secret,
            identity_field="mail",
            identity_name_field="userPrincipalName",
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


async def exchange_code(cfg: OAuthConfig, code: str, verifier: str, redirect_uri: str) -> dict:
    """Swap an authorization code for tokens. Returns the token response
    ({access_token, refresh_token?, expires_in, scope, ...})."""

    async def _attempt() -> dict:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
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
            )
            if r.status_code == 200:
                return r.json()
            try:
                body = r.json()
                msg = body.get("error_description") or body.get("error") or r.text
            except Exception:  # noqa: BLE001
                msg = r.text
            raise OAuthError(f"{r.status_code}: {msg}")

    return await retry_async(_attempt, attempts=3, breaker=_oauth_breaker)


async def refresh_access_token(cfg: OAuthConfig, refresh_token: str) -> dict:
    """Exchange a refresh token for a fresh access token. Google keeps the same
    refresh token; Microsoft rotates it (returns a new one to store). Raises
    OAuthError on a definitive failure (e.g. invalid_grant = revoked)."""

    async def _attempt() -> dict:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
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
            )
            if r.status_code == 200:
                return r.json()
            try:
                body = r.json()
                msg = body.get("error_description") or body.get("error") or r.text
            except Exception:  # noqa: BLE001
                msg = r.text
            raise OAuthError(f"{r.status_code}: {msg}")

    return await retry_async(_attempt, attempts=3, breaker=_oauth_breaker)


async def fetch_identity(cfg: OAuthConfig, access_token: str) -> tuple[str, str]:
    """Resolve (external_account_id, display_label) from the userinfo/Graph endpoint."""

    async def _attempt() -> dict:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.get(
                cfg.userinfo_endpoint, headers={"Authorization": f"Bearer {access_token}"}
            )
            r.raise_for_status()
            return r.json()

    info = await retry_async(_attempt, attempts=3, breaker=_oauth_breaker)
    account_id = info.get(cfg.identity_field) or info.get(cfg.identity_name_field) or ""
    label = info.get(cfg.identity_name_field) or account_id or cfg.name
    return str(account_id), str(label)
