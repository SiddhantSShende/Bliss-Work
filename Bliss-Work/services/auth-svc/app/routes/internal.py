"""Internal service-to-service endpoints — no JWT, shared-secret auth.

Mirrors the messaging-svc internal pattern (X-Internal-Token / TB_INTERNAL_TOKEN).
auth-svc owns identity, so other services resolve a user's e-mail / username by
ASKING auth-svc here rather than reaching into authdb. Used by email-worker's
offline relay. NOT mounted under the public CORS/JWT surface.
"""
from __future__ import annotations

import os
import secrets

from fastapi import APIRouter, Header, HTTPException, status

from .. import service
from ..crypto import cryptor
from ..db import engine
from ..schemas import UserDTO

router = APIRouter(prefix="/internal", tags=["internal"])

_INTERNAL_TOKEN = os.getenv("TB_INTERNAL_TOKEN", "")


@router.get("/users/{user_id}", response_model=UserDTO)
async def internal_get_user(
    user_id: str,
    x_internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> UserDTO:
    # Fail CLOSED: if the shared secret is not configured the endpoint must reject
    # everything, not (as before) accept any caller. Constant-time compare avoids
    # leaking the token via response timing.
    if not _INTERNAL_TOKEN or not secrets.compare_digest(x_internal_token, _INTERNAL_TOKEN):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad internal token")
    async with engine.connect() as conn:
        # Trusted service-to-service lookup by user_id with no org context (the
        # caller doesn't know the user's org). user_dto reads users + org_keys
        # (RLS), so this cross-org trusted path runs under bypass.
        await service.set_bypass_rls(conn)
        dto = await service.user_dto(conn, user_id)
    if dto is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
    return dto


@router.get("/audit/verify/{org_id}")
async def verify_audit_chain(
    org_id: str,
    x_internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> dict:
    """Tamper-evidence check: re-walk an org's audit hash chain. Returns
    {ok, count, broken_at, reason}. For ops / incident response."""
    if not _INTERNAL_TOKEN or not secrets.compare_digest(x_internal_token, _INTERNAL_TOKEN):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad internal token")
    async with engine.connect() as conn:
        await service.set_org_guc(conn, org_id)
        return await service.verify_audit_chain(conn, org_id)


@router.post("/keys/rotate/{org_id}")
async def rotate_org_dek(
    org_id: str,
    x_internal_token: str = Header(default="", alias="X-Internal-Token"),
) -> dict:
    """Rotate an org's Data Encryption Key (authdb). New writes use the new
    generation; existing ciphertext stays readable via its embedded key_version
    (lazy rotation). Repeat per service DB to fully rotate an org."""
    if not _INTERNAL_TOKEN or not secrets.compare_digest(x_internal_token, _INTERNAL_TOKEN):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad internal token")
    async with engine.begin() as conn:
        await service.set_org_guc(conn, org_id)  # org_keys is RLS-protected
        old_version, new_version = await cryptor().rotate_dek(conn, org_id)
    return {"orgId": org_id, "oldVersion": old_version, "newVersion": new_version}
