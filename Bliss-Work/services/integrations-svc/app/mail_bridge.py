"""Delivering a mail from a connected mailbox into the BlissWork inbox.

── What this closes ─────────────────────────────────────────────────────────
Sending has always worked: messaging-svc queues a `mail.outbound` event and
email-worker puts it on the wire. RECEIVING had no producer at all — messaging-
svc exposes `/internal/mail/inbound` and nothing in the deployment ever called
it, so mail arrived in the member's real mailbox and stopped there.

This is that producer. The Outlook connection already walks the inbox delta for
mention detection; a mail that is new to us is now also handed to messaging-svc,
which resolves its recipients against the org directory and files it in their
BlissWork inbox. Nothing is moved or removed: the mail stays in Outlook exactly
as before and BlissWork gets a copy.

── Why the Message-ID and not the Graph id ──────────────────────────────────
`internetMessageId` is the RFC 5322 Message-ID — the SAME string in every
recipient's mailbox — while a Graph `id` is per-mailbox. Keying on the former
means that when two colleagues both connect Outlook and both were on the same
mail, messaging-svc dedups it into ONE mail delivered to both, rather than two
unrelated copies of the same conversation.

── Why a failure here is not an error ───────────────────────────────────────
The sweep that calls this is also advancing the provider cursor. A mail that
cannot be delivered is logged and skipped rather than raised: it is still in the
member's real mailbox and still in provider_activity, whereas failing the sweep
would stall EVERY later message behind it for as long as messaging-svc is down.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import httpx

from .config import settings
from .logging_setup import log
from .resilience import CircuitBreaker, retry_async

_TIMEOUT = httpx.Timeout(10.0, connect=2.0)
_mail_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="messaging-svc-mail")

#: Bound on the body we forward. The column is encrypted text with no hard cap,
#: but a mail thread that has been replied to forty times carries every earlier
#: copy, and an inbox row is a thing to read rather than an archive of one.
MAX_BODY_CHARS = 100_000


@dataclass
class InboundMail:
    """The parsed-mail contract messaging-svc's /internal/mail/inbound expects.

    Deliberately parsed rather than raw RFC 5322: MIME parsing belongs in the
    component that already had to do it — here, Graph did it — and keeping it
    out of messaging-svc means that service never parses a byte stream that came
    from the internet.
    """

    org_id: str
    external_message_id: str
    from_address: str
    from_name: str
    subject: str
    body_text: str
    sent_at: str
    to: list[str] = field(default_factory=list)
    cc: list[str] = field(default_factory=list)

    def payload(self) -> dict:
        return {
            "orgId": self.org_id,
            "externalMessageId": self.external_message_id,
            "fromAddress": self.from_address,
            "fromName": self.from_name,
            "subject": self.subject,
            "bodyText": self.body_text,
            "bodyHtml": "",
            "to": self.to,
            "cc": self.cc,
            "sentAt": self.sent_at,
        }


def _address(entry: object) -> tuple[str, str]:
    """(address, display name) out of Graph's two-level emailAddress nesting."""
    inner = ((entry or {}) if isinstance(entry, dict) else {}).get("emailAddress") or {}
    if not isinstance(inner, dict):
        return "", ""
    return str(inner.get("address") or "").strip().lower(), str(inner.get("name") or "").strip()


def _recipients(entries: object) -> list[str]:
    if not isinstance(entries, list):
        return []
    return [addr for addr, _ in (_address(e) for e in entries) if addr]


def from_graph_message(msg: dict, *, org_id: str) -> InboundMail | None:
    """Map one Graph mail resource to the inbound contract, or None if unusable.

    None rather than a partial row for the two cases that cannot produce a mail
    anybody could read or reply to:

      * no Message-ID — that is the dedup key, and without it a re-walked delta
        would file the same mail again on every sweep;
      * no sender address — the inbox renders a mail as being FROM somebody, and
        a reply needs somewhere to go.

    A missing recipient list is NOT one of those: messaging-svc resolves To/Cc
    against the org directory and rejects a mail nobody in the org was addressed
    on, which is the right place for that decision to live.

    The body must be asked for with `as_text=True` — the inbox delta omits `body`
    altogether, and Graph otherwise returns the sender's HTML.
    """
    message_id = str(msg.get("internetMessageId") or "").strip()
    if not message_id:
        return None
    from_address, from_name = _address(msg.get("from") or msg.get("sender"))
    if not from_address:
        return None

    body = msg.get("body")
    content = str((body or {}).get("content") or "") if isinstance(body, dict) else ""
    # bodyPreview is the fallback, not the source: it is capped at 255 characters
    # by Graph, so it is what a mail looks like when the full body could not be
    # had, and never a substitute for one that could.
    text = (content or str(msg.get("bodyPreview") or "")).strip()

    return InboundMail(
        org_id=org_id,
        external_message_id=message_id,
        from_address=from_address,
        from_name=from_name,
        subject=str(msg.get("subject") or "").strip(),
        body_text=text[:MAX_BODY_CHARS],
        sent_at=str(msg.get("receivedDateTime") or msg.get("sentDateTime") or ""),
        to=_recipients(msg.get("toRecipients")),
        cc=_recipients(msg.get("ccRecipients")),
    )


async def deliver(mail: InboundMail) -> bool:
    """Hand one mail to messaging-svc. True if it was accepted or already known.

    Never raises. See the module note: the caller is mid-sweep with a cursor to
    advance, and one undeliverable mail must not stall every message behind it.
    """

    async def _attempt() -> bool:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                f"{settings.messaging_internal_base.rstrip('/')}/internal/mail/inbound",
                headers={
                    "X-Internal-Token": settings.internal_token,
                    "Content-Type": "application/json",
                },
                json=mail.payload(),
            )
            # 201 is a mail newly filed into somebody's inbox; 200 is one
            # messaging-svc already had. Both mean the mail is where it belongs
            # and there is nothing left to retry — treating the 201 as anything
            # else reports every SUCCESSFUL delivery as a failure.
            if r.status_code in (200, 201):
                return True
            # 422 is the ordinary case, not a fault: it means nobody the mail was
            # addressed to is a member of this org. Most of a mailbox is exactly
            # that, so it is logged at info and never retried.
            if r.status_code == 422:
                log.info("inbound_mail_no_org_recipient", message_id=mail.external_message_id)
                return False
            if 400 <= r.status_code < 500:
                log.warning(
                    "inbound_mail_rejected",
                    status=r.status_code,
                    message_id=mail.external_message_id,
                )
                return False
            r.raise_for_status()  # 5xx → retry_async classifies it as transient
            return False

    try:
        return await retry_async(_attempt, attempts=3, breaker=_mail_breaker)
    except Exception as exc:  # noqa: BLE001 — transport, breaker, or 5xx exhaustion
        log.warning(
            "inbound_mail_delivery_failed",
            message_id=mail.external_message_id,
            error=str(exc),
        )
        return False
