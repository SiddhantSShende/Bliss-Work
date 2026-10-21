"""Credit-purchase initiation + quote endpoints. org_admin-gated (reuses
OrgAdminDep, same as balance.py's /balance/reconcile).

Pricing is computed ENTIRELY server-side (app/pricing_quote.py) from
credits + live FX only — the client never supplies price/tax/rate, and
org_id always comes from the authenticated principal, never the request
body.
"""
from __future__ import annotations

import json
import uuid

import uuid6
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text

from .. import cashfree, pricing_quote
from ..auth import OrgAdminDep, Principal
from ..db import session
from ..config import settings

router = APIRouter()


class QuoteRequest(BaseModel):
    credits: int = Field(gt=0, le=1_000_000)
    displayCurrency: str | None = Field(default=None, max_length=8)


class QuoteResponse(BaseModel):
    credits: int
    baseUsd: str
    baseInr: str
    gstInr: str
    totalPayableInr: str
    displayCurrency: str | None = None
    displayCurrencyAmount: str | None = None
    fxRate: str
    fxSource: str
    minCredits: int


class InitiatePurchaseRequest(BaseModel):
    credits: int = Field(gt=0, le=1_000_000)
    displayCurrency: str | None = Field(default=None, max_length=8)


class PurchaseResponse(BaseModel):
    id: str
    status: str
    credits: int
    baseInrCents: int
    gstInrCents: int
    totalPayableInrCents: int
    displayCurrency: str | None = None
    displayCurrencyAmount: str | None = None
    gatewayOrderId: str | None = None
    paymentSessionId: str | None = None
    gatewayEnabled: bool
    idempotencyKey: str


async def _has_completed_purchase(db, org_id: str) -> bool:
    row = (
        await db.execute(
            text(
                "SELECT 1 FROM credit_purchases WHERE org_id = :org AND status = 'completed' LIMIT 1"
            ),
            {"org": org_id},
        )
    ).first()
    return row is not None


@router.post("/purchases/quote", response_model=QuoteResponse)
async def quote_purchase(body: QuoteRequest, principal: Principal = OrgAdminDep) -> QuoteResponse:
    async with session() as db:
        min_credits = await pricing_quote.first_purchase_min_credits(db)
        if body.credits < min_credits and not await _has_completed_purchase(db, principal.org_id):
            raise HTTPException(
                status_code=422,
                detail=f"first purchase must be at least {min_credits} credits",
            )
        q = await pricing_quote.compute_quote(db, body.credits, body.displayCurrency)
        await db.commit()  # fx_rate_cache may have been written (app/fx.py)
    return QuoteResponse(
        credits=q.credits,
        baseUsd=str(q.base_usd),
        baseInr=str(q.base_inr),
        gstInr=str(q.gst_inr),
        totalPayableInr=str(q.total_inr),
        displayCurrency=q.display_currency,
        displayCurrencyAmount=str(q.display_currency_amount) if q.display_currency_amount is not None else None,
        fxRate=str(q.usd_to_inr_rate),
        fxSource=q.fx_source,
        minCredits=min_credits,
    )


def _row_to_response(row, gateway_enabled: bool) -> PurchaseResponse:
    return PurchaseResponse(
        id=str(row.id),
        status=row.status,
        credits=int(row.requested_credits or row.credits),
        baseInrCents=int(row.base_inr_cents or 0),
        gstInrCents=int(row.gst_inr_cents or 0),
        totalPayableInrCents=int(row.total_payable_inr_cents or 0),
        displayCurrency=row.display_currency,
        displayCurrencyAmount=str(row.display_currency_amount) if row.display_currency_amount is not None else None,
        gatewayOrderId=row.gateway_order_id,
        paymentSessionId=row.gateway_payment_session_id,
        gatewayEnabled=gateway_enabled,
        idempotencyKey=row.idempotency_key,
    )


