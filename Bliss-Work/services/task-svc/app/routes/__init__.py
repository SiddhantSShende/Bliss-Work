from __future__ import annotations

from fastapi import APIRouter

from . import availability, participants, reassign, reviews, schedules, tasks_export, tasks_read, tasks_write, transitions

router = APIRouter(prefix="/api/v1")
router.include_router(tasks_write.router)
router.include_router(participants.router)
router.include_router(reassign.router)
router.include_router(tasks_read.router)
router.include_router(transitions.router)
router.include_router(reviews.router)
router.include_router(tasks_export.router)
router.include_router(availability.router)
router.include_router(schedules.router)

__all__ = ["router"]
