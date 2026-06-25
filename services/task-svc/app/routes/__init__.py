from __future__ import annotations

from fastapi import APIRouter

from . import tasks_read, tasks_write, transitions

router = APIRouter(prefix="/api/v1")
router.include_router(tasks_write.router)
router.include_router(tasks_read.router)
router.include_router(transitions.router)

__all__ = ["router"]
