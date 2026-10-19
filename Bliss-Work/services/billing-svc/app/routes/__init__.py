from __future__ import annotations

from fastapi import APIRouter

from . import balance, internal, packages, pricing

router = APIRouter(prefix="/api/v1/billing")
router.include_router(balance.router)
router.include_router(packages.router)
router.include_router(pricing.router)

# Not nested under /api/v1/billing: internal.py's own prefix
# (/internal/v1/billing) marks it as service-to-service, X-Internal-Token
# auth, never JWT/principal auth — kept as a separate router so the two
# auth models are never accidentally merged under one prefix.
internal_router = internal.router

__all__ = ["router", "internal_router"]
