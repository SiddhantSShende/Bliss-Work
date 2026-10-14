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

import asyncio
import base64
import binascii

import httpx
import uuid6
from fastapi import APIRouter, Header, HTTPException, status
from internal_auth import internal_token_matches
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from .. import messaging_client, outbound
from ..config import settings
from crypto import cryptor
from ..db import session, set_org_context
from ..events import emit_activity_created
from ..logging_setup import log
from ..providers import httpclient, microsoft as ms
from resilience import CircuitOpenError

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
    #: The Bliss-Work message being forwarded — messaging-svc's stable id for
    #: it, carried unchanged on every copy/redelivery of the same forward
    #: event, which is exactly what makes it usable as an idempotency key (see
    #: 0015_message_send_idempotency.sql, mirroring MailSendReq.mailId below).
    #: Optional only so a caller mid-rollout without it degrades to the old
    #: unprotected behaviour rather than failing closed; a real caller should
    #: always send it.
    messageId: str | None = None


class SendResp(BaseModel):
    status: str
    externalId: str | None = None
    # The authoritative provider of the connection, so the caller (messaging-svc)
    # tags the forward edge's platform from the server, not client input.
    provider: str | None = None


# Connection never established / never got a pool slot: the far side saw no part
# of the request, so these are provably "not sent" (same set resilience.py treats
# as safe to retry for a non-idempotent call).
_NOT_SENT_ERRORS = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)


def _provider_refused_or_never_reached(exc: BaseException) -> bool:
    """True when a transport-level `exc` proves the provider did NOT act on the
    send, so the claim can be resolved 'failed' and a later attempt may retry.

      * the provider ANSWERED with an HTTP error status (HTTPStatusError). Slack,
        Gmail and Graph all surface a 4xx/5xx response this way; it is a verdict,
        not a lost answer. (providers.microsoft already treats a 503/504
        response as definitive for the same reason.)
      * the connection was never established (_NOT_SENT_ERRORS).

    What is left — a read/write timeout, a dropped connection or any other error
    after the request went out — is the genuinely ambiguous case that must stay
    'sending'.
    """
    return isinstance(exc, (httpx.HTTPStatusError, *_NOT_SENT_ERRORS))


def _nothing_sent(exc: BaseException) -> bool:
    """For an UNCLASSIFIED exception (the catch-all): True only if provably
    nothing was put on the wire. Every provider call fetches its HTTP client via
    providers.httpclient.shared() in the same expression that issues the
    request, so "shared() was never asked for" proves the failure came from our
    own code (or a dependency such as the KMS) before the provider was
    contacted. Anything later is unknowable and must stay 'sending'."""
    return not httpclient.request_issued()


def _not_sent_http_status(exc: BaseException) -> int:
    """HTTP status for a send the provider definitely did not perform: a 4xx
    answer will repeat, so tell the caller to give up (400); everything else
    (a 5xx answer, a failed connect, a pre-contact fault) is worth retrying
    (502)."""
    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code < 500:
        return status.HTTP_400_BAD_REQUEST
    return status.HTTP_502_BAD_GATEWAY


