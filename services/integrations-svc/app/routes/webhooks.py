"""Public inbound webhook receiver (NO JWT).

Mounted at /ext/{provider}/webhook — a PUBLIC path (server-to-server; must sit
OUTSIDE the /internal/ segment the WAF 404s, and outside the credentialed CORS
group). Every request is authenticated by the provider's own signature scheme
before its body is trusted; an unsigned/invalid request is rejected 401 and
nothing is persisted.

  Slack   : HMAC-SHA256 over `v0:{ts}:{body}` (5-min skew) + url_verification echo.
  WhatsApp: GET hub.challenge handshake; POST `X-Hub-Signature-256` = HMAC-SHA256
            over the raw body with the Meta app secret. Meta's `context.forwarded`
            flag (a message forwarded INTO the business number) is surfaced.
"""
from __future__ import annotations

import json
import secrets

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import text

from ..config import settings
from ..crypto import cryptor
from ..db import session, set_bypass_rls
from ..ingest import claim_event, ingest_one
from ..providers import slack, whatsapp

router = APIRouter()


# ── shared helpers ────────────────────────────────────────────────────────────
#: The columns every ingest path needs. external_account_id_bidx comes along so
#: ingest_one can answer "was the connection's OWN account the thing that got
#: tagged?" without a re-query.
_CONN_COLS = "id, org_id, owner_user_id, created_by, external_account_id_bidx"


async def _conn_by_account(db, provider: str, external_id: str | None):
    """Resolve a connection from an identifier inside the PAYLOAD.

    Only usable once the payload is parsed, which is a problem for handshakes:
    Slack's `url_verification` carries no team_id at all, and WhatsApp's GET
    challenge has no body. `_conn_by_token` exists for those.
    """
    if not external_id:
        return None
    bidx = cryptor().blind_index(external_id)
    return (
        await db.execute(
            text(
                f"""
                SELECT {_CONN_COLS}
                  FROM integration_connections
                 WHERE provider = :p AND external_account_id_bidx = :b AND status = 'connected'
                 LIMIT 1
                """  # noqa: S608 — _CONN_COLS is a module constant, not user input
            ),
            {"p": provider, "b": bidx},
        )
    ).one_or_none()


async def _conn_by_token(db, provider: str, webhook_token: str | None):
    """Resolve a connection from the URL PATH, before parsing anything.

    This is what makes per-org credentials possible. Each connection gets its
    own webhook URL (/ext/{provider}/webhook/{token}), so we can find the
    connection — and therefore its per-connection signing secret — before the
    body is trusted. Without it, the very first request in a Slack setup (the
    `url_verification` handshake, which has no team_id) can only be answered
    from a SERVER-level secret shared by every tenant.

    The token is NOT an authenticator. The provider's HMAC signature still
    authenticates every request, exactly as before; the token only says which
    connection a delivery belongs to. It is compared by an indexed equality
    lookup, so a wrong token is a miss, not a partial match.
    """
    if not webhook_token:
        return None
    return (
        await db.execute(
            text(
                f"""
                SELECT {_CONN_COLS}
                  FROM integration_connections
                 WHERE provider = :p AND webhook_token = :t AND status = 'connected'
                 LIMIT 1
                """  # noqa: S608 — _CONN_COLS is a module constant, not user input
            ),
            {"p": provider, "t": webhook_token},
        )
    ).one_or_none()


async def _conn_secret(db, conn, key: str) -> str:
    """Decrypt one field out of a connection's encrypted credential metadata."""
    row = (
        await db.execute(
            text("SELECT metadata_enc FROM integration_connections WHERE id = :id"),
            {"id": conn.id},
        )
    ).one_or_none()
    if not row or not row.metadata_enc:
        return ""
    meta = await cryptor().decrypt(db, str(conn.org_id), bytes(row.metadata_enc))
    try:
        return json.loads(meta or "{}").get(key, "")
    except (ValueError, TypeError):
        return ""


# ── WhatsApp GET verification handshake ───────────────────────────────────────
# Two shapes of the same route. The token-suffixed one is what new connections
# register (it identifies the connection from the path); the bare one is kept
# so webhooks configured before per-connection URLs existed keep working.
@router.get("/{provider}/webhook")
@router.get("/{provider}/webhook/{webhook_token}")
async def verify_webhook(
    provider: str, request: Request, webhook_token: str | None = None
) -> Response:
    if provider != "whatsapp":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown provider")
    q = request.query_params
    mode = q.get("hub.mode")
    token = q.get("hub.verify_token")
    challenge = q.get("hub.challenge", "")
    if mode != "subscribe" or not token:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="verification failed")

    # Per-connection verify token, resolved from the path. This GET carries no
    # body at all, so without the path token the only way to answer it is a
    # server-wide shared secret.
    if webhook_token:
        async with session() as db:
            await set_bypass_rls(db)
            conn = await _conn_by_token(db, "whatsapp", webhook_token)
            expected = await _conn_secret(db, conn, "verifyToken") if conn is not None else ""
        if expected and secrets.compare_digest(token, expected):
            return Response(content=challenge, media_type="text/plain")

    # Fallback: the deployment-wide token, for pre-existing setups.
    if settings.whatsapp_verify_token and secrets.compare_digest(
        token, settings.whatsapp_verify_token
    ):
        return Response(content=challenge, media_type="text/plain")
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="verification failed")


