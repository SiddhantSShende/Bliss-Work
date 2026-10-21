"""Synchronous calls to billing-svc's internal credit-commitment endpoints.

Called BEFORE opening this service's own DB transaction (invites.py /
members.py route handlers) — never from inside one — so the Postgres locks
those transactions take (the invite's `FOR UPDATE`, `_lock_org_admins`) are
never held across this network call. billing-svc does its own short,
row-locked transaction on the other end; see
services/billing-svc/app/membership_commitment.py.

If billing_internal_base is unset, every function here is a no-op that
allows the change — see config.py's note on why this stays optional.
"""
from __future__ import annotations

from datetime import datetime

import httpx
from fastapi import HTTPException, status

from .config import settings
from .logging_config import log

_TIMEOUT = httpx.Timeout(5.0, connect=2.0)


async def init_org_billing(org_id: str, created_at: datetime) -> None:
    """Hand billing-svc the org's creation time so it can anchor monthly
    renewals to it (billing-svc has no FK access to `orgs`). Called once,
    right after an org is created, outside any transaction — best-effort
    like release_membership_commitment: a lost call only means the org's
    renewal anchor is missing until retried, never a half-applied org."""
    if not settings.billing_internal_base:
        return
    url = f"{settings.billing_internal_base}/internal/v1/billing/orgs/{org_id}/init"
    headers = {"X-Internal-Token": settings.billing_internal_token}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            await client.put(url, headers=headers, json={"createdAt": created_at.isoformat()})
        except httpx.HTTPError as exc:
            log.warning("billing_org_init_failed", org_id=org_id, error=str(exc))


async def check_and_reserve_membership(org_id: str, user_id: str, role: str) -> None:
    """Ask billing-svc whether `org_id` can afford adding/changing `user_id` to
    `role`'s monthly cost, and if so have it record that as the org's
    projected next-renewal commitment. Raises HTTPException (402/503/502) if
    the change should NOT proceed; returns None if it may.
    """
    if not settings.billing_internal_base:
        return
    url = f"{settings.billing_internal_base}/internal/v1/billing/orgs/{org_id}/memberships/{user_id}"
    headers = {"X-Internal-Token": settings.billing_internal_token}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            resp = await client.post(url, headers=headers, json={"role": role})
        except httpx.HTTPError as exc:
            log.warning("billing_commitment_check_failed", org_id=org_id, error=str(exc))
            raise HTTPException(
                status.HTTP_503_SERVICE_UNAVAILABLE, "billing service unreachable"
            ) from exc
    if resp.status_code == 402:
        raise HTTPException(
            status.HTTP_402_PAYMENT_REQUIRED,
            "this organization does not have enough credits for this change",
        )
    if resp.status_code != 200:
        log.warning("billing_commitment_check_unexpected_status", org_id=org_id, status=resp.status_code)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "billing service error")


async def release_membership_commitment(org_id: str, user_id: str) -> None:
    """Zero out `user_id`'s projected commitment for `org_id` — used both for
    an actual removal and as compensation when a commitment check succeeded
    but the membership/role change it was gating then failed to apply.
    Best-effort: logged, never raised, since a stuck reservation only
    OVER-counts a future affordability check (fails safe, not open)."""
    if not settings.billing_internal_base:
        return
    url = f"{settings.billing_internal_base}/internal/v1/billing/orgs/{org_id}/memberships/{user_id}"
    headers = {"X-Internal-Token": settings.billing_internal_token}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            await client.delete(url, headers=headers)
        except httpx.HTTPError as exc:
            log.warning("billing_release_failed", org_id=org_id, user_id=user_id, error=str(exc))
