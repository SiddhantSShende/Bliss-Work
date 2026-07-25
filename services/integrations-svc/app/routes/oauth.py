"""Public OAuth2 authorization-code callback (NO JWT).

Mounted at /ext/{provider}/oauth/callback. The provider redirects the user's
browser here with `code` + `state`. We validate + single-use-consume the state
(CSRF/TTL), exchange the code for tokens (PKCE), resolve the account identity,
store the connection with encrypted tokens, and redirect back to the app.
"""
from __future__ import annotations

from datetime import datetime, timezone

import uuid6
from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy import text

from ..config import settings
from ..crypto import cryptor
from ..db import session, set_bypass_rls
from ..providers import oauth

router = APIRouter()


def _app_url(suffix: str) -> str:
    return settings.web_origin.rstrip("/") + "/app/integrations" + suffix


@router.get("/{provider}/oauth/callback")
async def oauth_callback(provider: str, request: Request) -> RedirectResponse:
    q = request.query_params
    if q.get("error"):
        return RedirectResponse(_app_url(f"?error={q.get('error')}"), status_code=302)
    code = q.get("code")
    state = q.get("state")
    if not code or not state:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="missing code/state")
    cfg = oauth.config_for(provider)
    if cfg is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="provider not configured")

    async with session() as db:
        # Pre-org-context: resolve the state ourselves (it carries the org).
        await set_bypass_rls(db)
        st = (
            await db.execute(
                text(
                    """
                    SELECT org_id, owner_user_id, provider, code_verifier_enc, expires_at
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
        verifier = await cryptor().decrypt(
            db, org, bytes(st.code_verifier_enc) if st.code_verifier_enc else None
        )
        redirect_uri = oauth.redirect_uri_for(provider)
        try:
            tokens = await oauth.exchange_code(cfg, code, verifier or "", redirect_uri)
            ext_id, label = await oauth.fetch_identity(cfg, tokens.get("access_token", ""))
        except Exception:  # noqa: BLE001 — surface as a friendly redirect
            await db.commit()  # state already consumed
            return RedirectResponse(_app_url("?error=oauth_failed"), status_code=302)

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

        await db.execute(
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
        await db.commit()

    return RedirectResponse(_app_url(f"?connected={provider}"), status_code=302)
