"""Per-org OAuth app credentials — the setup step before anyone can connect.

Endpoints (all under /api/v1, JWT-verified, org-scoped via RLS):
  GET    /integrations/app-credentials           → every vendor's setup state
  PUT    /integrations/app-credentials/{vendor}  → save/rotate an org's app
  DELETE /integrations/app-credentials/{vendor}  → remove it

Integrations are user-driven: an org registers its OWN Google Cloud / Entra
app and pastes the client id + secret here. The secret is encrypted with the
per-org envelope Cryptor before it touches the database and is NEVER returned
to a client — not even to the admin who set it. Rotation is a re-PUT.

NOTE — do NOT add `@limiter.limit` decorators to the PUT below. Under
`from __future__ import annotations` slowapi's decorator breaks FastAPI's body
parsing for routes with a pydantic body (the same bug already documented in
routes/mentions.py). These are admin-frequency endpoints behind JWT auth; the
gateway's global limits cover them.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response, status

from .. import app_credentials
from ..auth import PrincipalDep, Principal
from ..config import settings
from ..db import session, set_org_context
from ..schemas import AppCredentialIn, AppCredentialOut

router = APIRouter()


def _redirect_uris(vendor: str) -> list[str]:
    """The literal redirect URIs to register in the vendor's console.

    One per provider, because Google and Microsoft both match the redirect_uri
    EXACTLY — a trailing slash or a missing path is `redirect_uri_mismatch`,
    which is by far the most common setup failure. Microsoft needs two (outlook
    and teams) from the one app registration.
    """
    base = settings.public_base_url.rstrip("/")
    return [f"{base}/ext/{p}/oauth/callback" for p in app_credentials.providers_for(vendor)]


def _require_vendor(vendor: str) -> str:
    if vendor not in app_credentials.VENDORS:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"unknown vendor (expected one of: {', '.join(app_credentials.VENDORS)})",
        )
    return vendor


@router.get("/integrations/app-credentials", response_model=list[AppCredentialOut])
async def list_app_credentials(principal: Principal = PrincipalDep) -> list[AppCredentialOut]:
    """Setup state for every vendor, including the redirect URIs to register.

    Returned to any org member rather than admins only: the client ID is not a
    secret, and a member who cannot see whether Gmail is set up cannot tell the
    difference between "not configured" and "broken" when Connect fails.
    """
    async with session() as db:
        await set_org_context(db, principal.org_id)
        rows = await app_credentials.describe_all(db, principal.org_id)
    return [AppCredentialOut(**row, redirectUris=_redirect_uris(row["vendor"])) for row in rows]


@router.put("/integrations/app-credentials/{vendor}", response_model=AppCredentialOut)
async def put_app_credentials(
    vendor: str, body: AppCredentialIn, principal: Principal = PrincipalDep
) -> AppCredentialOut:
    _require_vendor(vendor)

    client_id = body.clientId.strip()
    client_secret = body.clientSecret.strip()
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="clientId and clientSecret are both required",
        )

    # Reject the placeholder text people paste from documentation. Without this
    # the failure surfaces much later, as an opaque provider error mid-consent.
    if client_secret.lower() in {"your-client-secret", "client-secret", "xxx", "changeme"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="that looks like placeholder text, not a real client secret",
        )

    tenant = (body.tenant or "").strip() or None
    pubsub_topic = (body.pubsubTopic or "").strip() or None
    if vendor == "google" and tenant:
        # Fail loudly rather than storing a value that will never be read —
        # otherwise an admin thinks they configured something that has no effect.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="tenant applies to Microsoft only",
        )
    if vendor == "microsoft" and pubsub_topic:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="pubsubTopic applies to Google only",
        )

    async with session() as db:
        await set_org_context(db, principal.org_id)  # FIRST — RLS + org_keys
        await app_credentials.save(
            db,
            org_id=principal.org_id,
            vendor=vendor,
            client_id=client_id,
            client_secret=client_secret,
            user_id=principal.user_id,
            tenant=tenant,
            pubsub_topic=pubsub_topic,
        )
        # Read back through the same path the GET uses, so the response can't
        # drift from what a later refresh shows.
        rows = await app_credentials.describe_all(db, principal.org_id)
        await db.commit()

    row = next(r for r in rows if r["vendor"] == vendor)
    return AppCredentialOut(**row, redirectUris=_redirect_uris(vendor))


@router.delete("/integrations/app-credentials/{vendor}")
async def delete_app_credentials(vendor: str, principal: Principal = PrincipalDep) -> Response:
    _require_vendor(vendor)
    async with session() as db:
        await set_org_context(db, principal.org_id)
        removed = await app_credentials.delete(db, principal.org_id, vendor)
        await db.commit()
    if not removed:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not configured")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