def _require_internal(token: str | None) -> None:
    if not internal_token_matches(token, settings.internal_token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unauthorized")


async def _claim_send(db, table: str, id_column: str, entity_id: str, org_id: str) -> str:
    """Atomically claim the right to actually call the provider for `entity_id`.

    Shared mechanics behind both _claim_message_send and _claim_mail_send
    (see 0015_message_send_idempotency.sql / 0013_mail_send_idempotency.sql)
    — they differ only in which table/column backs the claim, so this is the
    one implementation both call.

    Returns "claimed" (this call owns the send — proceed), "sent" (a prior
    attempt already succeeded — replay that result, never call the provider
    again) or "in_progress" (another attempt currently owns this entity_id —
    the caller answers 409 so the ORIGINAL requester retries later through its
    normal redelivery path, instead of a second real send racing the first).

    Insert-first-then-resolve-the-conflict, not a check-then-insert: two
    callers racing the same entity_id both attempt the INSERT, the unique
    primary key lets exactly one of them commit it, and the loser sees
    IntegrityError and reads back whichever row actually won — the same shape
    task-svc's create_task uses for its own idempotency key.

    `table`/`id_column` are fixed literals passed by our own call sites below
    (never user input), so building the SQL text with them is safe
    identifier formatting, not concatenation of untrusted values.
    """
    try:
        await db.execute(
            text(f"INSERT INTO {table} ({id_column}, org_id) VALUES (:e, :o)"),
            {"e": entity_id, "o": org_id},
        )
        await db.commit()
        return "claimed"
    except IntegrityError:
        await db.rollback()

    # The rollback above clears the transaction-local app.org_id GUC.
    await set_org_context(db, org_id)
    existing = (
        await db.execute(
            text(f"SELECT status FROM {table} WHERE {id_column} = :e"),
            {"e": entity_id},
        )
    ).one_or_none()
    if existing is None:
        # Nothing deletes these rows, so this should be unreachable — but fail
        # closed (retry later) rather than assume either outcome.
        return "in_progress"
    if existing.status == "sent":
        return "sent"
    if existing.status != "failed":
        return "in_progress"  # 'sending': another attempt owns this right now

    # 'failed': a definitive prior attempt, safe to retry — but only for
    # whichever caller actually wins this transition, in case two retries of
    # the same failed entity race each other too.
    reclaimed = await db.execute(
        text(
            f"UPDATE {table} SET status = 'sending', updated_at = now() "
            f"WHERE {id_column} = :e AND status = 'failed'"
        ),
        {"e": entity_id},
    )
    await db.commit()
    return "claimed" if reclaimed.rowcount == 1 else "in_progress"


async def _resolve_send(
    db, table: str, id_column: str, entity_id: str, org_id: str, outcome: str, log_event: str
) -> None:
    """Record the terminal outcome ('sent' or 'failed') of a claimed attempt.

    Shared mechanics behind both _resolve_message_send and _resolve_mail_send
    — they differ only in which table/column backs the claim and which
    structured-log event a persistent failure emits.

    Never called for the ambiguous case — see internal_send's and
    internal_send_mail's handling of a network fault on the provider call
    itself, both of which leave the row 'sending' on purpose rather than
    guessing.

    By the time this runs, the provider call it follows has already happened
    — successfully or definitively not — so retrying the UPDATE below can
    never cause a duplicate send; it can only fail to record an outcome that
    is already final. Retried a few times to absorb a transient DB hiccup,
    same backoff as relay_consumer.py's _mark_sent/_read_transport on the
    email-worker side of this same idempotency feature, since a lost write
    here still leaves the row stranded in 'sending', which per the owning
    migration's docstring needs a manual SQL fix, and for a 'failed' outcome
    makes an otherwise safe-to-retry send permanently un-retryable.

    Unlike _mark_sent, exhausting retries here re-raises rather than
    swallowing: _mark_sent's caller always advances the Kafka offset
    regardless, so swallowing there only risks a lost cache entry. Here the
    caller's response (a replayed "sent", or a definitive 400/502) IS a claim
    about what got persisted — swallowing would let that response go out
    unchanged while the row silently stayed 'sending', hiding exactly the
    failure an operator needs to see.

    `table`/`id_column` are fixed literals passed by our own call sites below
    (never user input), so building the SQL text with them is safe
    identifier formatting, not concatenation of untrusted values.
    """
    for attempt in range(3):
        try:
            await set_org_context(db, org_id)
            await db.execute(
                text(f"UPDATE {table} SET status = :s, updated_at = now() WHERE {id_column} = :e"),
                {"s": outcome, "e": entity_id},
            )
            await db.commit()
            return
        except Exception as exc:  # noqa: BLE001 - retried, then re-raised below
            await db.rollback()
            if attempt == 2:
                log.error(log_event, **{id_column: entity_id, "org": org_id,
                                         "outcome": outcome, "error": str(exc)})
                raise
            await asyncio.sleep(0.5 * (2**attempt))


async def _claim_message_send(db, message_id: str, org_id: str) -> str:
    """Claim shape for the message-send idempotency path — see _claim_send."""
    return await _claim_send(db, "message_send_attempts", "message_id", message_id, org_id)


async def _resolve_message_send(db, message_id: str, org_id: str, outcome: str) -> None:
    """Resolve shape for the message-send idempotency path — see _resolve_send."""
    await _resolve_send(
        db, "message_send_attempts", "message_id", message_id, org_id, outcome,
        "message_send_resolve_failed",
    )


@router.post("/messages/send", response_model=SendResp)
async def internal_send(
    body: SendReq, x_internal_token: str | None = Header(default=None)
) -> SendResp:
    """Forward one Bliss-Work message out to a connected Slack/Teams/Gmail
    integration via outbound.send_via_connection, then mirror the send into
    provider_activity.

    Idempotent on body.messageId (see 0015_message_send_idempotency.sql): the
    SAME message_id is claimed at most once, and every repeat call — a Kafka
    redelivery, two workers racing, a caller retrying after losing the
    response — replays the recorded outcome instead of sending a second real
    Slack/Teams message or Gmail mail. Mirrors internal_send_mail's
    claim/resolve shape exactly, including leaving the claim in place (409)
    rather than guessing when an ambiguous network fault hits the provider
    call itself — see internal_send_mail's docstring and _claim_message_send.
    """
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

        if body.messageId:
            claim = await _claim_message_send(db, body.messageId, body.orgId)
            if claim == "sent":
                return SendResp(status="sent", externalId=None, provider=row.provider)
            if claim == "in_progress":
                # 409, not 503: this is never "integrations-svc is unhealthy,
                # fail fast and fall back" — a run of these must not let a
                # caller's own breaker open and resend a message that may
                # already be on its way through the winning attempt (mirrors
                # internal_send_mail's identical 409 choice).
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="this message is already being sent by another attempt",
                )

        # Provider dispatch lives in outbound.py so this path and any future
        # caller (an in-app reply to a mention) can never drift apart.
        httpclient.reset_request_issued()
        try:
            result = await outbound.send_via_connection(
                db, body.orgId, row, target=body.target, text=body.text, subject=body.subject
            )
        except outbound.OutboundUnsupported as exc:
            # Nothing about this will work on a retry — the connection is
            # misconfigured or the provider has no outbound path. Still safe
            # to mark 'failed': the provider was never called.
            if body.messageId:
                await _resolve_message_send(db, body.messageId, body.orgId, "failed")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        except outbound.OutboundError as exc:
            if exc.ambiguous:
                if body.messageId:
                    log.error(
                        "message_send_outcome_unknown",
                        message_id=body.messageId,
                        org=body.orgId,
                        error=str(exc),
                    )
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="message send outcome unknown; needs manual review",
                ) from exc
            # Definitive one way or the other before the provider call
            # completed — safe to let a later attempt reclaim and retry.
            if body.messageId:
                await _resolve_message_send(db, body.messageId, body.orgId, "failed")
            if exc.is_auth_error:
                # Documented in gmail.py/microsoft.py: a 401 here is NOT a
                # broken connection — re-arm token_expires_at so
                # refresh_worker's next sweep (within 60s) renews it, instead
                # of waiting out the token's original, now-wrong expiry.
                # _resolve_message_send's commit above reset the
                # transaction-local app.org_id GUC, so it's set again here.
                await set_org_context(db, body.orgId)
                await db.execute(
                    text(
                        "UPDATE integration_connections SET token_expires_at = now() "
                        "WHERE id = :id"
                    ),
                    {"id": body.connectionId},
                )
                await db.commit()
            # 502 signals "try again" to messaging-svc; 400 would make it give
            # up on a message that a token refresh would have delivered.
            code = (
                status.HTTP_502_BAD_GATEWAY
                if exc.retryable
                else status.HTTP_400_BAD_REQUEST
            )
            raise HTTPException(status_code=code, detail=str(exc)) from exc
        except CircuitOpenError as exc:
            # The breaker short-circuits BEFORE any request is made — the
            # provider was definitely not contacted this time, so this is
            # safe to mark 'failed' and let a later attempt reclaim.
            if body.messageId:
                await _resolve_message_send(db, body.messageId, body.orgId, "failed")
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
        except (httpx.HTTPError, OSError) as exc:
            if _provider_refused_or_never_reached(exc):
                # The provider answered with an HTTP error status, or the
                # request never left — definitive. Resolve 'failed' so the
                # claim does not sit 'sending' (answering 409 to every retry
                # forever) and a later attempt can proceed.
                if body.messageId:
                    await _resolve_message_send(db, body.messageId, body.orgId, "failed")
                raise HTTPException(
                    status_code=_not_sent_http_status(exc),
                    detail="the provider did not accept the message",
                ) from exc
            # AMBIGUOUS: a network fault on the provider call itself (every
            # provider send here runs idempotent=False — see slack.py/
            # gmail.py/microsoft.py — so a ReadTimeout etc. surfaces as the
            # raw httpx exception rather than a *Error subclass). The provider
            # may have already accepted the send, so the claim from above is
            # deliberately left 'sending' rather than 'failed': marking it
            # failed would let a redelivery reclaim and resend a message that
            # may already be sitting on the far side. Same 409-not-502/503
            # reasoning as internal_send_mail's identical except clause.
            if body.messageId:
                log.error(
                    "message_send_outcome_unknown", message_id=body.messageId, org=body.orgId,
                    error=str(exc),
                )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="message send outcome unknown; needs manual review",
            ) from exc
        except Exception as exc:  # noqa: BLE001 - catch-all: never strand the claim
            # Anything unclassified (a bug, a KMS fault, a malformed provider
            # reply). Before: it escaped as a bare 500 with the row left
            # 'sending', so every retry answered 409 forever. Now: if nothing
            # was ever put on the wire it is safe to resolve 'failed'; if a
            # request may have gone out we cannot know, so it stays 'sending'
            # and answers the same 409 as the ambiguous case above (never a 5xx
            # a caller's breaker could read as "fall back to something else").
            log.error(
                "message_send_unexpected_error", message_id=body.messageId, org=body.orgId,
                error=repr(exc),
            )
            if _nothing_sent(exc):
                if body.messageId:
                    await _resolve_message_send(db, body.messageId, body.orgId, "failed")
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="message send failed before the provider was contacted",
                ) from exc
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="message send outcome unknown; needs manual review",
            ) from exc
        external_id = result.external_id

        if body.messageId:
            await _resolve_message_send(db, body.messageId, body.orgId, "sent")
            # _resolve_message_send's own commit above reset the
            # transaction-local app.org_id GUC, so it's set again here for
            # the activity mirror below.
            await set_org_context(db, body.orgId)

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
    #: messaging-svc's mail_messages.id — stable across every redelivery of the
    #: same mail.outbound Kafka event, which is exactly what makes it usable as
    #: an idempotency key (see 0013_mail_send_idempotency.sql). Optional only so
    #: a caller mid-rollout without it degrades to the old unprotected
    #: behaviour rather than failing closed; email-worker always sends it.
    mailId: str | None = None
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


