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
