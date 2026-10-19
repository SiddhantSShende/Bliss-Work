from __future__ import annotations

import uuid6
from fastapi import APIRouter, HTTPException
from sqlalchemy import text

from ..auth import Principal, PrincipalDep
from ..db import session
from ..platform_authz import PlatformOperatorDep
from ..schemas import CreatePackageRequest, PackageDTO, UpdatePackageRequest

router = APIRouter()

_ALLOWED_CURRENCIES = {"usd"}


def _to_dto(row) -> PackageDTO:
    return PackageDTO(
        id=str(row.id),
        name=row.name,
        credits=int(row.credits),
        priceCents=int(row.price_cents),
        currency=row.currency,
        active=row.active,
    )


@router.get("/packages", response_model=list[PackageDTO])
async def list_packages(_: Principal = PrincipalDep) -> list[PackageDTO]:
    """Active packages only — this is the purchase catalog a member sees, not
    an admin/audit view."""
    async with session() as db:
        rows = (
            await db.execute(
                text(
                    "SELECT id, name, credits, price_cents, currency, active FROM credit_packages "
                    "WHERE active = true ORDER BY credits ASC"
                )
            )
        ).all()
    return [_to_dto(r) for r in rows]


@router.get("/packages/{package_id}", response_model=PackageDTO)
async def get_package(package_id: str, _: Principal = PrincipalDep) -> PackageDTO:
    """Deliberately NOT filtered on active — a purchase made against a
    package that's since been deactivated must still be able to resolve the
    package it references (credit_purchases.package_id)."""
    async with session() as db:
        row = (
            await db.execute(
                text(
                    "SELECT id, name, credits, price_cents, currency, active FROM credit_packages "
                    "WHERE id = :id"
                ),
                {"id": package_id},
            )
        ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="package not found")
    return _to_dto(row)


@router.post("/packages", response_model=PackageDTO, status_code=201)
async def create_package(
    body: CreatePackageRequest, _: Principal = PlatformOperatorDep
) -> PackageDTO:
    currency = body.currency.lower()
    if currency not in _ALLOWED_CURRENCIES:
        raise HTTPException(status_code=400, detail=f"unsupported currency: {body.currency}")

    package_id = str(uuid6.uuid7())
    async with session() as db:
        await db.execute(
            text(
                "INSERT INTO credit_packages (id, name, credits, price_cents, currency, active) "
                "VALUES (:id, :name, :credits, :price, :currency, true)"
            ),
            {
                "id": package_id,
                "name": body.name,
                "credits": body.credits,
                "price": body.priceCents,
                "currency": currency,
            },
        )
        await db.commit()
    return PackageDTO(
        id=package_id, name=body.name, credits=body.credits, priceCents=body.priceCents,
        currency=currency, active=True,
    )


@router.patch("/packages/{package_id}", response_model=PackageDTO)
async def update_package(
    package_id: str, body: UpdatePackageRequest, _: Principal = PlatformOperatorDep
) -> PackageDTO:
    """Deactivating/repricing a package never touches credit_purchases — those
    rows snapshot credits/amount_cents at purchase time independently of this
    table, so historical purchases are unaffected."""
    fields: dict = {}
    if body.name is not None:
        fields["name"] = body.name
    if body.credits is not None:
        fields["credits"] = body.credits
    if body.priceCents is not None:
        fields["price_cents"] = body.priceCents
    if body.active is not None:
        fields["active"] = body.active
    if not fields:
        raise HTTPException(status_code=400, detail="no fields to update")

    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    async with session() as db:
        row = (
            await db.execute(
                text(
                    f"UPDATE credit_packages SET {set_clause} WHERE id = :id "
                    "RETURNING id, name, credits, price_cents, currency, active"
                ),
                {**fields, "id": package_id},
            )
        ).first()
        if row is None:
            raise HTTPException(status_code=404, detail="package not found")
        await db.commit()
    return _to_dto(row)
