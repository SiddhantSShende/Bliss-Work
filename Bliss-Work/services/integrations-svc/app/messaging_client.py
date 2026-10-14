"""Calls into messaging-svc's internal mail endpoints.

Three call sites share this module: mail_sync_worker's inbound producer
(POST /internal/mail/inbound — messaging-svc's existing endpoint, previously
uncalled by anything in this deployment), and the two write-back-enabling
endpoints added alongside it (PATCH .../external-ref, POST .../hide-for-owner).

Authenticated with messaging-svc's OWN internal secret (MESSAGING_INTERNAL_TOKEN)
— the same value email-worker already holds to reach this service, not a secret
of ours. See config.py's field comment.

Every function here is best-effort and NEVER raises: the callers are mid-sweep
(mail_sync_worker, advancing a delta cursor) or post-send (routes/internal.py,
after Graph already accepted the mail) — in both cases a messaging-svc hiccup
must be logged and skipped, not allowed to stall or fail something that already
happened.
"""
from __future__ import annotations

import httpx

from .config import settings
from .logging_setup import log
from resilience import CircuitBreaker, retry_async

_TIMEOUT = httpx.Timeout(10.0, connect=2.0)
_breaker = CircuitBreaker(fail_max=5, reset_timeout=30.0, name="messaging-svc-mail")


def _headers() -> dict[str, str]:
    return {"X-Internal-Token": settings.messaging_internal_token, "Content-Type": "application/json"}


async def deliver_inbound_mail(payload: dict) -> dict | None:
    """POST /internal/mail/inbound. Returns the response body, or None on failure.

    200 ({"duplicate": true}) and 201 ({"mailId": ..., "delivered": N}) are both
    success — the caller (mail_sync_worker) upserts mail_sync_links either way,
    which is why BOTH shapes need to carry a usable mailId; see that endpoint's
    own 404-on-no-recipient handling for the one case this returns None for a
    reason other than a transport fault.
    """

    async def _attempt() -> dict | None:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                f"{settings.messaging_internal_base.rstrip('/')}/internal/mail/inbound",
                headers=_headers(),
                json=payload,
            )
            if r.status_code in (200, 201):
                return r.json()
            # 422/404-shaped "nobody here to deliver to" is the ordinary case for
            # most of a mailbox, not a fault — logged at info, never retried.
            if 400 <= r.status_code < 500:
                log.info(
                    "inbound_mail_rejected",
                    status=r.status_code,
                    external_message_id=payload.get("externalMessageId"),
                )
                return None
            r.raise_for_status()  # 5xx → retry_async classifies it as transient
            return None

    try:
        return await retry_async(_attempt, attempts=3, breaker=_breaker)
    except Exception as exc:  # noqa: BLE001 — transport, breaker, or 5xx exhaustion
        log.warning(
            "inbound_mail_delivery_failed",
            external_message_id=payload.get("externalMessageId"),
            error=str(exc),
        )
        return None


async def set_external_ref(org_id: str, mail_id: str, internet_message_id: str) -> bool:
    """PATCH /internal/mail/{mailId}/external-ref — backfill a locally-SENT
    mail's external_message_id with the Graph-assigned internetMessageId, so
    mail_sync_worker's Sent-Items delta walk later dedups it for free. See
    microsoft.py's module docstring for why this has to happen at all."""

    async def _attempt() -> bool:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.patch(
                f"{settings.messaging_internal_base.rstrip('/')}/internal/mail/{mail_id}/external-ref",
                headers=_headers(),
                json={"orgId": org_id, "externalMessageId": internet_message_id},
            )
            if r.status_code in (200, 204):
                return True
            if 400 <= r.status_code < 500:
                log.warning("mail_external_ref_rejected", status=r.status_code, mail_id=mail_id)
                return False
            r.raise_for_status()
            return False

    try:
        return await retry_async(_attempt, attempts=3, breaker=_breaker)
    except Exception as exc:  # noqa: BLE001
        log.warning("mail_external_ref_failed", mail_id=mail_id, error=str(exc))
        return False


async def mark_read_for_owner(org_id: str, mail_id: str, owner_user_id: str, is_read: bool) -> bool:
    """POST /internal/mail/{mailId}/read-for-owner — the inbound half of
    read-state sync: mirror what the delta walk saw in the connected user's
    own Outlook mailbox into their own BlissWork mail_deliveries row."""

    async def _attempt() -> bool:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                f"{settings.messaging_internal_base.rstrip('/')}/internal/mail/{mail_id}/read-for-owner",
                headers=_headers(),
                json={"orgId": org_id, "ownerUserId": owner_user_id, "isRead": is_read},
            )
            if r.status_code in (200, 204, 404):
                return True
            if 400 <= r.status_code < 500:
                log.warning("mail_read_for_owner_rejected", status=r.status_code, mail_id=mail_id)
                return False
            r.raise_for_status()
            return False

    try:
        return await retry_async(_attempt, attempts=3, breaker=_breaker)
    except Exception as exc:  # noqa: BLE001
        log.warning("mail_read_for_owner_failed", mail_id=mail_id, error=str(exc))
        return False


async def hide_for_owner(org_id: str, mail_id: str, owner_user_id: str) -> bool:
    """POST /internal/mail/{mailId}/hide-for-owner — the inbound half of delete
    sync: the connected user deleted this message in Outlook, so hide THEIR
    copy only. Never touches any other recipient's mailbox row."""

    async def _attempt() -> bool:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                f"{settings.messaging_internal_base.rstrip('/')}/internal/mail/{mail_id}/hide-for-owner",
                headers=_headers(),
                json={"orgId": org_id, "ownerUserId": owner_user_id},
            )
            if r.status_code in (200, 204, 404):
                # 404 (no such delivery for this owner) is benign: nothing to hide.
                return True
            if 400 <= r.status_code < 500:
                log.warning("mail_hide_for_owner_rejected", status=r.status_code, mail_id=mail_id)
                return False
            r.raise_for_status()
            return False

    try:
        return await retry_async(_attempt, attempts=3, breaker=_breaker)
    except Exception as exc:  # noqa: BLE001
        log.warning("mail_hide_for_owner_failed", mail_id=mail_id, error=str(exc))
        return False
