"""Authenticated connection-management API for external integrations.

Endpoints (all under /api/v1, JWT-verified, org-scoped via RLS):
  GET    /integrations                         → list connections (no tokens)
  POST   /integrations/{provider}/connect/start→ token-paste: store encrypted &
                                                  return the connection; OAuth:
                                                  return an authorize URL
  DELETE /integrations/{id}                     → revoke + purge stored tokens

Credentials for token-paste providers are encrypted with the per-org envelope
Cryptor before they ever touch the database; tokens are never returned to a client.
"""
from __future__ import annotations

import json
import secrets

import uuid6
from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import text

from .. import app_credentials
from ..auth import PrincipalDep, Principal
from ..config import settings
from ..crypto import cryptor
from ..db import session, set_org_context
from ..providers import get_provider, oauth, slack, whatsapp
from ..schemas import ConnectionOut, ConnectStartOut, ProviderActivityOut

router = APIRouter()

# Token-paste providers share an app-wide credential (a bot token / business
# number) → org-wide. OAuth providers connect a single user's account → per-user.
_SCOPE_FOR = {"token_paste": "org", "oauth2_code": "user"}


def _webhook_url(provider: str, token: str | None) -> str | None:
    """The URL to paste into the provider's dashboard for THIS connection.

    None for providers that don't receive webhooks, and for pre-existing
    connections created before per-connection tokens existed — those keep
    working on the bare /ext/{provider}/webhook path.
    """
    spec = get_provider(provider)
    if not token or spec is None or not spec.receives_webhooks:
        return None
    return f"{settings.public_base_url.rstrip('/')}/ext/{provider}/webhook/{token}"


async def _existing_meta_field(
    db, org_id: str, provider: str, external_account_id: str | None, key: str
) -> str:
    """Read one field out of the encrypted metadata of the connection this
    connect would UPDATE, so values that must survive a re-connect can be
    carried over. Empty string when there is no such connection yet."""
    if not external_account_id:
        return ""
    row = (
        await db.execute(
            text(
                """
                SELECT metadata_enc FROM integration_connections
                 WHERE provider = :p AND external_account_id_bidx = :b
                 LIMIT 1
                """
            ),
            {"p": provider, "b": cryptor().blind_index(external_account_id)},
        )
    ).one_or_none()
    if not row or not row.metadata_enc:
        return ""
    plain = await cryptor().decrypt(db, org_id, bytes(row.metadata_enc))
    try:
        return str(json.loads(plain or "{}").get(key, "") or "")
    except (ValueError, TypeError):
        return ""


def _row_to_out(r, verify_token: str | None = None) -> ConnectionOut:
    # webhook_token is only selected on some queries; treat its absence as None
    # rather than requiring every SELECT to carry the column.
    token = getattr(r, "webhook_token", None)
    return ConnectionOut(
        webhookVerifyToken=verify_token or None,
        id=str(r.id),
        provider=r.provider,
        status=r.status,
        scopeKind=r.scope_kind,
        displayLabel=r.display_label,
        scopes=list(r.scopes or []),
        lastError=r.last_error,
        webhookUrl=_webhook_url(r.provider, token),
        createdAt=r.created_at.isoformat(),
        updatedAt=r.updated_at.isoformat(),
    )


@router.get("/integrations", response_model=list[ConnectionOut])
async def list_integrations(principal: Principal = PrincipalDep) -> list[ConnectionOut]:
    async with session() as db:
        await set_org_context(db, principal.org_id)
        res = await db.execute(
            text(
                """
                SELECT id, provider, status, scope_kind, display_label, scopes,
                       last_error, webhook_token, metadata_enc, created_at, updated_at
                  FROM integration_connections
                 WHERE status <> 'revoked'
                   AND (owner_user_id = :uid OR owner_user_id IS NULL)
                 ORDER BY created_at DESC
                """
            ),
            {"uid": principal.user_id},
        )
        rows = res.all()  # materialized — safe to run decrypt queries next

        out: list[ConnectionOut] = []
        for r in rows:
            # WhatsApp setup needs the verify token read back (the admin pastes
            # it into Meta), and it lives inside the encrypted metadata blob.
            # No other provider's metadata is ever decrypted here — that blob
            # holds access tokens and signing secrets, which must never leave.
            verify_token = None
            if r.provider == "whatsapp" and r.metadata_enc:
                plain = await cryptor().decrypt(db, principal.org_id, bytes(r.metadata_enc))
                try:
                    verify_token = json.loads(plain or "{}").get("verifyToken") or None
                except (ValueError, TypeError):
                    verify_token = None
            out.append(_row_to_out(r, verify_token))
        return out


