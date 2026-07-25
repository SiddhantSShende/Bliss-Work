from fastapi import APIRouter

from . import integrations

# Versioned aggregate router. New feature routers (webhooks, activity hub) are
# included here as the provider layer lands.
router = APIRouter(prefix="/api/v1")
router.include_router(integrations.router)
