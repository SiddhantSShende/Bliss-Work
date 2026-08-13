"""Per-org OAuth app credentials.

Each org brings its OWN Google / Microsoft OAuth app rather than authorizing a
central Bliss-Work one. This module is the only place that reads or writes
`provider_app_credentials`; `providers/oauth.py` stays a pure config builder and
takes the resolved credentials as an argument.

SECURITY — read before adding a query here
──────────────────────────────────────────
The OAuth callback runs under `set_bypass_rls` (it has no org context until it
has resolved the state), so RLS does NOT scope these queries. Every statement
below therefore carries an explicit `org_id = :org`. Dropping that turns a
lookup into a cross-tenant credential read.

VENDOR vs PROVIDER
──────────────────
Credentials are keyed by VENDOR ('google' | 'microsoft'), while connections are
keyed by PROVIDER ('gmail' | 'outlook' | 'teams'). outlook and teams are the
same Entra app registration, so an org registers Microsoft once and both light
up. `vendor_for` is the mapping.
"""
from __future__ import annotations

from dataclasses import dataclass

import uuid6
from sqlalchemy import text

from .config import settings
from .crypto import cryptor

#: provider → vendor. Providers absent from this map do not use OAuth at all
#: (slack and whatsapp are token-paste).
_VENDOR_FOR: dict[str, str] = {
    "gmail": "google",
    "outlook": "microsoft",
    "teams": "microsoft",
}

VENDORS = ("google", "microsoft")


def vendor_for(provider: str) -> str | None:
    """Which OAuth vendor backs this provider, or None if it isn't an OAuth one."""
    return _VENDOR_FOR.get(provider)


def providers_for(vendor: str) -> list[str]:
    """Which providers a vendor's credentials unlock — for UI copy."""
    return sorted(p for p, v in _VENDOR_FOR.items() if v == vendor)


@dataclass(frozen=True)
class AppCredentials:
    """One org's OAuth app. `id` is None for the server-env fallback, which has
    no row to pin an oauth_state to."""

    client_id: str
    client_secret: str
    tenant: str | None = None
    pubsub_topic: str | None = None
    id: str | None = None
    #: True when these came from server env rather than the org's own row.
    is_fallback: bool = False


def _env_fallback(vendor: str) -> AppCredentials | None:
    """Server-level credentials, if configured.

    Retained so a self-hosted single-tenant deployment can supply one central
    app for everyone. An org's own row always wins over this.
    """
    if vendor == "google" and settings.google_client_id and settings.google_client_secret:
        return AppCredentials(
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
            is_fallback=True,
        )
    if vendor == "microsoft" and settings.ms_client_id and settings.ms_client_secret:
        return AppCredentials(
            client_id=settings.ms_client_id,
            client_secret=settings.ms_client_secret,
            tenant=settings.ms_tenant or "common",
            is_fallback=True,
        )
    return None


async def load(db, org_id: str, vendor: str) -> AppCredentials | None:
    """Resolve the credentials to use for (org, vendor).

    Order: the org's own row, then the server-env fallback, then None — which
    callers surface as "not configured yet" rather than a broken redirect.
    """
    row = (
        await db.execute(
            text(
                """
                SELECT id, client_id_enc, client_secret_enc, tenant, pubsub_topic
                  FROM provider_app_credentials
                 WHERE org_id = :org AND vendor = :v
                """
            ),
            {"org": org_id, "v": vendor},
        )
    ).one_or_none()

    if row is None:
        return _env_fallback(vendor)

    client_id = await cryptor().decrypt(db, org_id, bytes(row.client_id_enc))
    client_secret = await cryptor().decrypt(db, org_id, bytes(row.client_secret_enc))
    if not client_id or not client_secret:
        # A row that cannot be decrypted is worse than no row: it would produce
        # an authorize URL with an empty client_id and an unreadable provider
        # error. Fall back rather than emit that.
        return _env_fallback(vendor)

    return AppCredentials(
        client_id=client_id,
        client_secret=client_secret,
        tenant=row.tenant,
        pubsub_topic=row.pubsub_topic,
        id=str(row.id),
    )


