"""Cashfree webhook receiver. No principal auth — authenticity comes
entirely from the HMAC signature (app/cashfree.verify_webhook_signature).

Idempotency / ordering: the credit_purchases row is looked up and row-locked
(`SELECT ... FOR UPDATE`) by gateway_order_id, inside a transaction, before
any status transition — this is what makes concurrent/duplicate webhook
deliveries for the same order serialize safely. Once a purchase is terminal
(`completed`, `failed`, `refunded`, `expired`) any further webhook for it is
a no-op: we never regress a completed purchase on a late/out-of-order
"failed" event, and we never grant credits twice.

Route is registered unconditionally (so it's testable without live
credentials), but every verified "paid" event's credit grant only runs if
the signature itself verifies, which requires CASHFREE_WEBHOOK_SECRET to be
configured — with no secret configured, verify_webhook_signature always
returns False and the endpoint responds 401.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from sqlalchemy import text

from .. import cashfree, ledger
from ..db import session

router = APIRouter()

_TERMINAL = {"completed", "failed", "refunded", "expired"}

# Cashfree order-webhook `type` values that represent a successful payment vs
# a terminal failure. (PAYMENT_SUCCESS_WEBHOOK / PAYMENT_FAILED_WEBHOOK /
# PAYMENT_USER_DROPPED_WEBHOOK per Cashfree's payments webhook docs.)
_SUCCESS_TYPES = {"PAYMENT_SUCCESS_WEBHOOK"}
_FAILURE_TYPES = {"PAYMENT_FAILED_WEBHOOK", "PAYMENT_USER_DROPPED_WEBHOOK", "PAYMENT_EXPIRED_WEBHOOK"}


@router.post("/webhooks/cashfree")
async def cashfree_webhook(request: Request) -> dict:
    raw_body = await request.body()
    timestamp = request.headers.get("x-webhook-timestamp", "")
    signature = request.headers.get("x-webhook-signature", "")

    if not cashfree.verify_webhook_signature(raw_body, timestamp, signature):
        raise HTTPException(status_code=401, detail="invalid webhook signature")

    payload = await request.json()
    event_type = payload.get("type", "")
    data = payload.get("data", {}) or {}
    order = data.get("order", {}) or {}
    gateway_order_id = order.get("order_id")
    cf_order_id = order.get("cf_order_id") or order.get("order_id")

    if not gateway_order_id:
        # Malformed/unexpected payload shape — ack with 200 so Cashfree
        # doesn't retry forever, but do nothing.
        return {"status": "ignored", "reason": "missing order_id"}

    async with session() as db:
        row = (
            await db.execute(
                text("SELECT * FROM credit_purchases WHERE gateway_order_id = :id FOR UPDATE"),
                {"id": gateway_order_id},
            )
        ).first()
        if row is None:
            return {"status": "ignored", "reason": "unknown order"}

        await db.execute(
            text("UPDATE credit_purchases SET gateway_last_event = :ev WHERE id = :id"),
            {"ev": json.dumps(payload), "id": row.id},
        )

        if row.status in _TERMINAL:
            # Already terminal: duplicate delivery, or an out-of-order event
            # arriving after we've already settled this purchase. No-op by
            # design — never regress a completed purchase, never re-grant.
            await db.commit()
            return {"status": "noop", "purchaseStatus": row.status}

        if event_type in _SUCCESS_TYPES:
            await db.execute(
                text(
                    "UPDATE credit_purchases SET status = 'completed', completed_at = now(), "
                    "payment_reference = :ref WHERE id = :id"
                ),
                {"ref": cf_order_id, "id": row.id},
            )
            await ledger.grant_credits(
                db,
                row.org_id,
                int(row.requested_credits or row.credits),
                reason="credit_purchase",
                reference_type="credit_purchase",
                reference_id=str(row.id),
                idempotency_key=f"purchase:{row.id}",
            )
            await db.commit()
            return {"status": "completed"}

        if event_type in _FAILURE_TYPES:
            reason = "expired" if event_type == "PAYMENT_EXPIRED_WEBHOOK" else "failed"
            await db.execute(
                text(
                    "UPDATE credit_purchases SET status = :status, failed_reason = :reason, "
                    "payment_reference = :ref WHERE id = :id"
                ),
                {
                    "status": "expired" if reason == "expired" else "failed",
                    "reason": event_type,
                    "ref": cf_order_id,
                    "id": row.id,
                },
            )
            await db.commit()
            return {"status": reason}

        # Unrecognized event type for a non-terminal purchase — ack, no
        # state change.
        await db.commit()
        return {"status": "noop", "reason": "unhandled event type"}
