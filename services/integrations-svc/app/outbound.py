"""Outbound send — one dispatch point for every provider.

Extracted from routes/internal.py so the same code path serves both callers:
messaging-svc forwarding a Bliss-Work message out to an external platform, and
(later) any in-app reply to a mention. Two copies of provider dispatch is how
one of them ends up missing a provider, or missing the activity mirror.

RESULT SHAPE
────────────
`external_id` is None for providers that don't return one. Outlook is the case
that matters: Graph answers /me/sendMail with 202 and an EMPTY body, so there is
no message id to record. The partial unique index on
`provider_activity.external_id_bidx` only covers non-null values, so a NULL
there is fine — but callers must not assume an id exists.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

from .crypto import cryptor
from .providers import gmail, microsoft as ms, slack, whatsapp


class OutboundError(Exception):
    """Send failed. `retryable` distinguishes "try again" from "never will work",
    which is what decides between a 502 and a 400 at the API boundary."""

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


class OutboundUnsupported(OutboundError):
    """This provider has no outbound path (or lacks the config it needs)."""


@dataclass(frozen=True)
class SendResult:
    external_id: str | None
    #: 'message' for chat platforms, 'email' for mail — drives the activity
    #: mirror's `kind`, which the mentions feed and the hub both read.
    kind: str = "message"


async def _connection_meta(db, org_id: str, metadata_enc) -> dict:
    """Decrypt a connection's credential metadata blob."""
    if not metadata_enc:
        return {}
    plain = await cryptor().decrypt(db, org_id, bytes(metadata_enc))
    try:
        return json.loads(plain or "{}")
    except (ValueError, TypeError):
        return {}


async def send_via_connection(
    db,
    org_id: str,
    row,
    *,
    target: str,
    text: str,
    subject: str | None = None,
) -> SendResult:
    """Send `text` to `target` using the connection in `row`.

    `row` must carry provider, access_token_enc and metadata_enc. The caller
    owns the transaction, the activity mirror and the emitted event — this
    function only talks to the provider.
    """
    provider = row.provider
    token = await cryptor().decrypt(
        db, org_id, bytes(row.access_token_enc) if row.access_token_enc else None
    )
    if not token:
        # A connected row with no token means the refresh worker hasn't caught
        # up, or the connection was revoked mid-flight.
        raise OutboundError("connection has no usable access token", retryable=True)

    if provider == "slack":
        return await _send_slack(token, target, text)
    if provider == "whatsapp":
        meta = await _connection_meta(db, org_id, row.metadata_enc)
        return await _send_whatsapp(token, meta, target, text)
    if provider == "gmail":
        return await _send_gmail(token, target, text, subject)
    if provider == "outlook":
        return await _send_outlook(token, target, text, subject)
    if provider == "teams":
        return await _send_teams(token, target, text)

    raise OutboundUnsupported(f"outbound send not supported for {provider}")


# ── per-provider ──────────────────────────────────────────────────────────────
async def _send_slack(token: str, target: str, text: str) -> SendResult:
    try:
        res = await slack.post_message(token, target, text)
    except slack.SlackError as exc:
        raise OutboundError(str(exc)) from exc
    return SendResult(external_id=res.get("ts"))


async def _send_whatsapp(token: str, meta: dict, target: str, text: str) -> SendResult:
    pnid = str(meta.get("phoneNumberId") or "")
    if not pnid:
        raise OutboundUnsupported("connection is missing its phone_number_id")
    try:
        res = await whatsapp.send_text(token, pnid, target, text)
    except whatsapp.WhatsAppError as exc:
        raise OutboundError(str(exc)) from exc
    msgs = res.get("messages") or []
    return SendResult(external_id=msgs[0].get("id") if msgs else None)


#: Subject used when a caller sends mail without one. Mail with an empty subject
#: is far more likely to be filtered as spam, and reads as broken to a human.
DEFAULT_SUBJECT = "Message from BlissWork"


async def _send_gmail(token: str, target: str, text: str, subject: str | None) -> SendResult:
    raw = gmail.build_mime(to=target, subject=subject or DEFAULT_SUBJECT, body=text)
    try:
        res = await gmail.send_message(token, raw)
    except gmail.GmailAuthError as exc:
        # Retryable: the refresh worker renews the token, and the next attempt
        # succeeds. Marking this permanent would drop the message.
        raise OutboundError(str(exc), retryable=True) from exc
    except gmail.GmailRateLimited as exc:
        raise OutboundError(str(exc), retryable=True) from exc
    except gmail.GmailError as exc:
        raise OutboundError(str(exc)) from exc
    return SendResult(external_id=res.get("id"), kind="email")


async def _send_outlook(token: str, target: str, text: str, subject: str | None) -> SendResult:
    try:
        await ms.send_mail(token, to=target, subject=subject or DEFAULT_SUBJECT, body=text)
    except ms.MicrosoftAuthError as exc:
        raise OutboundError(str(exc), retryable=True) from exc
    except ms.MicrosoftRateLimited as exc:
        raise OutboundError(str(exc), retryable=True) from exc
    except ms.MicrosoftError as exc:
        raise OutboundError(str(exc)) from exc
    # Graph returns 202 with no body — there is genuinely no id to record.
    return SendResult(external_id=None, kind="email")


async def _send_teams(token: str, target: str, text: str) -> SendResult:
    try:
        res = await ms.send_chat_message(token, target, text)
    except ms.MicrosoftAuthError as exc:
        raise OutboundError(str(exc), retryable=True) from exc
    except ms.MicrosoftRateLimited as exc:
        raise OutboundError(str(exc), retryable=True) from exc
    except ms.MicrosoftError as exc:
        raise OutboundError(str(exc)) from exc
    return SendResult(external_id=res.get("id"))
