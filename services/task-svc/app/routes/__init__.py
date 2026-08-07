from __future__ import annotations

from fastapi import APIRouter

from . import availability, reviews, tasks_export, tasks_read, tasks_write, transitions

router = APIRouter(prefix="/api/v1")
router.include_router(tasks_write.router)
router.include_router(tasks_read.router)
router.include_router(transitions.router)
router.include_router(reviews.router)
router.include_router(tasks_export.router)
router.include_router(availability.router)

__all__ = ["router"]
