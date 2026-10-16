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
from sqlalchemy.exc import IntegrityError

from .. import app_credentials
from ..auth import PrincipalDep, Principal
from ..config import settings
from crypto import cryptor, CryptoError
from ..db import session, set_org_context
from ..logging_setup import log
from ..providers import get_provider, oauth, slack
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


def _row_to_out(r) -> ConnectionOut:
    # webhook_token is only selected on some queries; treat its absence as
    # None rather than requiring every SELECT to carry it.
    token = getattr(r, "webhook_token", None)
    return ConnectionOut(
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


async def _best_effort_provider_revocation(
    db, org_id: str, provider: str, access_token_enc: bytes | None, refresh_token_enc: bytes | None
) -> None:
    if provider == "gmail":
        token_enc = refresh_token_enc or access_token_enc
        revoke = oauth.revoke_google_token
    elif provider == "slack":
        token_enc = access_token_enc
        revoke = slack.revoke_token
    else:
        log.info("provider_token_revocation_unsupported", provider=provider)
        return
    if not token_enc:
        return
    try:
        token = await cryptor().decrypt(db, org_id, bytes(token_enc))
        if token:
            await revoke(token)
    except Exception as exc:  # noqa: BLE001 — local credential purge must still complete
        log.warning("provider_token_revocation_failed", provider=provider, error=str(exc))


@router.get("/integrations", response_model=list[ConnectionOut])
async def list_integrations(principal: Principal = PrincipalDep) -> list[ConnectionOut]:
    async with session() as db:
        await set_org_context(db, principal.org_id)
        res = await db.execute(
            text(
                """
                SELECT c.id, c.provider, c.status, c.scope_kind, c.display_label, c.scopes,
                       c.last_error, c.webhook_token, c.metadata_enc, c.created_at, c.updated_at
                  FROM integration_connections c
                 WHERE c.status <> 'revoked'
                   AND (c.owner_user_id = :uid OR c.owner_user_id IS NULL)
                 ORDER BY c.created_at DESC
                """
            ),
            {"uid": principal.user_id},
        )
        rows = res.all()  # materialized — safe to run decrypt queries next

        # No connection's metadata_enc is decrypted here. WhatsApp was the only
        # provider that needed a value read back out of it (its verify token,
        # for pasting into Meta); that blob otherwise holds access tokens and
        # signing secrets, so leaving it sealed is the correct resting state.
        return [_row_to_out(r) for r in rows]


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
            # A row whose DEK version is gone (crypto-shredded) or whose
            # ciphertext is malformed raises CryptoError by design (fail
            # closed) — isolated per row so ONE bad historical row doesn't
            # 500 the whole timeline for every other, perfectly readable one.
            try:
                peer = await cryptor().decrypt(
                    db, principal.org_id, bytes(r.peer_enc) if r.peer_enc else None
                )
                body = await cryptor().decrypt(
                    db, principal.org_id, bytes(r.body_enc) if r.body_enc else None
                )
            except CryptoError as exc:
                log.warning("hub_activity_decrypt_failed", activity_id=str(r.id), error=str(exc))
                peer, body = "(unavailable)", "(unavailable)"
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


async def _upsert_connection(
    db,
    *,
    org_id: str,
    user_id: str,
    provider: str,
    status: str,
    scope_kind: str,
    owner: str | None,
    display_label: str,
    access_token: str,
    metadata: dict,
    external_account_id: str | None,
    scopes: list[str],
    webhook_token: str | None,
):
    """Create or refresh a connection, encrypting everything on the way in.

    The single write path for every provider, so the encryption, the conflict
    target and the re-connect semantics can't drift between them.
    """
    access_enc = await cryptor().encrypt(db, org_id, access_token)
    meta_enc = await cryptor().encrypt(db, org_id, json.dumps(metadata))
    ext_enc = (
        await cryptor().encrypt(db, org_id, external_account_id) if external_account_id else None
    )
    ext_bidx = cryptor().blind_index(external_account_id) if external_account_id else None
    # Re-connecting the SAME external account refreshes the token in place
    # (partial-unique index on non-null blind index).
    #
    # The conflict target is per-ORG, so two workspaces may legitimately connect
    # the same Slack team or mailbox. 0010 added a GLOBAL unique index for the
    # one case where that is not true of the world — a WhatsApp business number —
    # and that index is now unreachable along with the provider itself.
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
                -- A re-connect must not UN-confirm a live connection. What the
                -- webhook handshake proved is "Meta delivers to us for this
                -- account", and that stays true across new credentials, since
                -- webhook_token is preserved below. Meta only re-sends the
                -- handshake when the admin clicks Verify and save again — so
                -- dropping back to 'pending' here would strand a working
                -- connection with no way in the app to get it back.
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
            "id": str(uuid6.uuid7()),
            "org": org_id,
            "owner": owner,
            "creator": user_id,
            "scope_kind": scope_kind,
            "provider": provider,
            "status": status,
            "label": display_label,
            "access_enc": access_enc,
            "meta_enc": meta_enc,
            "ext_enc": ext_enc,
            "ext_bidx": ext_bidx,
            "scopes": scopes,
            "wh": webhook_token,
        },
    )
    return res.one()


