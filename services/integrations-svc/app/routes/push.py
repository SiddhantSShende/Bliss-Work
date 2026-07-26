"""Public push receivers for Gmail (Pub/Sub) and Microsoft Graph (NO JWT).

Mounted under /ext, alongside the webhook receivers — a PUBLIC path, outside
the /internal/ segment the WAF 404s and outside the credentialed CORS group.

These two endpoints are reachable by anyone on the internet, and each has
exactly one thing standing between it and forged mention data:

  Gmail  : the push request carries a Google-signed OIDC JWT in
           `Authorization: Bearer`. We verify the signature against Google's
           public keys AND that `aud` is our own endpoint. Verifying the
           signature alone is not enough — any Google-issued token would pass —
           so the audience check is what binds the token to us.

  Graph  : the notification carries the `clientState` we chose when creating the
           subscription. It is compared CONSTANT-TIME. That is the only
           authenticator Graph offers; the payload is otherwise unauthenticated.

Both receivers do the minimum synchronously and hand the real work to the
worker, because both vendors enforce short delivery deadlines (Graph: 10s for
the validation handshake, ~30s for a notification) and will disable a
subscription that repeatedly times out.
"""
from __future__ import annotations

import base64
import json

import jwt
from fastapi import APIRouter, HTTPException, Request, Response, status
from jwt import PyJWKClient
from sqlalchemy import text

from ..config import settings
from ..crypto import cryptor
from ..db import session, set_bypass_rls
from ..providers import microsoft as ms

router = APIRouter()

#: Google's OIDC signing keys. PyJWKClient caches fetched keys internally, so
#: one module-level client avoids re-fetching the JWKS on every push — which at
#: Gmail's notification rate would be a self-inflicted rate limit.
_GOOGLE_JWKS = PyJWKClient("https://www.googleapis.com/oauth2/v3/certs")

#: Wake the connection for an immediate sweep.
#:
#: We deliberately do NOT write the pushed historyId as the cursor: the cursor
#: may only advance in the same transaction that ingested the messages, or a
#: crash between the two silently skips everything in between.
_GMAIL_DUE_NOW = text(
    """
    UPDATE integration_connections
       SET next_ingest_at = now()
     WHERE provider = 'gmail'
       AND status = 'connected'
       AND external_account_id_bidx = :b
    """
)


# ── Gmail: Pub/Sub push ───────────────────────────────────────────────────────
@router.post("/gmail/push")
async def gmail_push(request: Request) -> Response:
    """Receive a Gmail change notification via Google Cloud Pub/Sub push.

    Pub/Sub retries on any non-2xx, so this returns 204 for anything it cannot
    act on (unknown mailbox, undecodable payload). Returning 4xx there would
    make Google redeliver the same dead message until it expires.

    A FORGED request is different: that gets 401, because it must not be
    silently accepted as valid.
    """
    token = _bearer(request)
    claims = await _verify_google_oidc(token)
    if claims is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="bad push token")

    try:
        envelope = json.loads(await request.body() or b"{}")
    except ValueError:
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    email_address, history_id = _decode_pubsub_message(envelope)
    if not email_address:
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    # The notification says only "this mailbox changed, at least up to
    # historyId". It carries no message content, so the actual fetch happens in
    # the worker against the stored cursor — which also means a duplicate or
    # out-of-order push is harmless.
    async with session() as db:
        await set_bypass_rls(db)
        # `history_id` is intentionally unused: it is only a hint that the
        # mailbox changed. The worker re-reads from the STORED cursor, which is
        # what makes a duplicate or out-of-order push harmless.
        await db.execute(_GMAIL_DUE_NOW, {"b": cryptor().blind_index(email_address.lower())})
        await db.commit()

    # 204 regardless of whether a row matched: an unknown or disconnected
    # mailbox is not something Pub/Sub can fix by redelivering.
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _bearer(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else ""


async def _verify_google_oidc(token: str) -> dict | None:
    """Verify a Google-signed OIDC token from a Pub/Sub push subscription.

    Returns the claims, or None when the token is missing, malformed, expired,
    signed by the wrong key, or issued for a different audience.

    The audience check is not optional. Google signs tokens for every project on
    the platform; without pinning `aud` to our own push endpoint, any of them
    would authenticate a forged mention.
    """
    if not token:
        return None

    expected_aud = f"{settings.public_base_url.rstrip('/')}/ext/gmail/push"
    try:
        signing_key = _GOOGLE_JWKS.get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=expected_aud,
            issuer=["https://accounts.google.com", "accounts.google.com"],
        )
    except Exception:  # noqa: BLE001 — any verification failure is a rejection
        return None