@router.get("/integrations/activity", response_model=list[ProviderActivityOut])
async def hub_activity(principal: Principal = PrincipalDep) -> list[ProviderActivityOut]:
    """Unified hub timeline — inbound + outbound activity across the caller's (and
    org-wide) connected accounts, newest first. Peer/body are decrypted for display."""
    async with session() as db:
        await set_org_context(db, principal.org_id)
        rows = (
            await db.execute(
                text(
                    """
                    SELECT id, provider, direction, kind, peer_enc, body_enc, status, occurred_at
                      FROM provider_activity
                     WHERE owner_user_id = :uid OR owner_user_id IS NULL
                     ORDER BY occurred_at DESC
                     LIMIT 100
                    """
                ),
                {"uid": principal.user_id},
            )
        ).all()  # materialized — safe to run decrypt queries on the same session next
        out: list[ProviderActivityOut] = []
        for r in rows:
            peer = await cryptor().decrypt(db, principal.org_id, bytes(r.peer_enc) if r.peer_enc else None)
            body = await cryptor().decrypt(db, principal.org_id, bytes(r.body_enc) if r.body_enc else None)
            out.append(
                ProviderActivityOut(
                    id=str(r.id),
                    provider=r.provider,
                    direction=r.direction,
                    kind=r.kind,
                    peer=peer or "",
                    body=body or "",
                    status=r.status,
                    occurredAt=r.occurred_at.isoformat(),
                )
            )
        return out


