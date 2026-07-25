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

from ..auth import PrincipalDep, Principal
from ..crypto import cryptor
from ..db import session, set_org_context
from ..providers import get_provider, oauth, slack, whatsapp
from ..schemas import ConnectionOut, ConnectStartOut, ProviderActivityOut

router = APIRouter()

# Token-paste providers share an app-wide credential (a bot token / business
# number) → org-wide. OAuth providers connect a single user's account → per-user.
_SCOPE_FOR = {"token_paste": "org", "oauth2_code": "user"}


def _row_to_out(r) -> ConnectionOut:
    return ConnectionOut(
        id=str(r.id),
        provider=r.provider,
        status=r.status,
        scopeKind=r.scope_kind,
        displayLabel=r.display_label,
        scopes=list(r.scopes or []),
        lastError=r.last_error,
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
                       last_error, created_at, updated_at
                  FROM integration_connections
                 WHERE status <> 'revoked'
                   AND (owner_user_id = :uid OR owner_user_id IS NULL)
                 ORDER BY created_at DESC
                """
            ),
            {"uid": principal.user_id},
        )
        return [_row_to_out(r) for r in res.all()]


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

    if spec.auth_kind == "oauth2_code":
        # Authorization-code + PKCE. Needs OUR app's client credentials configured;
        # if absent, report a clear error rather than a broken redirect.
        cfg = oauth.config_for(provider)
        if cfg is None:
            raise HTTPException(
                status_code=status.HTTP_501_NOT_IMPLEMENTED,
                detail=f"{spec.label} OAuth is not configured on this server yet",
            )
        verifier, challenge = oauth.new_pkce()
        state = secrets.token_urlsafe(32)
        redirect_uri = oauth.redirect_uri_for(provider)
        async with session() as db:
            await set_org_context(db, principal.org_id)  # FIRST — RLS + org_keys
            verifier_enc = await cryptor().encrypt(db, principal.org_id, verifier)
            await db.execute(
                text(
                    """
                    INSERT INTO oauth_states
                        (state, org_id, owner_user_id, provider, code_verifier_enc,
                         redirect_after, expires_at)
                    VALUES (:s, :o, :u, :p, :v, :r, now() + interval '10 minutes')
                    """
                ),
                {
                    "s": state,
                    "o": principal.org_id,
                    "u": principal.user_id,
                    "p": provider,
                    "v": verifier_enc,
                    "r": "/app/integrations",
                },
            )
            await db.commit()
        return ConnectStartOut(authorizeUrl=oauth.authorize_url(cfg, state, challenge, redirect_uri))

    # ── token-paste connect ────────────────────────────────────────────────────
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid body")

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
        pnid = str(body.get("phoneNumberId", "")).strip()
        try:
            info = await whatsapp.get_phone_number(primary_val, pnid)
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
        display_label = str(info.get("display_phone_number") or info.get("verified_name") or spec.label)
        # The business number (phone_number_id) is the connection's external account.
        external_account_id = pnid

    conn_id = str(uuid6.uuid7())
    async with session() as db:
        await set_org_context(db, principal.org_id)  # FIRST — RLS + org_keys
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
                     external_account_id_enc, external_account_id_bidx, scopes)
                VALUES
                    (:id, :org, :owner, :creator, :scope_kind, :provider, 'connected',
                     :label, :access_enc, :meta_enc, :ext_enc, :ext_bidx, :scopes)
                ON CONFLICT (org_id, provider, external_account_id_bidx)
                    WHERE external_account_id_bidx IS NOT NULL
                DO UPDATE SET
                    access_token_enc = EXCLUDED.access_token_enc,
                    metadata_enc     = EXCLUDED.metadata_enc,
                    display_label    = EXCLUDED.display_label,
                    status           = 'connected',
                    last_error       = NULL,
                    updated_at       = now()
                RETURNING id, provider, status, scope_kind, display_label, scopes,
                          last_error, created_at, updated_at
                """
            ),
            {
                "id": conn_id,
                "org": principal.org_id,
                "owner": owner,
                "creator": principal.user_id,
                "scope_kind": scope_kind,
                "provider": provider,
                "label": display_label,
                "access_enc": access_enc,
                "meta_enc": meta_enc,
                "ext_enc": ext_enc,
                "ext_bidx": ext_bidx,
                "scopes": list(spec.default_scopes),
            },
        )
        row = res.one()
        await db.commit()
        return ConnectStartOut(connection=_row_to_out(row))


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
