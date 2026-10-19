"""Platform-operator authorization: the `platform_operators` table, not any
JWT role claim. Operators manage global pricing/packages platform-wide; this
is deliberately independent of org_admin, which is an org-scoped role minted
per-org by auth-svc and says nothing about platform-operator status.
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, status
from sqlalchemy import text

from .auth import Principal, PrincipalDep
from .db import session


async def is_platform_operator(user_id: str) -> bool:
    async with session() as db:
        row = (
            await db.execute(
                text("SELECT 1 FROM platform_operators WHERE user_id = :uid"),
                {"uid": user_id},
            )
        ).first()
    return row is not None


async def require_platform_operator(principal: Principal = PrincipalDep) -> Principal:
    if not await is_platform_operator(principal.user_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="platform operator role required"
        )
    return principal


PlatformOperatorDep = Depends(require_platform_operator)
