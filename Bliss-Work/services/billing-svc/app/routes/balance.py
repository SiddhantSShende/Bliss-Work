from __future__ import annotations

from fastapi import APIRouter, Query
from sqlalchemy import text

from .. import ledger
from ..auth import OrgAdminDep, Principal, PrincipalDep
from ..db import session
from ..schemas import BalanceResponse, LedgerEntryDTO, ReconcileResponse

router = APIRouter()

_DEFAULT_LIMIT = 50
_MAX_LIMIT = 200


@router.get("/balance", response_model=BalanceResponse)
async def get_balance(principal: Principal = PrincipalDep) -> BalanceResponse:
    """Org-scoped: always the caller's own org, never a client-supplied id."""
    async with session() as db:
        bal = await ledger.get_balance(db, principal.org_id)
    return BalanceResponse(orgId=principal.org_id, balance=bal)


@router.get("/ledger", response_model=list[LedgerEntryDTO])
async def list_ledger(
    principal: Principal = PrincipalDep,
    limit: int = Query(default=_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    before: str | None = Query(default=None),
) -> list[LedgerEntryDTO]:
    async with session() as db:
        params: dict = {"org": principal.org_id, "limit": limit}
        clause = ""
        if before:
            clause = "AND created_at < (SELECT created_at FROM credit_ledger WHERE id = :before)"
            params["before"] = before
        rows = (
            await db.execute(
                text(
                    "SELECT id, delta, balance_after, reason, reference_type, reference_id, created_at "
                    "FROM credit_ledger WHERE org_id = :org "
                    f"{clause} ORDER BY created_at DESC LIMIT :limit"
                ),
                params,
            )
        ).all()
    return [
        LedgerEntryDTO(
            id=str(r.id),
            delta=int(r.delta),
            balanceAfter=int(r.balance_after),
            reason=r.reason,
            referenceType=r.reference_type,
            referenceId=r.reference_id,
            createdAt=r.created_at.isoformat(),
        )
        for r in rows
    ]


@router.get("/balance/reconcile", response_model=ReconcileResponse)
async def reconcile(principal: Principal = OrgAdminDep) -> ReconcileResponse:
    """Diagnostic only — reports a mismatch between the materialized balance
    and the ledger sum, never corrects one. org_admin-gated: this reveals
    internal ledger health, not something ordinary members need."""
    async with session() as db:
        result = await ledger.reconcile_balance(db, principal.org_id)
    return ReconcileResponse(
        orgId=result["org_id"],
        storedBalance=result["stored_balance"],
        computedBalance=result["computed_balance"],
        matches=result["matches"],
    )
