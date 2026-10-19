from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from ..auth import Principal, PrincipalDep
from ..db import session
from ..outbox_helpers import enqueue_outbox
from ..platform_authz import PlatformOperatorDep
from ..schemas import PricingEntryDTO, UpdatePricingRequest

router = APIRouter()

_KNOWN_KEYS = {
    "admin_monthly_credits",
    "member_monthly_credits",
    "admin_reference_price_cents",
    "member_reference_price_cents",
    "admin_current_price_cents",
    "member_current_price_cents",
}


def _to_dto(row) -> PricingEntryDTO:
    return PricingEntryDTO(
        key=row.key,
        value=row.value,
        updatedAt=row.updated_at.isoformat(),
        updatedBy=str(row.updated_by) if row.updated_by else None,
    )


@router.get("/pricing", response_model=list[PricingEntryDTO])
async def list_pricing(_: Principal = PrincipalDep) -> list[PricingEntryDTO]:
    """Read-only for any authenticated caller — pricing is not sensitive, and
    the org admin billing view (phase 3) needs it to show monthly cost."""
    async with session() as db:
        rows = (await db.execute(text("SELECT key, value, updated_at, updated_by FROM billing_pricing"))).all()
    return [_to_dto(r) for r in rows]


@router.put("/pricing/{key}", response_model=PricingEntryDTO)
async def update_pricing(
    key: str, body: UpdatePricingRequest, principal: Principal = PlatformOperatorDep
) -> PricingEntryDTO:
    """Platform-operator only (checked server-side via platform_operators —
    see app/platform_authz.py, never the org_admin JWT role). Every change is
    recorded both in billing_pricing.updated_at/updated_by and as an outbox
    event, so there's an append-only audit trail independent of the mutable
    row itself. Does NOT touch any renewal/suspension logic — no automatic
    deductions are wired to this in phase 2."""
    if key not in _KNOWN_KEYS:
        raise HTTPException(status_code=404, detail=f"unknown pricing key: {key}")

    async with session() as db:
        previous = (
            await db.execute(text("SELECT value FROM billing_pricing WHERE key = :k"), {"k": key})
        ).first()

        row = (
            await db.execute(
                text(
                    "UPDATE billing_pricing SET value = CAST(:v AS jsonb), updated_at = now(), "
                    "updated_by = :by WHERE key = :k "
                    "RETURNING key, value, updated_at, updated_by"
                ),
                {"v": json.dumps(body.value), "by": principal.user_id, "k": key},
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail=f"unknown pricing key: {key}")

        await enqueue_outbox(
            db,
            topic="billing.pricing_changed.v1",
            key=key,
            payload={
                "key": key,
                "previousValue": previous.value if previous else None,
                "newValue": body.value,
                "changedBy": principal.user_id,
            },
        )
        await db.commit()
    return _to_dto(row)
