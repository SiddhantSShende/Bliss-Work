from __future__ import annotations

from pydantic import BaseModel


class ConnectionOut(BaseModel):
    """A connected external account. NEVER includes tokens."""

    id: str
    provider: str
    status: str
    scopeKind: str
    displayLabel: str
    scopes: list[str]
    lastError: str | None = None
    #: Per-connection webhook URL to paste into the provider's dashboard. Present
    #: only for providers that receive webhooks (Slack, WhatsApp). Not a secret
    #: on its own — the provider's HMAC signature still authenticates every
    #: request — it only identifies which connection a delivery belongs to.
    webhookUrl: str | None = None
    #: WhatsApp only: the `hub.verify_token` to paste into the Meta dashboard.
    #: Generated server-side (a user-chosen one is reliably weak). Returned to
    #: the connection's own org because the admin has to read it to complete
    #: setup, and cannot re-derive it. It grants nothing on its own — it only
    #: lets its holder answer OUR verification handshake, which already requires
    #: knowing the per-connection webhook URL.
    webhookVerifyToken: str | None = None
    createdAt: str
    updatedAt: str


class ConnectStartOut(BaseModel):
    # OAuth providers return a URL to redirect the user to; token-paste providers
    # return the created connection directly.
    authorizeUrl: str | None = None
    connection: ConnectionOut | None = None


class ProviderActivityOut(BaseModel):
    """One row of the unified hub activity timeline (inbound + outbound)."""

    id: str
    provider: str
    direction: str  # 'inbound' | 'outbound'
    kind: str  # 'message' | 'call' | 'email'
    peer: str
    body: str
    status: str | None = None
    occurredAt: str


class MentionOut(BaseModel):
    """One @-mention of the caller on a connected external account.

    peer/body are decrypted server-side for display; the raw provider payload
    never leaves the service. `taskId` is set once the mention is claimed.
    """

    id: str
    provider: str
    kind: str  # 'message' | 'email'
    peer: str
    body: str
    threadRef: str | None = None
    permalink: str | None = None
    state: str  # 'pending' | 'claimed' | 'ignored'
    taskId: str | None = None
    occurredAt: str


class MentionPageOut(BaseModel):
    """Keyset page of mentions, newest first. `nextCursor` is opaque — pass it
    back verbatim; null means this was the last page."""

    items: list[MentionOut]
    nextCursor: str | None = None


class ClaimOut(BaseModel):
    taskId: str
    state: str


class StateOut(BaseModel):
    state: str


class IdentityOut(BaseModel):
    """A handle the caller owns on an external platform. Drives mention matching."""

    id: str
    provider: str
    handleKind: str
    handle: str
    source: str  # 'oauth' (self-proving) | 'declared' (typed in)
    verified: bool
    createdAt: str


class IdentityIn(BaseModel):
    provider: str
    handle: str


class AppCredentialOut(BaseModel):
    """One vendor's OAuth-app setup for this workspace. NEVER includes the secret.

    `clientId` IS returned: it isn't secret (it travels in the authorize URL the
    user's browser follows) and it's the only way an admin can confirm which app
    is wired up without re-pasting everything.
    """

    vendor: str  # 'google' | 'microsoft'
    configured: bool
    #: 'org' = this workspace's own app, 'server' = the deployment-wide fallback,
    #: None = nothing configured. Shown so an admin can tell whose app is in use.
    source: str | None = None
    clientId: str = ""
    tenant: str | None = None
    pubsubTopic: str | None = None
    updatedAt: str | None = None
    #: Which providers these credentials unlock (microsoft → outlook + teams).
    providers: list[str] = []
    #: The exact redirect URI to register in the vendor's console. Getting this
    #: wrong is the single most common OAuth setup failure, so we hand over the
    #: literal string rather than describing how to build it.
    redirectUris: list[str] = []


class AppCredentialIn(BaseModel):
    clientId: str
    clientSecret: str
    #: Microsoft single-tenant apps only; omit for multi-tenant ('common').
    tenant: str | None = None
    #: Google only: the Pub/Sub topic Gmail push notifications publish to.
    pubsubTopic: str | None = None