@router.post("/integrations/{provider}/connect/start", response_model=ConnectStartOut)
async def connect_start(
    provider: str,
    request: Request,
    response: Response,
    principal: Principal = PrincipalDep,
) -> ConnectStartOut:
    spec = get_provider(provider)
    if spec is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown provider")

    # External Integrations is an enterprise-only entitlement (see the `plan`
    # claim's doc comment in auth.py and migrations/0006_org_plan.sql) — this
    # is the ONE place that gate needs enforcing: both branches below (OAuth
    # and token-paste) create a new connection through this function, and the
    # OAuth callback cannot complete without the oauth_states row only this
    # branch inserts, so refusing it here closes both paths.
    #
    if principal.plan != "enterprise":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="External Integrations requires the enterprise plan",
        )

    # Parsed up front because BOTH branches need it now: token-paste reads the
    # credentials, OAuth reads `returnTo`.
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — an absent/!json body is simply "no options"
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid body")

    if spec.auth_kind == "oauth2_code":
        # Authorization-code + PKCE. Teams uses BlissWork's centrally
        # configured Microsoft app; Google may use this org's own app.
        vendor = app_credentials.vendor_for(provider)
        verifier, challenge = oauth.new_pkce()
        state = secrets.token_urlsafe(32)
        browser_session = secrets.token_urlsafe(32)
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
                detail = (
                    f"{spec.label} isn't set up for this workspace yet. "
                    f"Add your {vendor or 'provider'} OAuth app credentials first."
                )
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=detail,
                )
            verifier_enc = await cryptor().encrypt(db, principal.org_id, verifier)
            # Snapshot the credentials actually resolved for THIS flow, not
            # just a pointer to their row: app_credentials.save() upserts in
            # place, so a secret rotated mid-consent would otherwise still be
            # visible to the callback through app_credential_id alone (see
            # 0014_oauth_state_credential_snapshot.sql). Encrypted the same
            # way code_verifier_enc already is.
            client_id_enc = await cryptor().encrypt(db, principal.org_id, cfg.client_id)
            client_secret_enc = await cryptor().encrypt(db, principal.org_id, cfg.client_secret)
            await db.execute(
                text(
                    """
                    INSERT INTO oauth_states
                        (state, org_id, owner_user_id, provider, code_verifier_enc,
                         redirect_after, app_credential_id, client_id_enc,
                         client_secret_enc, tenant, browser_session_hash, expires_at)
                    VALUES (:s, :o, :u, :p, :v, :r, :ac, :cid, :csec, :tenant, :bsh,
                            now() + interval '10 minutes')
                    """
                ),
                {
                    "s": state,
                    "o": principal.org_id,
                    "u": principal.user_id,
                    "p": provider,
                    "v": verifier_enc,
                    "r": redirect_after,
                    # Copied to the resulting connection for refresh-token
                    # compatibility with existing workspace app registrations.
                    "ac": creds.id if creds else None,
                    "cid": client_id_enc,
                    "csec": client_secret_enc,
                    "tenant": creds.tenant if creds else None,
                    "bsh": oauth.browser_session_hash(browser_session),
                },
            )
            await db.commit()
        response.set_cookie(
            key=oauth.browser_session_cookie_name(state),
            value=browser_session,
            max_age=600,
            httponly=True,
            secure=redirect_uri.startswith("https://"),
            samesite="lax",
            path="/ext",
        )
        return ConnectStartOut(authorizeUrl=oauth.authorize_url(cfg, state, challenge, redirect_uri))

    # Token-paste connections are org-wide (scope_kind "org", owner_user_id
    # NULL — see _SCOPE_FOR) and can silently overwrite the org's existing
    # credential for this provider (the ON CONFLICT upsert in
    # _upsert_connection). Gated the same way the org's OAuth app credentials
    # already are (routes/app_creds.py put/delete_app_credentials) — any
    # member creating or replacing a shared, org-wide integration credential
    # needs org_admin. The OAuth branch above is per-USER (owner_user_id =
    # principal.user_id) and stays self-service.
    if "org_admin" not in principal.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="org_admin role required"
        )

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
            ) from exc
        except Exception as exc:  # network/timeout — not the user's fault
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="couldn't reach Slack to validate the token",
            ) from exc
        display_label = str(info.get("team") or spec.label)
        external_account_id = info.get("team_id")
    # Every remaining provider is connected the moment its credentials check
    # out. WhatsApp was the only one that landed 'pending' — it needed Meta's
    # webhook handshake to prove the inbound path worked before it could claim
    # to be ready — and nothing creates a pending row now.
    initial_status = "connected"

    async with session() as db:
        await set_org_context(db, principal.org_id)  # FIRST — RLS + org_keys

        try:
            row = await _upsert_connection(
                db,
                org_id=principal.org_id,
                user_id=principal.user_id,
                provider=provider,
                status=initial_status,
                scope_kind=scope_kind,
                owner=owner,
                display_label=display_label,
                access_token=primary_val,
                metadata=creds,
                external_account_id=external_account_id,
                scopes=list(spec.default_scopes),
                webhook_token=secrets.token_urlsafe(32),
            )
        except IntegrityError:
            # The only bespoke translation here was for uq_whatsapp_account_global
            # (two workspaces claiming one business number). That index is partial
            # on provider = 'whatsapp', and WhatsApp can no longer be connected, so
            # it is unreachable — but the rollback still matters: leaving the
            # session dirty would fail every later statement on it.
            await db.rollback()
            raise
        await db.commit()
        return ConnectStartOut(connection=_row_to_out(row))