@router.post("/integrations/{provider}/connect/start", response_model=ConnectStartOut)
async def connect_start(
    provider: str, request: Request, principal: Principal = PrincipalDep
) -> ConnectStartOut:
    spec = get_provider(provider)
    if spec is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown provider")

    # Parsed up front because BOTH branches need it now: token-paste reads the
    # credentials, OAuth reads `returnTo`.
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — an absent/!json body is simply "no options"
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid body")

    if spec.auth_kind == "oauth2_code":
        # Authorization-code + PKCE against THIS ORG'S OWN OAuth app. The org
        # registers its credentials first (PUT /integrations/app-credentials);
        # if they're missing, say so precisely rather than emitting a redirect
        # that dies at the provider with an error the user can't act on.
        vendor = app_credentials.vendor_for(provider)
        verifier, challenge = oauth.new_pkce()
        state = secrets.token_urlsafe(32)
        redirect_uri = oauth.redirect_uri_for(provider)
        # Where to send the browser once the provider redirects back. NEVER
        # store a client-supplied URL here — that would be an open redirect
        # signed by our own OAuth state. The client picks a MODE and we map it
        # to one of two server-known destinations.
        redirect_after = (
            "taskboard://oauth" if str(body.get("returnTo", "")) == "desktop" else "/app/integrations"
        )
        async with session() as db:
            await set_org_context(db, principal.org_id)  # FIRST — RLS + org_keys
            creds = await app_credentials.load(db, principal.org_id, vendor) if vendor else None
            cfg = oauth.config_for(provider, creds)
            if cfg is None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        f"{spec.label} isn't set up for this workspace yet. "
                        f"Add your {vendor or 'provider'} OAuth app credentials first."
                    ),
                )
            verifier_enc = await cryptor().encrypt(db, principal.org_id, verifier)
            await db.execute(
                text(
                    """
                    INSERT INTO oauth_states
                        (state, org_id, owner_user_id, provider, code_verifier_enc,
                         redirect_after, app_credential_id, expires_at)
                    VALUES (:s, :o, :u, :p, :v, :r, :ac, now() + interval '10 minutes')
                    """
                ),
                {
                    "s": state,
                    "o": principal.org_id,
                    "u": principal.user_id,
                    "p": provider,
                    "v": verifier_enc,
                    "r": redirect_after,
                    # Pin the flow to the exact credential row, so rotating the
                    # secret mid-consent doesn't fail the exchange. NULL for the
                    # server-env fallback, which has no row.
                    "ac": creds.id if creds else None,
                },
            )
            await db.commit()
        return ConnectStartOut(authorizeUrl=oauth.authorize_url(cfg, state, challenge, redirect_uri))

    # ── token-paste connect (body already parsed above) ───────────────────────
    missing = [f.key for f in spec.fields if not str(body.get(f.key, "")).strip()]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"missing credentials: {', '.join(missing)}",
        )

    scope_kind = _SCOPE_FOR[spec.auth_kind]
    owner = None if scope_kind == "org" else principal.user_id
    primary_val = str(body.get(spec.primary_field, "")) if spec.primary_field else ""
    # Keep only the declared fields, so we never persist stray client input.
    creds = {f.key: str(body.get(f.key, "")) for f in spec.fields}


    # Validate the credential against the provider where we can, and resolve the
    # external account identity (used as the connection label + dedupe key).
    display_label = spec.label
    external_account_id: str | None = None
    if provider == "slack":
        try:
            info = await slack.auth_test(primary_val)
        except slack.SlackError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Slack rejected the token: {exc}",
            )
        except Exception as exc:  # network/timeout — not the user's fault
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="couldn't reach Slack to validate the token",
            ) from exc
        display_label = str(info.get("team") or spec.label)
        external_account_id = info.get("team_id")
    elif provider == "whatsapp":
        # BUSINESS ACCOUNTS ONLY, and checked against Meta rather than assumed.
        # The Cloud API already puts personal accounts out of reach, but nothing
        # here previously distinguished a fully onboarded business from a number
        # still sitting in Meta's test state — both connected identically, and
        # only the second one silently failed later.
        pnid = str(body.get("phoneNumberId", "")).strip()
        waba_id = str(body.get("wabaId", "")).strip()
        try:
            biz = await whatsapp.check_business_account(primary_val, waba_id, pnid)
        except whatsapp.NotABusinessAccount as exc:
            # The credentials are fine; the ACCOUNT doesn't qualify. Saying
            # "WhatsApp rejected the credentials" here would send the admin
            # hunting for a typo in a token that is perfectly good.
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
        except whatsapp.WhatsAppPermissionError as exc:
            # Overwhelmingly the first failure of a real setup: sending needs
            # whatsapp_business_messaging, reading the account needs
            # whatsapp_business_management, and people grant only the first.
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
        except whatsapp.WhatsAppError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"WhatsApp rejected the credentials: {exc}",
            )
        except Exception as exc:  # network/timeout
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="couldn't reach WhatsApp to validate the credentials",
            ) from exc
        display_label = (
            biz.display_phone_number or biz.verified_name or biz.business_name or spec.label
        )
        # The business number (phone_number_id) is the connection's external account.
        external_account_id = pnid

    # WhatsApp lands as 'pending', not 'connected'. The checks above prove the
    # account is a real, approved business and that the token can read it — they
    # say nothing about whether the inbound webhook is wired, and a connection
    # that reads Connected while receiving nothing is worse than one that admits
    # it isn't ready. That last step is proven by Meta's own webhook verification
    # request (routes/webhooks.py::verify_webhook), which needs no phone number
    # from anybody. Until it lands, the connection is invisible to outbound
    # forwards (internal_send filters on status = 'connected').
    initial_status = "pending" if provider == "whatsapp" else "connected"

    conn_id = str(uuid6.uuid7())
    async with session() as db:
        await set_org_context(db, principal.org_id)  # FIRST — RLS + org_keys

        if provider == "whatsapp":
            # Meta's GET handshake echoes hub.challenge only when hub.verify_token
            # matches. We GENERATE that token rather than asking the user to invent
            # one: it is a shared secret, and a user-chosen one is reliably weak
            # (the company name, "blisswork"). The UI shows it next to the webhook
            # URL for pasting into the Meta dashboard.
            #
            # REUSE the existing one when re-connecting. metadata_enc is a single
            # blob, so unlike webhook_token it can't be COALESCEd in the upsert —
            # and minting a fresh token here would silently break a webhook the
            # user already registered, at exactly the moment they're re-pasting a
            # rejected access token.
            creds["verifyToken"] = (
                await _existing_meta_field(db, principal.org_id, provider, external_account_id, "verifyToken")
                or secrets.token_urlsafe(24)
            )

        access_enc = await cryptor().encrypt(db, principal.org_id, primary_val)
        meta_enc = await cryptor().encrypt(db, principal.org_id, json.dumps(creds))
        ext_enc = (
            await cryptor().encrypt(db, principal.org_id, external_account_id)
            if external_account_id
            else None
        )
        ext_bidx = cryptor().blind_index(external_account_id) if external_account_id else None
        # Re-connecting the SAME external account refreshes the token in place
        # (partial-unique index on non-null blind index).
        res = await db.execute(
            text(
                """
                INSERT INTO integration_connections
                    (id, org_id, owner_user_id, created_by, scope_kind, provider, status,
                     display_label, access_token_enc, metadata_enc,
                     external_account_id_enc, external_account_id_bidx, scopes, webhook_token)
                VALUES
                    (:id, :org, :owner, :creator, :scope_kind, :provider, :status,
                     :label, :access_enc, :meta_enc, :ext_enc, :ext_bidx, :scopes, :wh)
                ON CONFLICT (org_id, provider, external_account_id_bidx)
                    WHERE external_account_id_bidx IS NOT NULL
                DO UPDATE SET
                    access_token_enc = EXCLUDED.access_token_enc,
                    metadata_enc     = EXCLUDED.metadata_enc,
                    display_label    = EXCLUDED.display_label,
                    -- A re-connect must not UN-confirm a live connection. What
                    -- the webhook handshake proved is "this URL is registered in
                    -- Meta", and webhook_token is preserved below, so that fact
                    -- survives new credentials. Meta only re-sends the handshake
                    -- when the admin clicks Verify and save again — so dropping
                    -- back to 'pending' here would strand a working connection
                    -- with no way in the app to get it back.
                    status           = CASE WHEN integration_connections.status = 'connected'
                                            THEN 'connected' ELSE EXCLUDED.status END,
                    last_error       = NULL,
                    -- Keep the EXISTING token on re-connect. Rotating it would
                    -- silently break the webhook URL already registered in the
                    -- provider's dashboard, and re-pasting a rejected token is
                    -- exactly when a user re-connects.
                    webhook_token    = COALESCE(integration_connections.webhook_token, EXCLUDED.webhook_token),
                    updated_at       = now()
                RETURNING id, provider, status, scope_kind, display_label, scopes,
                          last_error, webhook_token, created_at, updated_at
                """
            ),
            {
                "id": conn_id,
                "org": principal.org_id,
                "owner": owner,
                "creator": principal.user_id,
                "scope_kind": scope_kind,
                "provider": provider,
                "status": initial_status,
                "label": display_label,
                "access_enc": access_enc,
                "meta_enc": meta_enc,
                "ext_enc": ext_enc,
                "ext_bidx": ext_bidx,
                "scopes": list(spec.default_scopes),
                "wh": secrets.token_urlsafe(32),
            },
        )
        row = res.one()
        await db.commit()
        return ConnectStartOut(connection=_row_to_out(row, creds.get("verifyToken")))


@router.delete("/integrations/{conn_id}")
async def disconnect(conn_id: str, principal: Principal = PrincipalDep) -> Response:
    async with session() as db:
        await set_org_context(db, principal.org_id)
        res = await db.execute(
            text(
                """
                UPDATE integration_connections
                   SET status = 'revoked',
                       access_token_enc = NULL,
                       refresh_token_enc = NULL,
                       metadata_enc = NULL,
                       external_account_id_enc = NULL,
                       external_account_id_bidx = NULL,
                       updated_at = now()
                 WHERE id = :id
                   AND (owner_user_id = :uid OR owner_user_id IS NULL)
                """
            ),
            {"id": conn_id, "uid": principal.user_id},
        )
        await db.commit()
    if res.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="connection not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
