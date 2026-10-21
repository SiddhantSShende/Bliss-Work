from __future__ import annotations

from fastapi import APIRouter

from . import balance, cashfree_webhook, internal, packages, pricing, purchases

router = APIRouter(prefix="/api/v1/billing")
router.include_router(balance.router)
router.include_router(packages.router)
router.include_router(pricing.router)
router.include_router(purchases.router)

# Cashfree's webhook caller can't send a bearer token, and shouldn't be
# nested under /api/v1/billing's implied "authenticated API" shape — kept as
# its own router at a distinct, stable path, same separation rationale as
# internal_router below.
cashfree_webhook_router = cashfree_webhook.router

# Not nested under /api/v1/billing: internal.py's own prefix
# (/internal/v1/billing) marks it as service-to-service, X-Internal-Token
# auth, never JWT/principal auth — kept as a separate router so the two
# auth models are never accidentally merged under one prefix.
internal_router = internal.router

__all__ = ["router", "internal_router", "cashfree_webhook_router"]
