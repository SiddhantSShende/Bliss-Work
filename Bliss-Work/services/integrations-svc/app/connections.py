"""Connection state transitions that more than one route needs.

Today that is one thing: promoting a WhatsApp connection out of `pending`.

A WhatsApp connection is created pending because validating its credentials only
proves the token can READ the business number — it says nothing about whether the
webhook is wired, and a connection that looks Connected while receiving nothing
is worse than one that admits it isn't ready. The proof is Meta's own webhook
verification request, which arrives the moment the admin saves the webhook URL in
their dashboard: see routes/webhooks.py::verify_webhook.

That request is business-side and needs no phone number from anyone, which is why
it replaced the confirmation code this service briefly sent to an admin's
personal WhatsApp.
"""
from __future__ import annotations

from sqlalchemy import text


async def confirm_connection(db, connection_id: str) -> bool:
    """Promote a pending connection to 'connected'. True if this call did it.

    Guarded on 'pending' so it can never resurrect a connection the user revoked,
    and so a webhook re-verification against an already-live connection is a
    no-op rather than a spurious state change. The caller owns the transaction.
    """
    res = await db.execute(
        text(
            """
            UPDATE integration_connections
               SET status = 'connected', last_error = NULL, updated_at = now()
             WHERE id = :c AND status = 'pending'
            """
        ),
        {"c": connection_id},
    )
    return res.rowcount > 0
