"""Public OAuth2 authorization-code callback (NO JWT).

Mounted at /ext/{provider}/oauth/callback. The provider redirects the user's
browser here with `code` + `state`. We validate + single-use-consume the state
(CSRF/TTL), exchange the code for tokens (PKCE), resolve the account identity,
store the connection with encrypted tokens, and redirect back to the app.
"""
from __future__ import annotations

import html
import urllib.parse
from datetime import datetime, timezone

import uuid6
from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import text

from ..app_credentials import AppCredentials
from ..config import settings
from crypto import cryptor
from ..db import session, set_bypass_rls
from ..identities import upsert_oauth_identity
from ..logging_setup import log
from ..providers import oauth

router = APIRouter()


#: The ONLY non-web return target. Stored by connect_start as a mode, never as
#: a client-supplied URL — see the open-redirect note there.
_DESKTOP_RETURN = "taskboard://oauth"


def _app_url(suffix: str) -> str:
    return settings.web_origin.rstrip("/") + "/app/integrations" + suffix


def _finish(redirect_after: str | None, params: str, state: str | None = None) -> Response:
    """Send the browser back to whichever client started the flow.

    Web gets a plain 302 into the SPA. Desktop gets an HTML interstitial rather
    than a redirect, for two reasons: browsers routinely refuse to auto-navigate
    a 3xx into an unregistered custom scheme, and the flow ends in a tab the app
    cannot close — so the user needs to be told it worked and that they can go
    back to BlissWork.
    """
    if redirect_after != _DESKTOP_RETURN:
        response: Response = RedirectResponse(_app_url(params), status_code=302)
    else:
        target = f"{_DESKTOP_RETURN}{params}"
        escaped = html.escape(target, quote=True)
        response = HTMLResponse(
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
    if state:
        response.delete_cookie(
            key=oauth.browser_session_cookie_name(state), path="/ext", httponly=True, samesite="lax"
        )
    return response


@router.get("/{provider}/oauth/callback")
async def oauth_callback(provider: str, request: Request) -> Response:
    q = request.query_params
    if q.get("error"):
        # The state (and therefore the return mode) is unknown this early.
        # url-encoded, matching _finish's html.escape below — this value is
        # attacker-controlled (no state/session required to reach this branch)
        # and lands in a Location header the SPA reads back out of its own URL.
        error_param = urllib.parse.quote(q.get("error", ""), safe="")
        error_state = q.get("state")
        redirect_after = None
        if error_state:
            # A routine decline (the user clicks "Cancel" on the provider's
            # consent screen) is the common case here, not an edge case — and
            # this row carries an ENCRYPTED snapshot of the org's OAuth client
            # secret and PKCE verifier (0014_oauth_state_credential_snapshot.sql).
            # Consume it now instead of leaving it for prune_event_tables's
            # next sweep. Mirrors the success path's single-use consume below;
            # a missing/unknown state is a silent no-op — this is already an
            # error-handling path and must not gain a new failure mode.
            async with session() as db:
                await set_bypass_rls(db)
                state_row = (
                    await db.execute(
                        text(
                            "SELECT provider, redirect_after, browser_session_hash "
                            "FROM oauth_states WHERE state = :s"
                        ),
                        {"s": error_state},
                    )
                ).one_or_none()
                if (
                    state_row is not None
                    and state_row.provider == provider
                    and oauth.browser_session_matches(
                        state_row.browser_session_hash,
                        request.cookies.get(oauth.browser_session_cookie_name(error_state)),
                    )
                ):
                    redirect_after = state_row.redirect_after
                    await db.execute(
                        text("DELETE FROM oauth_states WHERE state = :s"), {"s": error_state}
                    )
                    await db.commit()
                else:
                    await db.rollback()
                    error_state = None
        return _finish(redirect_after, f"?error={error_param}", error_state)
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
                           redirect_after, client_id_enc, client_secret_enc, tenant,
                           browser_session_hash
                      FROM oauth_states WHERE state = :s
                    """
                ),
                {"s": state},
            )
        ).one_or_none()
        if st is None or st.provider != provider:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid state")
        if not oauth.browser_session_matches(
            st.browser_session_hash, request.cookies.get(oauth.browser_session_cookie_name(state))
        ):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid state")
        # Single-use: consume the state now, whatever happens next.
        await db.execute(text("DELETE FROM oauth_states WHERE state = :s"), {"s": state})
        if st.expires_at < datetime.now(timezone.utc):
            await db.commit()
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="state expired")

        org = str(st.org_id)
        owner = str(st.owner_user_id)
        redirect_after = st.redirect_after

        # Redeem against the EXACT credentials snapshotted when this flow
        # started (see 0014_oauth_state_credential_snapshot.sql), never
        # re-resolved by (org, vendor) — that would read whatever is CURRENTLY
        # stored, which a secret rotated mid-consent would have replaced,
        # failing the exchange with an opaque invalid_client. NULL client_id/
        # secret means the server-env fallback started it (nothing to decrypt).
        client_id = await cryptor().decrypt(
            db, org, bytes(st.client_id_enc) if st.client_id_enc else None
        )
        client_secret = await cryptor().decrypt(
            db, org, bytes(st.client_secret_enc) if st.client_secret_enc else None
        )
        creds = (
            AppCredentials(client_id=client_id, client_secret=client_secret, tenant=st.tenant)
            if client_id and client_secret
            else None
        )
        cfg = oauth.config_for(provider, creds)
        if cfg is None:
            # The credentials were deleted mid-flow. State is already consumed.
            await db.commit()
            return _finish(redirect_after, "?error=not_configured", state)

        verifier = await cryptor().decrypt(
            db, org, bytes(st.code_verifier_enc) if st.code_verifier_enc else None
        )
        redirect_uri = oauth.redirect_uri_for(provider)
        try:
            tokens = await oauth.exchange_code(cfg, code, verifier or "", redirect_uri)
            identity = await oauth.fetch_identity(cfg, tokens.get("access_token", ""))
            ext_id, label = identity.account_id, identity.label
        except Exception as exc:  # noqa: BLE001 — surface as a friendly redirect
            log.warning("oauth_callback_failed", provider=provider, error=str(exc))
            await db.commit()  # state already consumed
            return _finish(redirect_after, "?error=oauth_failed", state)

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
                -- Only reconnecting your OWN existing connection may update it.
                -- Without this, a teammate completing OAuth for the SAME
                -- external account (a shared support mailbox, say) would
                -- silently overwrite its stored tokens while the row kept
                -- showing the ORIGINAL owner — every owner-keyed mail lookup
                -- would then use the wrong person's credentials with no
                -- error, no notification to either party. The conflicting
                -- row is left untouched instead (no rows updated, nothing
                -- RETURNING) and the caller below rejects with a clear error.
                WHERE integration_connections.owner_user_id = EXCLUDED.owner_user_id
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
        if conn_row is None:
            # The INSERT path (no prior row) always RETURNs a row, so reaching
            # here means the conflict path's WHERE blocked the update above —
            # this exact external account is already connected under a
            # DIFFERENT owner. The original owner must disconnect it first.
            await db.commit()
            return _finish(redirect_after, "?error=already_connected_by_teammate", state)

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
                connection_id=str(conn_row.id),
            )

        await db.commit()

    return _finish(redirect_after, f"?connected={provider}", state)
