from __future__ import annotations

from pydantic import BaseModel, Field


class BalanceResponse(BaseModel):
    orgId: str
    balance: int


class ReconcileResponse(BaseModel):
    orgId: str
    storedBalance: int
    computedBalance: int
    matches: bool


class LedgerEntryDTO(BaseModel):
    id: str
    delta: int
    balanceAfter: int
    reason: str
    referenceType: str | None = None
    referenceId: str | None = None
    createdAt: str


class PackageDTO(BaseModel):
    id: str
    name: str
    credits: int
    priceCents: int
    currency: str
    active: bool


class CreatePackageRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    credits: int = Field(gt=0, le=1_000_000)
    priceCents: int = Field(ge=0, le=100_000_000)
    currency: str = Field(default="usd")


class UpdatePackageRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    credits: int | None = Field(default=None, gt=0, le=1_000_000)
    priceCents: int | None = Field(default=None, ge=0, le=100_000_000)
    active: bool | None = None


class PricingEntryDTO(BaseModel):
    key: str
    value: object
    updatedAt: str
    updatedBy: str | None = None


class UpdatePricingRequest(BaseModel):
    value: object
