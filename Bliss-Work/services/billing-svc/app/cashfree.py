"""Cashfree Payment Gateway client — order creation, order-status
verification, and webhook signature verification.

Verified against Cashfree's own docs (2026-10-21):
  - Create Order: https://www.cashfree.com/docs/docs/create-order
      POST {base}/orders
      headers: x-client-id, x-client-secret, x-api-version (e.g. 2023-08-01),
               x-request-id (optional), Content-Type: application/json
      body: {order_id, order_amount, order_currency, customer_details: {
               customer_id, customer_phone, customer_email?, customer_name?},
             order_meta: {return_url}}
      response includes: payment_session_id, order_id, cf_order_id, order_status
  - Get Order (status check / reconciliation):
      GET {base}/orders/{order_id}  with the same x-client-id/x-client-secret/
      x-api-version headers.
  - Webhook signature (subscription + VRS + PPI docs all agree on this core
    scheme): headers `x-webhook-signature` (base64 HMAC-SHA256) and
    `x-webhook-timestamp`. signatureData = timestamp + rawBody (string
    concatenation, no separator), HMAC-SHA256 keyed by the webhook secret,
    base64-encoded, compared to x-webhook-signature. Reject if either header
    is missing or the computed value doesn't match.

Sandbox base: https://sandbox.cashfree.com/pg
Production base: https://api.cashfree.com/pg

Gating: every outbound call checks settings.cashfree_ready (cashfree_enabled
AND both client credentials present) first and raises CashfreeDisabledError
otherwise — callers (routes/purchases.py) must handle that and respond with
a clear "gateway not configured" error rather than silently no-opping.
"""
from __future__ import annotations

import base64
import hashlib
import hmac

import httpx

from .config import settings

_TIMEOUT = 10.0


class CashfreeDisabledError(RuntimeError):
    """Raised when a Cashfree call is attempted but CASHFREE_ENABLED is
    false or credentials are not configured. The purchase flow is wired to
    handle this (TODO: confirm product behaviour — currently surfaced as a
    503 from routes/purchases.py so the quote endpoint still works for UI
    development without live credentials)."""


class CashfreeApiError(RuntimeError):
    def __init__(self, status_code: int, body: str) -> None:
        self.status_code = status_code
        self.body = body
        super().__init__(f"cashfree API error {status_code}: {body[:500]}")


def _headers() -> dict[str, str]:
    return {
        "x-client-id": settings.cashfree_client_id,
        "x-client-secret": settings.cashfree_client_secret,
        "x-api-version": settings.cashfree_api_version,
        "Content-Type": "application/json",
    }


async def create_order(
    *,
    order_id: str,
    order_amount: str,
    customer_id: str,
    customer_email: str | None = None,
    customer_phone: str = "9999999999",
) -> dict:
    """Creates a Cashfree order for an amount already computed server-side
    (app/pricing_quote.py). Never pass a client-supplied amount here.

    order_amount must be a decimal string already rounded to 2dp INR.
    """
    if not settings.cashfree_ready:
        raise CashfreeDisabledError("Cashfree is not enabled/configured")

    payload = {
        "order_id": order_id,
        "order_amount": order_amount,
        "order_currency": "INR",
        "customer_details": {
            "customer_id": customer_id,
            "customer_phone": customer_phone,
            **({"customer_email": customer_email} if customer_email else {}),
        },
        "order_meta": {"return_url": f"{settings.checkout_return_url}?order_id={{order_id}}"},
    }
    async with httpx.AsyncClient(base_url=settings.cashfree_base_url, timeout=_TIMEOUT) as client:
        resp = await client.post("/orders", json=payload, headers=_headers())
    if resp.status_code >= 400:
        raise CashfreeApiError(resp.status_code, resp.text)
    return resp.json()


async def get_order(order_id: str) -> dict:
    """Server-side payment-status verification / reconciliation call. Use
    this to double-check a webhook, or to poll a `pending` purchase that's
    been stuck past a reasonable window (no scheduler is wired up here —
    flagged in the report as a recommended follow-up: a periodic job calling
    this for any `pending` credit_purchases row older than e.g. 30 minutes)."""
    if not settings.cashfree_ready:
        raise CashfreeDisabledError("Cashfree is not enabled/configured")
    async with httpx.AsyncClient(base_url=settings.cashfree_base_url, timeout=_TIMEOUT) as client:
        resp = await client.get(f"/orders/{order_id}", headers=_headers())
    if resp.status_code >= 400:
        raise CashfreeApiError(resp.status_code, resp.text)
    return resp.json()


def verify_webhook_signature(raw_body: bytes, timestamp: str, signature: str) -> bool:
    """signatureData = timestamp + rawBody, HMAC-SHA256 keyed by the webhook
    secret, base64-encoded, constant-time compared to the header value."""
    if not settings.cashfree_webhook_secret:
        return False
    if not timestamp or not signature:
        return False
    signed = timestamp.encode("utf-8") + raw_body
    digest = hmac.new(
        settings.cashfree_webhook_secret.encode("utf-8"), signed, hashlib.sha256
    ).digest()
    expected = base64.b64encode(digest).decode("utf-8")
    return hmac.compare_digest(expected, signature)
