"""Provider abstraction for external platforms.

Each provider declares how a user connects it (token-paste vs OAuth), which
credential fields to collect, and — in later phases — how to verify inbound
webhooks and send outbound messages. Phase 1 wires the token-paste connect flow
(Slack) end-to-end with encrypted-at-rest credential storage; OAuth
providers (Gmail, Outlook, Teams) are declared here and connect once their app
credentials + flows land.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

AuthKind = Literal["token_paste", "oauth2_code"]


@dataclass(frozen=True)
class ProviderField:
    """A credential input collected from the user (token-paste providers)."""

    key: str
    label: str
    # Secret fields are stored encrypted; non-secret ones (e.g. a phone-number id)
    # are still encrypted here since they sit in the same connection metadata blob.
    secret: bool = True


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    label: str
    auth_kind: AuthKind
    # The token field whose value becomes access_token_enc (primary credential).
    primary_field: str | None = None
    fields: tuple[ProviderField, ...] = field(default_factory=tuple)
    default_scopes: tuple[str, ...] = field(default_factory=tuple)
    # True when the provider delivers events by calling US. Those connections get
    # a per-connection webhook URL to paste into the provider's dashboard, so the
    # connection (and its signing secret) is resolvable from the path before any
    # payload is trusted. OAuth providers use push subscriptions instead.
    receives_webhooks: bool = False


# Registry keyed by provider id. The `provider` CHECK in 0001_init.sql must stay
# in sync with these keys.
PROVIDERS: dict[str, ProviderSpec] = {
    "slack": ProviderSpec(
        name="slack",
        label="Slack",
        auth_kind="token_paste",
        primary_field="botToken",
        fields=(
            ProviderField("botToken", "Bot token"),
            ProviderField("signingSecret", "Signing secret"),
        ),
        default_scopes=("chat:write", "channels:read", "users:read", "im:history"),
        # The inbound webhook receiver (routes/webhooks.py) was removed with Hub
        # Mentions, its only consumer — so this no longer advertises a
        # per-connection URL that would 404.
        receives_webhooks=False,
    ),
    # WhatsApp was here. It required a Meta Business account (system-user token,
    # WABA id, phone number id, app secret), which most orgs do not have and
    # cannot easily get, so in practice nobody could connect it. Removed
    # deliberately, not lost: it also did the inbound half (webhook -> Hub
    # mentions), so WhatsApp messages that tag you no longer reach the Hub.
    "gmail": ProviderSpec(
        name="gmail",
        label="Gmail",
        auth_kind="oauth2_code",
        default_scopes=(
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/gmail.readonly",
        ),
    ),
    "outlook": ProviderSpec(
        name="outlook",
        label="Outlook",
        auth_kind="oauth2_code",
        default_scopes=("Mail.Read", "Mail.Send", "offline_access"),
    ),
    "teams": ProviderSpec(
        name="teams",
        label="Microsoft Teams",
        auth_kind="oauth2_code",
        default_scopes=("Chat.ReadWrite", "offline_access"),
    ),
}


def get_provider(name: str) -> ProviderSpec | None:
    return PROVIDERS.get(name)
