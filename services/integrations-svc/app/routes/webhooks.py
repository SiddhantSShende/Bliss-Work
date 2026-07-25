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

import uuid6
from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import text

from ..config import settings
from ..crypto import cryptor
from ..db import session, set_bypass_rls
from ..events import emit_activity_created
from ..providers import slack, whatsapp

router = APIRouter()


# ── shared helpers ────────────────────────────────────────────────────────────
async def _conn_by_account(db, provider: str, external_id: str | None):
    if not external_id:
        return None
    bidx = cryptor().blind_index(external_id)
    return (
        await db.execute(
            text(
                """
                SELECT id, org_id, owner_user_id, created_by FROM integration_connections
                 WHERE provider = :p AND external_account_id_bidx = :b AND status = 'connected'
                 LIMIT 1
                """
            ),
            {"p": provider, "b": bidx},
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


async def _claim_event(db, provider: str, event_id: str) -> bool:
    """Idempotency claim: True the first time this external event id is seen."""
    res = await db.execute(
        text(
            """
            INSERT INTO webhook_events (id, provider, external_event_id, signature_verified, received_at)
            VALUES (:id, :p, :e, true, now())
            ON CONFLICT (provider, external_event_id) WHERE external_event_id IS NOT NULL
            DO NOTHING
            """
        ),
        {"id": str(uuid6.uuid7()), "p": provider, "e": event_id},
    )
    return res.rowcount > 0


async def _record_inbound(db, conn, provider: str, *, external_id, peer, body, status_label) -> None:
    org = str(conn.org_id)
    owner = str(conn.owner_user_id) if conn.owner_user_id else None
    body_enc = await cryptor().encrypt(db, org, body or "")
    peer_enc = await cryptor().encrypt(db, org, peer or "")
    ext_bidx = cryptor().blind_index(str(external_id)) if external_id else None
    activity_id = str(uuid6.uuid7())
    res = await db.execute(
        text(
            """
            INSERT INTO provider_activity
                (id, org_id, owner_user_id, connection_id, provider, direction,
                 kind, external_id_bidx, peer_enc, body_enc, status, occurred_at)
            VALUES
                (:id, :o, :owner, :c, :p, 'inbound', 'message', :xb, :peer, :b, :st, now())
            ON CONFLICT (connection_id, external_id_bidx) WHERE external_id_bidx IS NOT NULL
            DO NOTHING
            """
        ),
        {
            "id": activity_id,
            "o": org,
            "owner": owner,
            "c": conn.id,
            "p": provider,
            "xb": ext_bidx,
            "peer": peer_enc,
            "b": body_enc,
            "st": status_label,
        },
    )
    # Only emit the live signal when a NEW row was actually inserted (not a dedupe).
    if res.rowcount > 0:
        recipient = str(conn.created_by) if conn.created_by else owner
        await emit_activity_created(
            db, org_id=org, recipient_id=recipient, activity_id=activity_id,
            connection_id=str(conn.id), provider=provider, kind="message", direction="inbound",
        )


# ── WhatsApp GET verification handshake ───────────────────────────────────────
@router.get("/{provider}/webhook")
async def verify_webhook(provider: str, request: Request) -> Response:
    if provider != "whatsapp":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown provider")
    q = request.query_params
    mode = q.get("hub.mode")
    token = q.get("hub.verify_token")
    challenge = q.get("hub.challenge", "")
    if mode == "subscribe" and settings.whatsapp_verify_token and token == settings.whatsapp_verify_token:
        return Response(content=challenge, media_type="text/plain")
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="verification failed")


# ── POST inbound events ───────────────────────────────────────────────────────
@router.post("/{provider}/webhook")
async def provider_webhook(provider: str, request: Request) -> Response:
    raw = await request.body()
    try:
        payload = json.loads(raw) if raw else {}
    except ValueError:
        payload = {}

    if provider == "slack":
        return await _handle_slack(request, raw, payload)
    if provider == "whatsapp":
        return await _handle_whatsapp(request, raw, payload)
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown provider")


async def _handle_slack(request: Request, raw: bytes, payload: dict) -> Response:
    ts = request.headers.get("X-Slack-Request-Timestamp", "")
    sig = request.headers.get("X-Slack-Signature", "")
    team_id = payload.get("team_id")
    async with session() as db:
        await set_bypass_rls(db)
        signing_secret = settings.slack_signing_secret
        conn = await _conn_by_account(db, "slack", team_id)
        if not signing_secret and conn is not None:
            signing_secret = await _conn_secret(db, conn, "signingSecret")
        if not signing_secret or not slack.verify_signature(signing_secret, ts, raw, sig):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad signature")

        if payload.get("type") == "url_verification":
            return Response(
                content=json.dumps({"challenge": payload.get("challenge", "")}),
                media_type="application/json",
            )
        event_id = payload.get("event_id")
        if conn is not None and event_id and await _claim_event(db, "slack", str(event_id)):
            ev = payload.get("event", {}) or {}
            await _record_inbound(
                db, conn, "slack",
                external_id=ev.get("ts") or event_id,
                peer=ev.get("user", "") or ev.get("channel", ""),
                body=ev.get("text", ""),
                status_label="received",
            )
        await db.commit()
    return Response(status_code=status.HTTP_200_OK)


async def _handle_whatsapp(request: Request, raw: bytes, payload: dict) -> Response:
    sig = request.headers.get("X-Hub-Signature-256", "")
    pnid = whatsapp.phone_number_id_of(payload)
    async with session() as db:
        await set_bypass_rls(db)
        conn = await _conn_by_account(db, "whatsapp", pnid)
        app_secret = settings.whatsapp_app_secret
        if not app_secret and conn is not None:
            app_secret = await _conn_secret(db, conn, "appSecret")
        if not app_secret or not whatsapp.verify_signature(app_secret, raw, sig):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad signature")

        if conn is not None:
            for m in whatsapp.parse_inbound(payload):
                ext_id = m.get("external_id")
                if not ext_id or not await _claim_event(db, "whatsapp", str(ext_id)):
                    continue
                # Surface Meta's forward signal (the only forward Meta exposes).
                st = "received"
                if m.get("frequently_forwarded"):
                    st = "received-frequently-forwarded"
                elif m.get("forwarded"):
                    st = "received-forwarded"
                await _record_inbound(
                    db, conn, "whatsapp",
                    external_id=ext_id,
                    peer=m.get("from", ""),
                    body=m.get("text", ""),
                    status_label=st,
                )
        await db.commit()
    return Response(status_code=status.HTTP_200_OK)
