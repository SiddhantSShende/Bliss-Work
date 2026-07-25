"""Private service-to-service endpoints (shared-secret authenticated).

NOT under /api/v1 (no JWT) and edge-blocked by Caddy (any path containing an
/internal/ segment 404s at the WAF), so these are private-network only. Auth is
the X-Internal-Token shared secret (constant-time compare), matching the pattern
used across the other services.

messaging-svc calls /internal/messages/send when a Bliss-Work message is
forwarded OUT to an external platform (outbound-to-external forward): we decrypt
the connection's token, send via the provider, and mirror the send into
provider_activity so it shows up in the unified hub.
"""
from __future__ import annotations

import json
import secrets

import uuid6
from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text

from ..config import settings
from ..crypto import cryptor
from ..db import session, set_org_context
from ..events import emit_activity_created
from ..providers import slack, whatsapp

router = APIRouter()


class SendReq(BaseModel):
    orgId: str
    connectionId: str
    target: str  # channel id / handle on the external platform
    text: str


class SendResp(BaseModel):
    status: str
    externalId: str | None = None
    # The authoritative provider of the connection, so the caller (messaging-svc)
    # tags the forward edge's platform from the server, not client input.
    provider: str | None = None


def _require_internal(token: str | None) -> None:
    expected = settings.internal_token
    if not expected or not token or not secrets.compare_digest(token, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")


@router.post("/messages/send", response_model=SendResp)
async def internal_send(
    body: SendReq, x_internal_token: str | None = Header(default=None)
) -> SendResp:
    _require_internal(x_internal_token)

    async with session() as db:
        # Trusted caller supplied the org — scope RLS to it (not bypass).
        await set_org_context(db, body.orgId)
        row = (
            await db.execute(
                text(
                    """
                    SELECT provider, access_token_enc, metadata_enc, owner_user_id, created_by
                      FROM integration_connections
                     WHERE id = :id AND org_id = :o AND status = 'connected'
                    """
                ),
                {"id": body.connectionId, "o": body.orgId},
            )
        ).one_or_none()
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="connection not found")

        token = await cryptor().decrypt(
            db, body.orgId, bytes(row.access_token_enc) if row.access_token_enc else None
        )
        if not token:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="connection has no token")

        if row.provider == "slack":
            res = await slack.post_message(token, body.target, body.text)
            external_id = res.get("ts")
        elif row.provider == "whatsapp":
            # WhatsApp send needs the business number (phone_number_id) from the
            # encrypted connection metadata alongside the access token.
            meta_raw = await cryptor().decrypt(
                db, body.orgId, bytes(row.metadata_enc) if row.metadata_enc else None
            )
            try:
                pnid = json.loads(meta_raw or "{}").get("phoneNumberId", "")
            except (ValueError, TypeError):
                pnid = ""
            if not pnid:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="connection missing phone_number_id",
                )
            try:
                res = await whatsapp.send_text(token, pnid, body.target, body.text)
            except whatsapp.WhatsAppError as exc:
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
            msgs = res.get("messages") or []
            external_id = msgs[0].get("id") if msgs else None
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"outbound send not supported for {row.provider} yet",
            )

        owner = str(row.owner_user_id) if row.owner_user_id else None
        activity_id = str(uuid6.uuid7())
        body_enc = await cryptor().encrypt(db, body.orgId, body.text)
        peer_enc = await cryptor().encrypt(db, body.orgId, body.target)
        await db.execute(
            text(
                """
                INSERT INTO provider_activity
                    (id, org_id, owner_user_id, connection_id, provider, direction,
                     kind, peer_enc, body_enc, status, occurred_at)
                VALUES
                    (:id, :o, :owner, :c, :p, 'outbound', 'message', :peer, :b, 'sent', now())
                """
            ),
            {
                "id": activity_id,
                "o": body.orgId,
                "owner": owner,
                "c": body.connectionId,
                "p": row.provider,
                "peer": peer_enc,
                "b": body_enc,
            },
        )
        recipient = str(row.created_by) if row.created_by else owner
        await emit_activity_created(
            db, org_id=body.orgId, recipient_id=recipient, activity_id=activity_id,
            connection_id=body.connectionId, provider=row.provider, kind="message", direction="outbound",
        )
        await db.commit()

    return SendResp(status="sent", externalId=external_id, provider=row.provider)
