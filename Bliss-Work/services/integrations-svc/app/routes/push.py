"""Public Graph change-notification receiver (NO JWT) — Outlook mail only.

Mounted at /ext/outlook/notifications (see main.py, same /ext prefix the OAuth
callback uses). Graph calls this in two distinct shapes:

1. SUBSCRIPTION VALIDATION — synchronous, happens inside create_subscription's
   own POST /subscriptions call (see providers/microsoft.py's docstring on
   that). A POST with `?validationToken=...` in the query string; we must echo
   it back as text/plain within 10 seconds or the subscription is refused.

2. AN ACTUAL NOTIFICATION — a POST with a JSON body. Graph notifications are
   fire-and-forget "something changed" nudges with NO content: this does not
   deliver the mail, it only lowers mail_sync_worker's next_ingest_at for the
   connection that changed, so the next periodic sweep (within ~60s anyway)
   happens sooner. The real reconciliation — walking the delta, resolving the
   recipients, calling messaging-svc — stays entirely in mail_sync_worker,
   same as the subscription's OWN renewal/creation does; this endpoint never
   touches Graph or messaging-svc itself.

`clientState` is the ONLY thing authenticating a notification — this endpoint
is public and otherwise unauthenticated — so every notification is verified
against the connection its `subscriptionId` claims to be for (constant-time,
fails closed) before anything is nudged.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, Request, Response, status
from fastapi.responses import PlainTextResponse
from sqlalchemy import text

from crypto import cryptor
from ..db import session, set_bypass_rls
from ..logging_setup import log
from ..providers import microsoft as ms

router = APIRouter()


@router.post("/outlook/notifications")
async def outlook_notifications(request: Request) -> Response:
    validation_token = request.query_params.get("validationToken")
    if validation_token is not None:
        # Graph's synchronous handshake — echo back verbatim, text/plain.
        return PlainTextResponse(validation_token, status_code=status.HTTP_200_OK)

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — a malformed body is simply ignored
        return Response(status_code=status.HTTP_202_ACCEPTED)

    for notif in (body.get("value") if isinstance(body, dict) else None) or []:
        if not isinstance(notif, dict):
            continue
        sub_id = str(notif.get("subscriptionId") or "")
        received_state = notif.get("clientState")
        if not sub_id:
            continue
        await _nudge_if_verified(sub_id, received_state)

    # Always 202, whether or not any entry verified — Graph retries on
    # anything else, and a forged/unknown notification is already fully
    # handled by being silently dropped.
    return Response(status_code=status.HTTP_202_ACCEPTED)


async def _nudge_if_verified(sub_id: str, received_state: str | None) -> None:
    async with session() as db:
        await set_bypass_rls(db)  # public endpoint, no org context yet
        row = (
            await db.execute(
                text(
                    """
                    SELECT id, org_id, push_subscription_enc FROM integration_connections
                     WHERE push_subscription_id = :sid AND provider = 'outlook' AND status = 'connected'
                    """
                ),
                {"sid": sub_id},
            )
        ).one_or_none()
        if row is None:
            log.info("outlook_notification_unknown_subscription")
            return

        sub_raw = await cryptor().decrypt(
            db, str(row.org_id), bytes(row.push_subscription_enc) if row.push_subscription_enc else None
        )
        try:
            stored_state = (json.loads(sub_raw) if sub_raw else {}).get("clientState")
        except (ValueError, TypeError):
            stored_state = None

        if not ms.verify_client_state(stored_state or "", received_state):
            log.warning("outlook_notification_client_state_mismatch", connection_id=str(row.id))
            return

        await db.execute(
            text("UPDATE integration_connections SET next_ingest_at = now() WHERE id = :id"),
            {"id": row.id},
        )
        await db.commit()
