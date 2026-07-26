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

import secrets

import uuid6
from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text

from .. import outbound
from ..config import settings
from ..crypto import cryptor
from ..db import session, set_org_context
from ..events import emit_activity_created

router = APIRouter()


class SendReq(BaseModel):
    orgId: str
    connectionId: str
    target: str  # channel id / handle / email address on the external platform
    text: str
    #: Mail providers only (gmail, outlook). Optional so messaging-svc's Go
    #: struct needs no change — chat providers ignore it, and mail falls back to
    #: outbound.DEFAULT_SUBJECT rather than sending an empty subject (which is
    #: far more likely to be filtered as spam).
    subject: str | None = None


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

        # Provider dispatch lives in outbound.py so this path and any future
        # caller (an in-app reply to a mention) can never drift apart.
        try:
            result = await outbound.send_via_connection(
                db, body.orgId, row, target=body.target, text=body.text, subject=body.subject
            )
        except outbound.OutboundUnsupported as exc:
            # Nothing about this will work on a retry — the connection is
            # misconfigured or the provider has no outbound path.
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        except outbound.OutboundError as exc:
            # 502 signals "try again" to messaging-svc; 400 would make it give
            # up on a message that a token refresh would have delivered.
            code = (
                status.HTTP_502_BAD_GATEWAY
                if exc.retryable
                else status.HTTP_400_BAD_REQUEST
            )
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        external_id = result.external_id

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
                    (:id, :o, :owner, :c, :p, 'outbound', :kind, :peer, :b, 'sent', now())
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
                # 'email' for gmail/outlook, 'message' for chat platforms — the
                # hub and the mentions feed both branch on this.
                "kind": result.kind,
            },
        )
        recipient = str(row.created_by) if row.created_by else owner
        await emit_activity_created(
            db, org_id=body.orgId, recipient_id=recipient, activity_id=activity_id,
            connection_id=body.connectionId, provider=row.provider, kind=result.kind,
            direction="outbound",
        )
        await db.commit()

    return SendResp(status="sent", externalId=external_id, provider=row.provider)
