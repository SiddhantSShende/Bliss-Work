"""Service-to-service endpoints — auth-svc only, validated by X-Internal-Token
(see services/shared/internal_auth). Never principal/JWT-authenticated: there
is no end-user request here, only auth-svc acting on a membership change it
is about to make.
"""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, status
from internal_auth import internal_token_matches
from pydantic import BaseModel

from .. import membership_commitment
from ..config import settings
from ..db import session

router = APIRouter(prefix="/internal/v1/billing")


def _require_internal(token: str | None) -> None:
    if not internal_token_matches(token, settings.internal_token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid internal token")


class MembershipCommitmentRequest(BaseModel):
    role: str


@router.post("/orgs/{org_id}/memberships/{user_id}")
async def set_membership_commitment(
    org_id: str,
    user_id: str,
    body: MembershipCommitmentRequest,
    x_internal_token: str | None = Header(default=None),
):
    _require_internal(x_internal_token)
    async with session() as db:
        try:
            ok, projected_total, balance = await membership_commitment.apply_membership_commitment(
                db, org_id, user_id, body.role
            )
        except membership_commitment.UnknownRoleError:
            await db.rollback()
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unknown role: {body.role}")
        if not ok:
            await db.rollback()
            raise HTTPException(
                status.HTTP_402_PAYMENT_REQUIRED,
                f"org requires {projected_total} credits/month, has {balance}",
            )
        await db.commit()
    return {"ok": True, "projectedTotal": projected_total, "balance": balance}


@router.delete("/orgs/{org_id}/memberships/{user_id}")
async def release_membership_commitment(
    org_id: str,
    user_id: str,
    x_internal_token: str | None = Header(default=None),
):
    _require_internal(x_internal_token)
    async with session() as db:
        await membership_commitment.release_membership_commitment(db, org_id, user_id)
        await db.commit()
    return {"ok": True}
