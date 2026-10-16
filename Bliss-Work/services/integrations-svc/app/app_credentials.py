"""OAuth app credentials.

Google OAuth credentials may be configured per org. Microsoft OAuth always
uses the centrally managed BlissWork application from service settings. This
module is the only place that reads or writes `provider_app_credentials`;
`providers/oauth.py` stays a pure config builder and takes resolved credentials
as an argument.

SECURITY — read before adding a query here
──────────────────────────────────────────
The OAuth callback runs under `set_bypass_rls` (it has no org context until it
has resolved the state), so RLS does NOT scope these queries. Every statement
below therefore carries an explicit `org_id = :org`. Dropping that turns a
lookup into a cross-tenant credential read.

VENDOR vs PROVIDER
──────────────────
Connections are keyed by PROVIDER ('gmail' | 'teams'). Gmail
credentials can be configured per org; Teams uses the centrally
managed Microsoft app from service settings. `vendor_for` maps each OAuth
provider to its vendor.
"""
from __future__ import annotations

from dataclasses import dataclass

import uuid6
from sqlalchemy import text

from .config import settings
from crypto import cryptor

#: provider → vendor. Providers absent from this map do not use OAuth at all
#: (slack is token-paste).
_VENDOR_FOR: dict[str, str] = {
    "gmail": "google",
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
    """Resolved OAuth app. `id` is None for server-configured credentials."""

    client_id: str
    client_secret: str
    tenant: str | None = None
    pubsub_topic: str | None = None
    id: str | None = None


def _env_fallback(vendor: str) -> AppCredentials | None:
    """Return centrally configured credentials, if available.

    Google uses this as a fallback when an org has no app. Microsoft uses this
    as its only supported credential source.
    """
    if vendor == "google" and settings.google_client_id and settings.google_client_secret:
        return AppCredentials(
            client_id=settings.google_client_id,
            client_secret=settings.google_client_secret,
        )
    if vendor == "microsoft" and settings.ms_client_id and settings.ms_client_secret:
        return AppCredentials(
            client_id=settings.ms_client_id,
            client_secret=settings.ms_client_secret,
            tenant=settings.ms_tenant or "common",
        )
    return None


async def load(db, org_id: str, vendor: str) -> AppCredentials | None:
    """Resolve the credentials to use for (org, vendor).

    Microsoft credentials are always centrally managed and never read from an
    org row. Google uses its org row first, then the server environment.
    """
    if vendor == "microsoft":
        return _env_fallback(vendor)

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
    """Load the exact credential row an existing connection was pinned to.

    Used by refresh for connections created before Microsoft credentials became
    centrally managed, so their refresh tokens remain paired with their issuer.
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
        if vendor == "microsoft":
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
            continue
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