async def load_by_id(db, org_id: str, credential_id: str) -> AppCredentials | None:
    """Load the exact credential row an in-flight OAuth state was pinned to.

    Used at callback time so a secret rotated mid-consent doesn't fail the code
    exchange with an opaque `invalid_client`.
    """
    row = (
        await db.execute(
            text(
                """
                SELECT id, client_id_enc, client_secret_enc, tenant, pubsub_topic
                  FROM provider_app_credentials
                 WHERE org_id = :org AND id = :id
                """
            ),
            {"org": org_id, "id": credential_id},
        )
    ).one_or_none()
    if row is None:
        return None

    client_id = await cryptor().decrypt(db, org_id, bytes(row.client_id_enc))
    client_secret = await cryptor().decrypt(db, org_id, bytes(row.client_secret_enc))
    if not client_id or not client_secret:
        return None

    return AppCredentials(
        client_id=client_id,
        client_secret=client_secret,
        tenant=row.tenant,
        pubsub_topic=row.pubsub_topic,
        id=str(row.id),
    )


async def save(
    db,
    *,
    org_id: str,
    vendor: str,
    client_id: str,
    client_secret: str,
    user_id: str,
    tenant: str | None = None,
    pubsub_topic: str | None = None,
) -> str:
    """Create or replace an org's app credentials. Returns the row id.

    Upsert rather than insert: re-saving is the rotation path, and an org must
    never end up with two rows for one vendor (the connect flow would have to
    pick one).
    """
    cid_enc = await cryptor().encrypt(db, org_id, client_id)
    sec_enc = await cryptor().encrypt(db, org_id, client_secret)
    row = (
        await db.execute(
            text(
                """
                INSERT INTO provider_app_credentials
                    (id, org_id, vendor, client_id_enc, client_secret_enc, tenant,
                     pubsub_topic, created_by, updated_by)
                VALUES (:id, :org, :v, :cid, :sec, :tenant, :topic, :uid, :uid)
                ON CONFLICT (org_id, vendor) DO UPDATE SET
                    client_id_enc     = EXCLUDED.client_id_enc,
                    client_secret_enc = EXCLUDED.client_secret_enc,
                    tenant            = EXCLUDED.tenant,
                    pubsub_topic      = EXCLUDED.pubsub_topic,
                    updated_by        = EXCLUDED.updated_by,
                    updated_at        = now()
                RETURNING id
                """
            ),
            {
                "id": str(uuid6.uuid7()),
                "org": org_id,
                "v": vendor,
                "cid": cid_enc,
                "sec": sec_enc,
                "tenant": tenant or None,
                "topic": pubsub_topic or None,
                "uid": user_id,
            },
        )
    ).one()
    return str(row.id)


async def delete(db, org_id: str, vendor: str) -> bool:
    """Remove an org's credentials. Returns False if there was nothing to remove.

    Existing connections are deliberately left alone: their stored access and
    refresh tokens keep working until they expire, and deleting them here would
    turn "I pasted the wrong secret" into "everyone in my org is disconnected".
    Refresh will fail once the app is gone, and the connection moves to 'error'
    through the normal path with a message the user can act on.
    """
    res = await db.execute(
        text("DELETE FROM provider_app_credentials WHERE org_id = :org AND vendor = :v"),
        {"org": org_id, "v": vendor},
    )
    return (res.rowcount or 0) > 0


async def describe_all(db, org_id: str) -> list[dict]:
    """Non-secret summary of every vendor, for the setup UI.

    NEVER returns client_secret. Returns the client_id, which is not secret (it
    is in the authorize URL the user's browser follows) and is the only way the
    admin can confirm which app is wired up without re-pasting it.
    """
    rows = (
        await db.execute(
            text(
                """
                SELECT id, vendor, client_id_enc, tenant, pubsub_topic, updated_at
                  FROM provider_app_credentials
                 WHERE org_id = :org
                """
            ),
            {"org": org_id},
        )
    ).all()
    by_vendor = {r.vendor: r for r in rows}

    out: list[dict] = []
    for vendor in VENDORS:
        row = by_vendor.get(vendor)
        fallback = _env_fallback(vendor)
        if row is not None:
            client_id = await cryptor().decrypt(db, org_id, bytes(row.client_id_enc))
            out.append(
                {
                    "vendor": vendor,
                    "configured": True,
                    "source": "org",
                    "clientId": client_id or "",
                    "tenant": row.tenant,
                    "pubsubTopic": row.pubsub_topic,
                    "updatedAt": row.updated_at.isoformat(),
                    "providers": providers_for(vendor),
                }
            )
        else:
            out.append(
                {
                    "vendor": vendor,
                    "configured": fallback is not None,
                    "source": "server" if fallback else None,
                    "clientId": fallback.client_id if fallback else "",
                    "tenant": fallback.tenant if fallback else None,
                    "pubsubTopic": None,
                    "updatedAt": None,
                    "providers": providers_for(vendor),
                }
            )
    return out
