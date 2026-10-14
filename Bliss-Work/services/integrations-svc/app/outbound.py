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

from dataclasses import dataclass

from crypto import cryptor
from .providers import gmail, microsoft as ms, slack


class OutboundError(Exception):
    """Send failed. `retryable` distinguishes "try again" from "never will work",
    which is what decides between a 502 and a 400 at the API boundary.

    `is_auth_error` flags the specific case of a provider 401 at send time:
    gmail.py/microsoft.py's own docstrings promise the caller re-arms
    token_expires_at so refresh_worker's next sweep renews it, rather than
    waiting out the token's original (now-wrong) expiry — see send_via_connection.
    """

    def __init__(
        self,
        message: str,
        *,
        retryable: bool = False,
        is_auth_error: bool = False,
        ambiguous: bool = False,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.is_auth_error = is_auth_error
        self.ambiguous = ambiguous


class OutboundUnsupported(OutboundError):
    """This provider has no outbound path (or lacks the config it needs)."""


@dataclass(frozen=True)
class SendResult:
    external_id: str | None
    #: 'message' for chat platforms, 'email' for mail — drives the activity
    #: mirror's `kind`, which the mentions feed and the hub both read.
    kind: str = "message"


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
    try:
        token = await cryptor().decrypt(
            db, org_id, bytes(row.access_token_enc) if row.access_token_enc else None
        )
    except Exception as exc:  # noqa: BLE001 - KMS/crypto fault, before any provider call
        # Decryption talks to the KMS over its own HTTP client, so a fault there
        # would otherwise surface as a raw httpx error indistinguishable from a
        # lost provider answer. Nothing has been sent: definitive and retryable.
        raise OutboundError(f"could not decrypt the connection token: {exc}", retryable=True) from exc
    if not token:
        # A connected row with no token means the refresh worker hasn't caught
        # up, or the connection was revoked mid-flight.
        raise OutboundError("connection has no usable access token", retryable=True)

    if provider == "slack":
        return await _send_slack(token, target, text)
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
    except slack.SlackRateLimited as exc:
        raise OutboundError(str(exc), retryable=True) from exc
    except slack.SlackError as exc:
        raise OutboundError(str(exc)) from exc
    return SendResult(external_id=res.get("ts"))


#: Subject used when a caller sends mail without one. Mail with an empty subject
#: is far more likely to be filtered as spam, and reads as broken to a human.
DEFAULT_SUBJECT = "Message from BlissWork"


async def _send_gmail(token: str, target: str, text: str, subject: str | None) -> SendResult:
    try:
        raw = gmail.build_mime(to=target, subject=subject or DEFAULT_SUBJECT, body=text)
    except ValueError as exc:
        # Header validation (e.g. a CR/LF in the subject or address) fails
        # before any network I/O and fails identically on every retry: a
        # definitive, non-retryable refusal — not an unclassified crash that
        # would leave the send claim stuck 'sending'.
        raise OutboundError(f"invalid message: {exc}") from exc
    try:
        res = await gmail.send_message(token, raw)
    except gmail.GmailAuthError as exc:
        # Retryable: the refresh worker renews the token, and the next attempt
        # succeeds. Marking this permanent would drop the message.
        raise OutboundError(str(exc), retryable=True, is_auth_error=True) from exc
    except gmail.GmailRateLimited as exc:
        raise OutboundError(str(exc), retryable=True) from exc
    except gmail.GmailError as exc:
        raise OutboundError(str(exc)) from exc
    return SendResult(external_id=res.get("id"), kind="email")


async def _send_outlook(token: str, target: str, text: str, subject: str | None) -> SendResult:
    try:
        _graph_id, internet_message_id = await ms.send_mail(
            token, to=target, subject=subject or DEFAULT_SUBJECT, body=text
        )
    except ms.MicrosoftAuthError as exc:
        raise OutboundError(str(exc), retryable=True, is_auth_error=True) from exc
    except ms.MicrosoftAmbiguousDelivery as exc:
        raise OutboundError(str(exc), ambiguous=True) from exc
    except ms.MicrosoftRateLimited as exc:
        raise OutboundError(str(exc), retryable=True) from exc
    except ms.MicrosoftError as exc:
        raise OutboundError(str(exc)) from exc
    # send_mail now creates-then-sends a draft (see microsoft.py), so there IS
    # an id to record — internetMessageId (not the mailbox-scoped Graph `id`),
    # consistent with how every other provider's external_id is a stable,
    # cross-system identifier rather than something scoped to one mailbox.
    return SendResult(external_id=internet_message_id or None, kind="email")


async def _send_teams(token: str, target: str, text: str) -> SendResult:
    try:
        res = await ms.send_chat_message(token, target, text)
    except ms.MicrosoftAuthError as exc:
        raise OutboundError(str(exc), retryable=True, is_auth_error=True) from exc
    except ms.MicrosoftAmbiguousDelivery as exc:
        raise OutboundError(str(exc), ambiguous=True) from exc
    except ms.MicrosoftRateLimited as exc:
        raise OutboundError(str(exc), retryable=True) from exc
    except ms.MicrosoftError as exc:
        raise OutboundError(str(exc)) from exc
    return SendResult(external_id=res.get("id"))