@router.delete("/integrations/{conn_id}")
async def disconnect(conn_id: str, principal: Principal = PrincipalDep) -> Response:
    # A user's own (owner_user_id = uid) connection is always theirs to
    # disconnect. An org-wide one (owner_user_id IS NULL — a token-paste
    # credential shared by the whole org, see _SCOPE_FOR) needs org_admin,
    # same as creating one now does in connect_start — otherwise any member
    # could sever the org's Slack/WhatsApp connection for everyone. Folded
    # into the WHERE (rather than checked separately) so a non-admin member
    # gets the same "connection not found" a nonexistent id would, instead of
    # a 403 that confirms an org-wide connection exists.
    is_admin = "org_admin" in principal.roles
    async with session() as db:
        await set_org_context(db, principal.org_id)
        row = (
            await db.execute(
                text(
                    """
                    SELECT provider, access_token_enc, refresh_token_enc
                      FROM integration_connections
                     WHERE id = :id
                       AND (owner_user_id = :uid OR (owner_user_id IS NULL AND :is_admin))
                    """
                ),
                {"id": conn_id, "uid": principal.user_id, "is_admin": is_admin},
            )
        ).one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="connection not found"
            )
        await _best_effort_provider_revocation(
            db,
            principal.org_id,
            row.provider,
            bytes(row.access_token_enc) if row.access_token_enc else None,
            bytes(row.refresh_token_enc) if row.refresh_token_enc else None,
        )
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
                   AND (owner_user_id = :uid OR (owner_user_id IS NULL AND :is_admin))
                   AND access_token_enc IS NOT DISTINCT FROM :access_enc
                """
            ),
            {
                "id": conn_id,
                "uid": principal.user_id,
                "is_admin": is_admin,
                "access_enc": row.access_token_enc,
            },
        )
        await db.commit()
    if res.rowcount == 0:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="connection not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
