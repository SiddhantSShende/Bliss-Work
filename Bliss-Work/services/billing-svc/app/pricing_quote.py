"""Server-side credit-purchase quote calculation. The ONLY place that prices
a credit purchase — the purchase-initiation endpoint calls this and nothing
else is trusted to produce a price; Cashfree receives the resulting final
amount and never computes it itself.

Rounding: all INR money values are rounded to paise (2 decimal places) using
ROUND_HALF_UP (standard "round half away from zero" convention used for INR/
GST invoicing in India — ties round up, not to even), via `decimal` for
determinism (no float rounding surprises).

Uplift: a flat `credit_uplift_pct` (default 2%, from billing_pricing) is
applied to the USD->INR converted amount and folded into the displayed base
INR total — the plan explicitly asks that this NOT appear as a separate
line item, but the pre/post-uplift amounts are kept in the breakdown for
audit.

GST base (UNRESOLVED / flagged for confirmation): this implementation taxes
the full uplift-inclusive amount the customer actually pays for the credits
(GST = 18% of uplifted_base_inr), on the reasoning that uplift is a price
component of what the customer is being charged for the credits (not a
separate taxable supply, and not something to tax *before* it's applied) —
i.e. GST is charged on the complete consideration for the purchase. This is
the more conservative (higher-GST) reading of the two plausible options the
plan flags as ambiguous; it should be confirmed against actual GST counsel
before this goes live with real money.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

from . import fx

_DEFAULT_UPLIFT_PCT = Decimal("2")
_DEFAULT_GST_PCT = Decimal("18")
_DEFAULT_FIRST_PURCHASE_MIN_CREDITS = 10
_CENTS = Decimal("0.01")


def _round_paise(value: Decimal) -> Decimal:
    return value.quantize(_CENTS, rounding=ROUND_HALF_UP)


async def _pricing_decimal(db: AsyncSession, key: str, default: Decimal) -> Decimal:
    row = (await db.execute(text("SELECT value FROM billing_pricing WHERE key = :k"), {"k": key})).first()
    if row is None or not isinstance(row[0], (int, float, str)):
        return default
    try:
        return Decimal(str(row[0]))
    except Exception:
        return default


async def first_purchase_min_credits(db: AsyncSession) -> int:
    row = (
        await db.execute(
            text("SELECT value FROM billing_pricing WHERE key = 'first_purchase_min_credits'")
        )
    ).first()
    if row is None or not isinstance(row[0], (int, float)):
        return _DEFAULT_FIRST_PURCHASE_MIN_CREDITS
    return int(row[0])


class Quote:
    __slots__ = (
        "credits",
        "base_usd",
        "usd_to_inr_rate",
        "fx_source",
        "fx_quoted_at",
        "pre_uplift_inr",
        "uplift_pct",
        "uplift_inr",
        "base_inr",
        "gst_pct",
        "gst_inr",
        "total_inr",
        "display_currency",
        "display_currency_amount",
        "breakdown",
    )

    def __init__(self, **kwargs) -> None:
        for k, v in kwargs.items():
            setattr(self, k, v)

    def as_cents(self, value: Decimal) -> int:
        return int((value * 100).to_integral_value(rounding=ROUND_HALF_UP))


async def compute_quote(
    db: AsyncSession,
    credits: int,
    display_currency: str | None = None,
) -> Quote:
    if credits <= 0:
        raise ValueError("credits must be positive")

    base_usd = Decimal(credits) * Decimal("1")  # 1 credit == 1 USD base price

    rate, source, fetched_at = await fx.get_usd_rate(db, "INR")
    usd_to_inr_rate = Decimal(str(rate))

    pre_uplift_inr = _round_paise(base_usd * usd_to_inr_rate)

    uplift_pct = await _pricing_decimal(db, "credit_uplift_pct", _DEFAULT_UPLIFT_PCT)
    uplift_inr = _round_paise(pre_uplift_inr * uplift_pct / Decimal("100"))
    base_inr = _round_paise(pre_uplift_inr + uplift_inr)  # the displayed "base INR" total

    gst_pct = await _pricing_decimal(db, "credit_gst_pct", _DEFAULT_GST_PCT)
    # GST base = uplift-inclusive amount (see module docstring: flagged,
    # conservative choice pending confirmation).
    gst_inr = _round_paise(base_inr * gst_pct / Decimal("100"))

    total_inr = _round_paise(base_inr + gst_inr)

    display_amount: Decimal | None = None
    display_rate: Decimal | None = None
    if display_currency and display_currency.strip().upper() != "INR":
        disp_rate, disp_source, disp_fetched_at = await fx.get_usd_rate(db, display_currency)
        display_rate = Decimal(str(disp_rate))
        display_amount = _round_paise(base_usd * display_rate)

    breakdown = {
        "requestedCredits": credits,
        "baseUsd": str(base_usd),
        "fx": {"usdToInr": str(usd_to_inr_rate), "source": source, "quotedAt": fetched_at.isoformat()},
        "preUpliftInr": str(pre_uplift_inr),
        "upliftPct": str(uplift_pct),
        "upliftInr": str(uplift_inr),
        "baseInr": str(base_inr),
        "gstPct": str(gst_pct),
        "gstBase": "upliftInclusive",
        "gstInr": str(gst_inr),
        "totalPayableInr": str(total_inr),
        "displayCurrency": display_currency.strip().upper() if display_currency else None,
        "displayCurrencyAmount": str(display_amount) if display_amount is not None else None,
    }

    return Quote(
        credits=credits,
        base_usd=base_usd,
        usd_to_inr_rate=usd_to_inr_rate,
        fx_source=source,
        fx_quoted_at=fetched_at,
        pre_uplift_inr=pre_uplift_inr,
        uplift_pct=uplift_pct,
        uplift_inr=uplift_inr,
        base_inr=base_inr,
        gst_pct=gst_pct,
        gst_inr=gst_inr,
        total_inr=total_inr,
        display_currency=display_currency.strip().upper() if display_currency else None,
        display_currency_amount=display_amount,
        breakdown=breakdown,
    )
