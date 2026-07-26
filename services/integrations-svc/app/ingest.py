"""The ONE inbound funnel: raw provider payload → provider_activity row.

Every way a message can arrive goes through `ingest_one`:

  * the public webhook receiver          (Slack, WhatsApp)   — routes/webhooks.py
  * the push receivers / polling worker  (Gmail, Outlook, Teams)

so mention detection, at-rest encryption, webhook dedup and the live events are
impossible to get right in one path and wrong in another. A new provider only
has to fetch the item and hand it over.

Dedup lives entirely in `uq_provider_activity_ext (connection_id,
external_id_bidx)`: a replayed webhook, a re-fetched poll page after a crash, or
a push notification racing the reconciliation sweep all collapse onto the same
row, and only the FIRST one emits events.
"""

from __future__ import annotations

from datetime import datetime

import uuid6
from sqlalchemy import text

from .crypto import cryptor
from .events import emit_activity_created, emit_mention_created
from .identities import resolve_users
from .mentions import detect_mentions


async def claim_event(db, provider: str, event_id: str) -> bool:
    """Idempotency claim on a provider's own event id: True the first time this
    event is seen. Deliberately separate from the activity dedup above — it
    fires BEFORE org context is known and covers events that never produce an
    activity row at all."""
    res = await db.execute(
        text(
            """
            INSERT INTO webhook_events (id, provider, external_event_id, signature_verified, received_at)
            VALUES (:id, :p, :e, true, now())
            ON CONFLICT (provider, external_event_id) WHERE external_event_id IS NOT NULL
            DO NOTHING
            """
        ),
        {"id": str(uuid6.uuid7()), "p": provider, "e": event_id},
    )
    return res.rowcount > 0


async def ingest_one(
    db,
    conn,
    provider: str,
    *,
    raw: dict,
    external_id: str | None,
    peer: str,
    body: str,
    kind: str = "message",
    status_label: str = "received",
    occurred_at: datetime | None = None,
    connected_account: str | None = None,
    owner_handle: str | None = None,
) -> str | None:
    """Record one inbound item, flagging it as a mention when the RAW payload
    tags a mapped Bliss-Work user.

    `conn` is a row from integration_connections carrying at least id, org_id,
    owner_user_id, created_by and external_account_id_bidx. `raw` is the
    provider's own payload — mention markup only exists there, never in `body`.

    Returns the new activity id, or None when the row already existed (dedup).

    LIMITATION (v1): at most ONE mention row per message, for the first matched
    user. The dedup index is per-message, so fanning a message that tags three
    teammates out to three rows would need a child table. Doing so is additive
    and would not change the API shape.
    """
    org = str(conn.org_id)
    owner = str(conn.owner_user_id) if conn.owner_user_id else None

    scan = detect_mentions(
        provider, raw, connected_account=connected_account, owner_handle=owner_handle
    )
    mention_user_id: str | None = None
    if scan.handles:
        matched = await resolve_users(
            db,
            org,
            provider,
            scan.handles,
            fallback_user_id=owner,
            fallback_handle_bidx=getattr(conn, "external_account_id_bidx", None),
        )
        mention_user_id = matched[0] if matched else None

    is_mention = mention_user_id is not None
    activity_id = str(uuid6.uuid7())
    res = await db.execute(
        text(
            """
            INSERT INTO provider_activity
                (id, org_id, owner_user_id, connection_id, provider, direction,
                 kind, external_id_bidx, peer_enc, body_enc, status, occurred_at,
                 is_mention, mention_user_id, mention_state,
                 external_thread_ref_enc, external_permalink_enc)
            VALUES
                (:id, :o, :owner, :c, :p, 'inbound', :kind, :xb, :peer, :b, :st,
                 COALESCE(:occ, now()),
                 :is_mention, :mu,
                 CASE WHEN :is_mention THEN 'pending' ELSE NULL END,
                 :thread, :link)
            ON CONFLICT (connection_id, external_id_bidx) WHERE external_id_bidx IS NOT NULL
            DO NOTHING
            """
        ),
        {
            "id": activity_id,
            "o": org,
            "owner": owner,
            "c": conn.id,
            "p": provider,
            "kind": kind,
            "xb": cryptor().blind_index(str(external_id)) if external_id else None,
            "peer": await cryptor().encrypt(db, org, peer or ""),
            "b": await cryptor().encrypt(db, org, body or ""),
            "st": status_label,
            "occ": occurred_at,
            "is_mention": is_mention,
            "mu": mention_user_id,
            "thread": await cryptor().encrypt(db, org, scan.thread_ref)
            if scan.thread_ref
            else None,
            "link": await cryptor().encrypt(db, org, scan.permalink) if scan.permalink else None,
        },
    )

    # Only announce a row we actually inserted — a dedupe must stay silent, or a
    # provider retry would re-notify (and re-toast) the user for one message.
    if res.rowcount == 0:
        return None

    await emit_activity_created(
        db,
        org_id=org,
        recipient_id=str(conn.created_by) if conn.created_by else owner,
        activity_id=activity_id,
        connection_id=str(conn.id),
        provider=provider,
        kind=kind,
        direction="inbound",
    )
    if mention_user_id:
        await emit_mention_created(
            db,
            org_id=org,
            recipient_id=mention_user_id,
            activity_id=activity_id,
            connection_id=str(conn.id),
            provider=provider,
            kind=kind,
        )
    return activity_id
