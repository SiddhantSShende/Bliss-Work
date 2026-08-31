from fastapi import APIRouter

from . import app_creds, integrations

# Versioned aggregate router. Public routers (oauth) are NOT here — main.py
# mounts those under /ext with no JWT.
router = APIRouter(prefix="/api/v1")
# app_creds FIRST: its paths are /integrations/app-credentials{,/{vendor}}, and
# integrations.py declares DELETE /integrations/{conn_id}, which would otherwise
# swallow DELETE /integrations/app-credentials as a connection id. FastAPI
# matches in registration order.
router.include_router(app_creds.router)
router.include_router(integrations.router)