@router.post("/purchases", response_model=PurchaseResponse, status_code=201)
async def initiate_purchase(
    body: InitiatePurchaseRequest,
    principal: Principal = OrgAdminDep,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> PurchaseResponse:
    key = idempotency_key or str(uuid6.uuid7())

    async with session() as db:
        existing = (
            await db.execute(
                text(
                    "SELECT * FROM credit_purchases WHERE org_id = :org AND idempotency_key = :key"
                ),
                {"org": principal.org_id, "key": key},
            )
        ).first()
        if existing is not None:
            # Retry with the same key: return the SAME row, never create a
            # second one, and never recompute the price.
            return _row_to_response(existing, settings.cashfree_ready)

        min_credits = await pricing_quote.first_purchase_min_credits(db)
        if body.credits < min_credits and not await _has_completed_purchase(db, principal.org_id):
            raise HTTPException(
                status_code=422,
                detail=f"first purchase must be at least {min_credits} credits",
            )

        q = await pricing_quote.compute_quote(db, body.credits, body.displayCurrency)

        purchase_id = str(uuid6.uuid7())
        gateway_order_id = f"po_{uuid.uuid4().hex[:24]}"
        amount_cents = q.as_cents(q.total_inr)

        await db.execute(
            text(
                """
                INSERT INTO credit_purchases (
                    id, org_id, credits, amount_cents, currency, payment_provider, status,
                    idempotency_key, requested_credits, display_currency, display_currency_amount,
                    uplift_pct, calculation_breakdown, gateway_order_id,
                    fx_rate_used, fx_rate_source, fx_quoted_at,
                    base_inr_cents, gst_inr_cents, total_payable_inr_cents
                ) VALUES (
                    :id, :org, :credits, :amount_cents, 'inr', 'cashfree', 'pending',
                    :key, :req_credits, :disp_ccy, :disp_amt,
                    :uplift_pct, :breakdown, :gw_order_id,
                    :fx_rate, :fx_source, :fx_quoted_at,
                    :base_inr_cents, :gst_inr_cents, :total_inr_cents
                )
                """
            ),
            {
                "id": purchase_id,
                "org": principal.org_id,
                "credits": q.credits,
                "amount_cents": amount_cents,
                "key": key,
                "req_credits": q.credits,
                "disp_ccy": q.display_currency,
                "disp_amt": q.display_currency_amount,
                "uplift_pct": q.uplift_pct,
                "breakdown": json.dumps(q.breakdown),
                "gw_order_id": gateway_order_id,
                "fx_rate": q.usd_to_inr_rate,
                "fx_source": q.fx_source,
                "fx_quoted_at": q.fx_quoted_at,
                "base_inr_cents": q.as_cents(q.base_inr),
                "gst_inr_cents": q.as_cents(q.gst_inr),
                "total_inr_cents": amount_cents,
            },
        )

        payment_session_id = None
        if settings.cashfree_ready:
            try:
                order = await cashfree.create_order(
                    order_id=gateway_order_id,
                    order_amount=str(q.total_inr),
                    customer_id=principal.org_id,
                )
                payment_session_id = order.get("payment_session_id")
                await db.execute(
                    text(
                        "UPDATE credit_purchases SET gateway_payment_session_id = :sid, "
                        "gateway_cf_order_id = :cf_id WHERE id = :id"
                    ),
                    {
                        "sid": payment_session_id,
                        "cf_id": order.get("cf_order_id"),
                        "id": purchase_id,
                    },
                )
            except cashfree.CashfreeApiError:
                # Leave the purchase `pending` with no session id; the client
                # sees gatewayEnabled=true but paymentSessionId=None and can
                # retry (same idempotency key -> same row) once Cashfree
                # recovers, rather than abandoning the server-side quote.
                payment_session_id = None

        row = (
            await db.execute(text("SELECT * FROM credit_purchases WHERE id = :id"), {"id": purchase_id})
        ).first()
        await db.commit()

    resp = _row_to_response(row, settings.cashfree_ready)
    resp.paymentSessionId = payment_session_id
    return resp


@router.get("/purchases/{purchase_id}", response_model=PurchaseResponse)
async def get_purchase(purchase_id: str, principal: Principal = OrgAdminDep) -> PurchaseResponse:
    async with session() as db:
        row = (
            await db.execute(
                text("SELECT * FROM credit_purchases WHERE id = :id AND org_id = :org"),
                {"id": purchase_id, "org": principal.org_id},
            )
        ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="purchase not found")
    return _row_to_response(row, settings.cashfree_ready)