async def _claim_mail_send(db, mail_id: str, org_id: str) -> str:
    """Claim shape for the mail-send idempotency path — see _claim_send."""
    return await _claim_send(db, "mail_send_attempts", "mail_id", mail_id, org_id)


async def _resolve_mail_send(db, mail_id: str, org_id: str, outcome: str) -> None:
    """Resolve shape for the mail-send idempotency path — see _resolve_send."""
    await _resolve_send(
        db, "mail_send_attempts", "mail_id", mail_id, org_id, outcome,
        "mail_send_resolve_failed",
    )


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

    Idempotent on body.mailId (see 0013_mail_send_idempotency.sql): the SAME
    mail_id is claimed at most once and every repeat call — a Kafka
    redelivery, two workers racing, a caller retrying after losing the
    response — replays the recorded outcome instead of sending a second real
    email. The one case that cannot be resolved this way is a network fault on
    the sendMail call itself: Graph may have accepted the message before the
    fault, so the claim is deliberately left in place (never reclaimed
    automatically) rather than risking a genuine duplicate — see the except
    clause below and the migration's docstring.
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

        if body.mailId:
            claim = await _claim_mail_send(db, body.mailId, body.orgId)
            if claim == "sent":
                return MailSendResp(status="sent", provider="outlook")
            if claim == "in_progress":
                # 409, not 503: this is never "integrations-svc is unhealthy,
                # fail fast and fall back" — provider_mail.py must not let a
                # run of these open its breaker and relay a mail that may
                # already be on its way through the winning attempt.
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="this mail is already being sent by another attempt",
                )

        httpclient.reset_request_issued()
        graph_id = ""
        internet_message_id = ""
        try:
            graph_id, internet_message_id = await ms.send_mail(
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
        except ms.MicrosoftAmbiguousDelivery as exc:
            if body.mailId:
                log.error(
                    "mail_send_outcome_unknown",
                    mail_id=body.mailId,
                    org=body.orgId,
                    error=str(exc),
                )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="mail send outcome unknown; needs manual review",
            ) from exc
        except (ms.MicrosoftAuthError, ms.MicrosoftRateLimited) as exc:
            # Definitive answers from Graph BEFORE it accepted anything — safe
            # to let a later attempt reclaim and retry this mailId.
            if body.mailId:
                await _resolve_mail_send(db, body.mailId, body.orgId, "failed")
            if isinstance(exc, ms.MicrosoftAuthError):
                # Documented in microsoft.py: NOT a broken connection — re-arm
                # token_expires_at so refresh_worker's next sweep (within 60s)
                # renews it, instead of waiting out the token's original,
                # now-wrong expiry. _resolve_mail_send's commit above reset
                # the transaction-local app.org_id GUC, so it's set again here.
                await set_org_context(db, body.orgId)
                await db.execute(
                    text("UPDATE integration_connections SET token_expires_at = now() WHERE id = :id"),
                    {"id": str(row.id)},
                )
                await db.commit()
            # 502 means "ask again": a refreshed token or an expired throttle
            # window makes this exact request work.
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
        except ms.MicrosoftError as exc:
            # Definitive — including the mail being too large to send inline.
            # The caller relays this copy over SMTP instead of losing it.
            if body.mailId:
                await _resolve_mail_send(db, body.mailId, body.orgId, "failed")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        except CircuitOpenError as exc:
            # The breaker short-circuits BEFORE any request is made — Graph was
            # definitely not contacted this time, so this is safe to mark
            # 'failed' and let a later attempt reclaim, same as the two
            # branches above.
            if body.mailId:
                await _resolve_mail_send(db, body.mailId, body.orgId, "failed")
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
        except (httpx.HTTPError, OSError) as exc:
            if _provider_refused_or_never_reached(exc):
                # Graph answered with an HTTP error status (e.g. a plain 500)
                # or the request never left — definitive. Resolve 'failed' so
                # the mail_id is not parked 'sending' (409 forever) and the
                # caller's retry can proceed. 4xx -> 400 (caller relays over
                # SMTP), else 502 (ask again).
                if body.mailId:
                    await _resolve_mail_send(db, body.mailId, body.orgId, "failed")
                raise HTTPException(
                    status_code=_not_sent_http_status(exc),
                    detail="the provider did not accept the mail",
                ) from exc
            # AMBIGUOUS: a network fault on the sendMail call itself. Graph may
            # have already accepted the message — send_mail's own idempotent=
            # False means this was not silently retried underneath us — so the
            # claim from above is deliberately left 'sending' rather than
            # 'failed': marking it failed would let a redelivery reclaim and
            # resend a mail that may already be sitting in the recipient's
            # inbox. This mailId now answers 409 forever until an operator
            # confirms the real outcome (checking the member's Sent folder)
            # and resolves the row by hand — see the migration's docstring.
            # 409, not 502/503: those are the codes provider_mail.py's shared
            # breaker treats as "integrations-svc is unhealthy" and, once
            # enough of them accumulate, answers with a fall-back-to-relay
            # False — which for THIS mail_id means a genuine duplicate send.
            # A 409 is never transient to that breaker, so it can never open
            # it on this mail's account; see provider_mail.send's docstring.
            log.error(
                "mail_send_outcome_unknown", mail_id=body.mailId, org=body.orgId, error=str(exc)
            )
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="mail send outcome unknown; needs manual review",
            ) from exc
        except Exception as exc:  # noqa: BLE001 - catch-all: never strand the claim
            # Anything unclassified. Before: a bare 500 with the row left
            # 'sending' (every retry then 409). Now: resolved 'failed' when
            # nothing was ever put on the wire, otherwise left 'sending' with
            # the same 409 as the ambiguous case — never a 5xx that
            # provider_mail's breaker could count towards a relay fallback.
            log.error(
                "mail_send_unexpected_error", mail_id=body.mailId, org=body.orgId,
                error=repr(exc),
            )
            if _nothing_sent(exc):
                if body.mailId:
                    await _resolve_mail_send(db, body.mailId, body.orgId, "failed")
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail="mail send failed before the provider was contacted",
                ) from exc
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="mail send outcome unknown; needs manual review",
            ) from exc

        if body.mailId:
            await _resolve_mail_send(db, body.mailId, body.orgId, "sent")
            if graph_id:
                # Loop-prevention bookkeeping — see microsoft.py's module
                # docstring. Best-effort: the mail is already sent and resolved
                # by this point, so a failure here must not fail the request,
                # only leave this one Sent copy without write-back support and
                # (if external-ref doesn't land) susceptible to one future
                # duplicate import from the Sent-Items delta walk — self-healing
                # the moment either call succeeds on a later send.
                await db.execute(
                    text(
                        """
                        INSERT INTO mail_sync_links
                            (id, connection_id, org_id, mail_id, graph_message_id, folder,
                             last_known_is_read)
                        VALUES (:id, :conn, :org, :mail, :graph, 'sentitems', true)
                        ON CONFLICT (connection_id, graph_message_id) DO NOTHING
                        """
                    ),
                    {
                        "id": str(uuid6.uuid7()),
                        "conn": str(row.id),
                        "org": body.orgId,
                        "mail": body.mailId,
                        "graph": graph_id,
                    },
                )
                await db.commit()
            if internet_message_id:
                await messaging_client.set_external_ref(
                    body.orgId, body.mailId, internet_message_id
                )

    return MailSendResp(status="sent", provider="outlook")
