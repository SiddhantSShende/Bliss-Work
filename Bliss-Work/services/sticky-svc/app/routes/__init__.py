from fastapi import APIRouter

from .internal import router as internal_router
from .pins import router as pins_router

router = APIRouter(prefix="/api/v1")
router.include_router(pins_router)

# Mounted OUTSIDE /api/v1: these routes are authenticated by a shared secret,
# not by a user's bearer token, and keeping them off the public prefix makes
# that difference visible in the edge config as well as in the code.
internal = APIRouter()
internal.include_router(internal_router)
