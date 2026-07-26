"""Public OAuth2 authorization-code callback (NO JWT).

Mounted at /ext/{provider}/oauth/callback. The provider redirects the user's
browser here with `code` + `state`. We validate + single-use-consume the state
(CSRF/TTL), exchange the code for tokens (PKCE), resolve the account identity,
store the connection with encrypted tokens, and redirect back to the app.
"""
from __future__ import annotations

import html
from datetime import datetime, timezone

import uuid6
from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import text

from .. import app_credentials
from ..config import settings
from ..crypto import cryptor
from ..db import session, set_bypass_rls
from ..identities import upsert_oauth_identity
from ..providers import oauth

router = APIRouter()


#: The ONLY non-web return target. Stored by connect_start as a mode, never as
#: a client-supplied URL — see the open-redirect note there.
_DESKTOP_RETURN = "taskboard://oauth"


def _app_url(suffix: str) -> str:
    return settings.web_origin.rstrip("/") + "/app/integrations" + suffix


def _finish(redirect_after: str | None, params: str) -> Response:
    """Send the browser back to whichever client started the flow.

    Web gets a plain 302 into the SPA. Desktop gets an HTML interstitial rather
    than a redirect, for two reasons: browsers routinely refuse to auto-navigate
    a 3xx into an unregistered custom scheme, and the flow ends in a tab the app
    cannot close — so the user needs to be told it worked and that they can go
    back to BlissWork.
    """
    if redirect_after != _DESKTOP_RETURN:
        return RedirectResponse(_app_url(params), status_code=302)

    target = f"{_DESKTOP_RETURN}{params}"
    escaped = html.escape(target, quote=True)
    return HTMLResponse(
        f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url={escaped}">
<title>Returning to BlissWork…</title>
<style>
 body{{font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
       display:grid;place-items:center;min-height:100vh;margin:0;
       background:#f7f7fb;color:#2a2440;text-align:center}}
 a{{color:#6d5bf0;font-weight:600}}
</style></head>
<body><main>
  <h1>All set</h1>
  <p>Returning you to BlissWork…</p>
  <p><a href="{escaped}">Open BlissWork</a></p>
  <p style="color:#6b6580;font-size:14px">You can close this tab.</p>
</main></body></html>""",
        status_code=200,
    )


@router.get("/{provider}/oauth/callback")
async def oauth_callback(provider: str, request: Request) -> Response:
    q = request.query_params
    if q.get("error"):
        # The state (and therefore the return mode) is unknown this early.
        return RedirectResponse(_app_url(f"?error={q.get('error')}"), status_code=302)
    code = q.get("code")
    state = q.get("state")
    if not code or not state:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="missing code/state")

    async with session() as db:
        # Pre-org-context: resolve the state ourselves (it carries the org).
        await set_bypass_rls(db)
        st = (
            await db.execute(
                text(
                    """
                    SELECT org_id, owner_user_id, provider, code_verifier_enc, expires_at,
                           redirect_after, app_credential_id
                      FROM oauth_states WHERE state = :s
                    """
                ),
                {"s": state},
            )
        ).one_or_none()
        if st is None or st.provider != provider:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid state")
        # Single-use: consume the state now, whatever happens next.
        await db.execute(text("DELETE FROM oauth_states WHERE state = :s"), {"s": state})
        if st.expires_at < datetime.now(timezone.utc):
            await db.commit()
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="state expired")

        org = str(st.org_id)
        owner = str(st.owner_user_id)
        redirect_after = st.redirect_after

        # Redeem against the SAME app the flow started with. Pinning matters
        # because an admin can rotate the client secret while a user sits on the
        # consent screen; resolving by (org, vendor) again would exchange the
        # code against the new secret and fail with an opaque invalid_client.
        # A NULL pin means the server-env fallback started it (no row exists).
        vendor = app_credentials.vendor_for(provider)
        if st.app_credential_id:
            creds = await app_credentials.load_by_id(db, org, str(st.app_credential_id))
        else:
            creds = await app_credentials.load(db, org, vendor) if vendor else None
        cfg = oauth.config_for(provider, creds)
        if cfg is None:
            # The credentials were deleted mid-flow. State is already consumed.
            await db.commit()
            return _finish(redirect_after, "?error=not_configured")

        verifier = await cryptor().decrypt(
            db, org, bytes(st.code_verifier_enc) if st.code_verifier_enc else None
        )
        redirect_uri = oauth.redirect_uri_for(provider)
        try:
            tokens = await oauth.exchange_code(cfg, code, verifier or "", redirect_uri)
            identity = await oauth.fetch_identity(cfg, tokens.get("access_token", ""))
            ext_id, label = identity.account_id, identity.label
        except Exception:  # noqa: BLE001 — surface as a friendly redirect
            await db.commit()  # state already consumed
            return _finish(redirect_after, "?error=oauth_failed")

        access_enc = await cryptor().encrypt(db, org, tokens.get("access_token", ""))
        refresh_enc = (
            await cryptor().encrypt(db, org, tokens.get("refresh_token", ""))
            if tokens.get("refresh_token")
            else None
        )
        ext_enc = await cryptor().encrypt(db, org, ext_id) if ext_id else None
        ext_bidx = cryptor().blind_index(ext_id) if ext_id else None
        expires_in = int(tokens.get("expires_in") or 0)
        scopes = (tokens.get("scope") or "").split() or list(cfg.scopes)

        res = await db.execute(
            text(
                """
                INSERT INTO integration_connections
                    (id, org_id, owner_user_id, created_by, scope_kind, provider, status,
                     display_label, access_token_enc, refresh_token_enc,
                     external_account_id_enc, external_account_id_bidx, token_expires_at, scopes)
                VALUES
                    (:id, :o, :owner, :owner, 'user', :p, 'connected', :label, :a, :rf,
                     :ee, :eb,
                     CASE WHEN :exp > 0 THEN now() + (:exp * interval '1 second') ELSE NULL END,
                     :sc)
                ON CONFLICT (org_id, provider, external_account_id_bidx)
                    WHERE external_account_id_bidx IS NOT NULL
                DO UPDATE SET
                    access_token_enc  = EXCLUDED.access_token_enc,
                    refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, integration_connections.refresh_token_enc),
                    display_label     = EXCLUDED.display_label,
                    token_expires_at  = EXCLUDED.token_expires_at,
                    status            = 'connected',
                    last_error        = NULL,
                    updated_at        = now()
                RETURNING id
                """
            ),
            {
                "id": str(uuid6.uuid7()),
                "o": org,
                "owner": owner,
                "p": provider,
                "label": label,
                "a": access_enc,
                "rf": refresh_enc,
                "ee": ext_enc,
                "eb": ext_bidx,
                "exp": expires_in,
                "sc": scopes,
            },
        )
        conn_row = res.one_or_none()

        # Auto-derive this account's mention handles, in the SAME transaction as
        # the connection itself — so a user who connects Gmail is immediately
        # taggable by mail sent to that mailbox, with no "My handles" setup.
        # OAuth is self-proving here: they just signed in to the account.
        for handle_kind, value in identity.handles:
            await upsert_oauth_identity(
                db,
                org_id=org,
                user_id=owner,
                provider=provider,
                handle=value,
                handle_kind=handle_kind,
                connection_id=str(conn_row.id) if conn_row else None,
            )

        await db.commit()

    return _finish(redirect_after, f"?connected={provider}")
