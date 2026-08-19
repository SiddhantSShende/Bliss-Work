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

import base64
import binascii
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
from ..providers import microsoft as ms

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


class MailAttachment(BaseModel):
    filename: str
    mime: str = ""
    #: Base64 — JSON has no byte type, and the bytes came off a blob volume that
    #: only messaging-svc mounts, so they arrive over the wire either way.
    contentBase64: str


class MailSendReq(BaseModel):
    orgId: str
    #: The member who composed the mail. Their connected mailbox is the one it
    #: is sent from — this endpoint never falls back to somebody else's.
    userId: str
    subject: str = ""
    bodyText: str = ""
    bodyHtml: str = ""
    to: list[str] = []
    cc: list[str] = []
    bcc: list[str] = []
    attachments: list[MailAttachment] = []
    #: False for the extra copy that carries a Bcc: the Sent folder already has
    #: the copy filed by the main send, and a second one would show the blind
    #: recipient's address sitting in the sender's own Sent list.
    saveToSentItems: bool = True


class MailSendResp(BaseModel):
    status: str
    provider: str


@router.post("/mail/send", response_model=MailSendResp)
async def internal_send_mail(
    body: MailSendReq, x_internal_token: str | None = Header(default=None)
) -> MailSendResp:
    """Relay a member's composed mail through that member's OWN mailbox.

    email-worker asks for this before it reaches for SMTP, and treats a 404 as
    "this member has no connected mailbox" rather than as a failure — the relay
    is the fallback, and a deployment with no integrations configured never
    leaves that fallback. What the connected path buys is everything the relay
    structurally cannot give: a From: header that is genuinely the member's
    because the mailbox is theirs, DKIM signed by their own domain (so the mail
    passes DMARC alignment rather than arriving unauthenticated from a third
    party), and a copy in their Sent folder.

    Deliberately NOT routed through outbound.send_via_connection: that is the
    chat-shaped dispatcher (one target, one text) shared by Slack/Teams/Gmail,
    and mail needs Cc, Bcc, an HTML body and attachments that none of them can
    carry. The reuse that matters happens one level down — both paths send
    through the same providers.microsoft.send_mail.

    No provider_activity mirror is written. The unified hub reads that table,
    and this mail is already IN the hub: messaging-svc wrote the Sent row that
    produced the event in the first place, so mirroring it would show the member
    their own mail twice.
    """
    _require_internal(x_internal_token)

    try:
        files = [
            (a.filename, a.mime, base64.b64decode(a.contentBase64, validate=True))
            for a in body.attachments
        ]
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="attachment is not valid base64"
        ) from exc

    async with session() as db:
        await set_org_context(db, body.orgId)
        row = (
            await db.execute(
                text(
                    """
                    SELECT id, access_token_enc
                      FROM integration_connections
                     WHERE org_id = :o AND owner_user_id = :u
                       AND provider = 'outlook' AND status = 'connected'
                     ORDER BY updated_at DESC
                     LIMIT 1
                    """
                ),
                {"o": body.orgId, "u": body.userId},
            )
        ).one_or_none()
        if row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="no connected mailbox for this member"
            )

        token = await cryptor().decrypt(
            db, body.orgId, bytes(row.access_token_enc) if row.access_token_enc else None
        )
        if not token:
            # The refresh worker has not caught up, or the connection was revoked
            # mid-flight. Retryable — a redelivery after a refresh will work.
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY, detail="connection has no usable token"
            )

        try:
            await ms.send_mail(
                token,
                to=body.to,
                subject=body.subject,
                body=body.bodyText,
                cc=body.cc,
                bcc=body.bcc,
                html=body.bodyHtml,
                attachments=files,
                save_to_sent_items=body.saveToSentItems,
            )
        except (ms.MicrosoftAuthError, ms.MicrosoftRateLimited) as exc:
            # 502 means "ask again": a refreshed token or an expired throttle
            # window makes this exact request work.
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
        except ms.MicrosoftError as exc:
            # Definitive — including the mail being too large to send inline.
            # The caller relays this copy over SMTP instead of losing it.
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    return MailSendResp(status="sent", provider="outlook")