# ── POST inbound events ───────────────────────────────────────────────────────
@router.post("/{provider}/webhook")
@router.post("/{provider}/webhook/{webhook_token}")
async def provider_webhook(
    provider: str, request: Request, webhook_token: str | None = None
) -> Response:
    raw = await request.body()
    try:
        payload = json.loads(raw) if raw else {}
    except ValueError:
        payload = {}

    if provider == "slack":
        return await _handle_slack(request, raw, payload, webhook_token)
    if provider == "whatsapp":
        return await _handle_whatsapp(request, raw, payload, webhook_token)
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown provider")


async def _handle_slack(
    request: Request, raw: bytes, payload: dict, webhook_token: str | None = None
) -> Response:
    ts = request.headers.get("X-Slack-Request-Timestamp", "")
    sig = request.headers.get("X-Slack-Signature", "")
    team_id = payload.get("team_id")
    async with session() as db:
        await set_bypass_rls(db)
        # Path token FIRST. `url_verification` — the very first request Slack
        # sends when you save the URL — carries no team_id, so resolving by
        # account cannot work for it. This ordering is what lets an org verify
        # its own Slack app with no server-level secret.
        conn = await _conn_by_token(db, "slack", webhook_token)
        if conn is None:
            conn = await _conn_by_account(db, "slack", team_id)

        signing_secret = ""
        if conn is not None:
            signing_secret = await _conn_secret(db, conn, "signingSecret")
        # Deployment-wide secret only as a fallback, for webhooks registered
        # before per-connection URLs existed.
        if not signing_secret:
            signing_secret = settings.slack_signing_secret
        if not signing_secret or not slack.verify_signature(signing_secret, ts, raw, sig):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad signature")

        if payload.get("type") == "url_verification":
            return Response(
                content=json.dumps({"challenge": payload.get("challenge", "")}),
                media_type="application/json",
            )
        event_id = payload.get("event_id")
        if conn is not None and event_id and await claim_event(db, "slack", str(event_id)):
            ev = payload.get("event", {}) or {}
            # `raw=ev` — mention markup (<@U0123>) only exists in the untouched
            # event; the `body` we store has no way back to it.
            await ingest_one(
                db, conn, "slack",
                raw=ev,
                external_id=ev.get("ts") or event_id,
                peer=ev.get("user", "") or ev.get("channel", ""),
                body=ev.get("text", ""),
                status_label="received",
            )
        await db.commit()
    return Response(status_code=status.HTTP_200_OK)


async def _handle_whatsapp(
    request: Request, raw: bytes, payload: dict, webhook_token: str | None = None
) -> Response:
    sig = request.headers.get("X-Hub-Signature-256", "")
    pnid = whatsapp.phone_number_id_of(payload)
    async with session() as db:
        await set_bypass_rls(db)
        # Path token first, same reasoning as Slack — see _conn_by_token.
        conn = await _conn_by_token(db, "whatsapp", webhook_token)
        if conn is None:
            conn = await _conn_by_account(db, "whatsapp", pnid)

        app_secret = ""
        if conn is not None:
            app_secret = await _conn_secret(db, conn, "appSecret")
        if not app_secret:
            app_secret = settings.whatsapp_app_secret
        if not app_secret or not whatsapp.verify_signature(app_secret, raw, sig):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad signature")

        if conn is not None:
            # WhatsApp has no mention markup, so a connection only produces
            # mentions when it opts in by naming the person its number belongs
            # to (see mentions._whatsapp_scan).
            owner_handle = await _conn_secret(db, conn, "mentionOwnerUserId")
            for m in whatsapp.parse_inbound(payload):
                ext_id = m.get("external_id")
                if not ext_id or not await claim_event(db, "whatsapp", str(ext_id)):
                    continue
                # Surface Meta's forward signal (the only forward Meta exposes).
                st = "received"
                if m.get("frequently_forwarded"):
                    st = "received-frequently-forwarded"
                elif m.get("forwarded"):
                    st = "received-forwarded"
                await ingest_one(
                    db, conn, "whatsapp",
                    raw=m,
                    external_id=ext_id,
                    peer=m.get("from", ""),
                    body=m.get("text", ""),
                    status_label=st,
                    owner_handle=owner_handle or None,
                )
        await db.commit()
    return Response(status_code=status.HTTP_200_OK)