def _decode_pubsub_message(envelope: dict) -> tuple[str, str]:
    """Pull (emailAddress, historyId) out of a Pub/Sub push envelope.

    The interesting payload is base64 inside `message.data`, and Gmail's own
    JSON is inside THAT. Returns ("", "") for anything malformed rather than
    raising — a bad envelope must be acked, not retried forever.
    """
    message = envelope.get("message") or {}
    raw = message.get("data")
    if not raw:
        return "", ""
    try:
        decoded = base64.b64decode(raw + "=" * (-len(raw) % 4))
        payload = json.loads(decoded)
    except (ValueError, TypeError):
        return "", ""
    if not isinstance(payload, dict):
        return "", ""
    return str(payload.get("emailAddress") or ""), str(payload.get("historyId") or "")


# ── Microsoft Graph: change notifications ─────────────────────────────────────
@router.post("/microsoft/notifications")
async def graph_notifications(request: Request) -> Response:
    """Receive Graph change notifications for Outlook mail / Teams chat.

    TWO distinct jobs, and the order matters:

    1. VALIDATION HANDSHAKE. When a subscription is created, Graph immediately
       POSTs here with a `?validationToken=` query param and expects that exact
       string echoed back as text/plain, within 10 seconds. This happens BEFORE
       any subscription exists, so it cannot be authenticated — echoing an
       opaque token we were just handed leaks nothing, and refusing it means no
       subscription can ever be created.

    2. NOTIFICATIONS. Each carries the `clientState` we chose at subscription
       time; compared constant-time. Anything that fails is dropped.
    """
    validation_token = request.query_params.get("validationToken")
    if validation_token:
        # Must be text/plain and the raw token — Graph rejects JSON here.
        return Response(content=validation_token, media_type="text/plain")

    try:
        payload = json.loads(await request.body() or b"{}")
    except ValueError:
        # Always 202: Graph disables a subscription that returns errors
        # repeatedly, and an unparseable body is not something a retry fixes.
        return Response(status_code=status.HTTP_202_ACCEPTED)

    notifications = payload.get("value") or []
    if not isinstance(notifications, list):
        return Response(status_code=status.HTTP_202_ACCEPTED)

    async with session() as db:
        await set_bypass_rls(db)
        for note in notifications:
            if not isinstance(note, dict):
                continue
            sub_id = str(note.get("subscriptionId") or "")
            client_state = note.get("clientState")
            if not sub_id:
                continue

            row = (
                await db.execute(
                    text(
                        """
                        SELECT id, org_id, push_subscription_enc
                          FROM integration_connections
                         WHERE provider IN ('outlook', 'teams')
                           AND status = 'connected'
                           AND push_subscription_id = :sid
                         LIMIT 1
                        """
                    ),
                    {"sid": sub_id},
                )
            ).one_or_none()
            if row is None:
                continue

            expected = await _stored_client_state(db, str(row.org_id), row.push_subscription_enc)
            if not ms.verify_client_state(expected, client_state):
                # A notification we cannot authenticate is dropped silently.
                # Not 401: that would tell a prober which subscription ids exist.
                continue

            await db.execute(
                text(
                    "UPDATE integration_connections SET next_ingest_at = now() WHERE id = :id"
                ),
                {"id": row.id},
            )
        await db.commit()

    return Response(status_code=status.HTTP_202_ACCEPTED)


async def _stored_client_state(db, org_id: str, blob) -> str:
    """Decrypt the clientState we generated when creating the subscription."""
    if not blob:
        return ""
    plain = await cryptor().decrypt(db, org_id, bytes(blob))
    try:
        return str(json.loads(plain or "{}").get("clientState") or "")
    except (ValueError, TypeError):
        return ""
