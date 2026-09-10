"""Wire contracts for sticky-svc.

Deliberately small. This service answers one question — "which task notes belong
on this person's desktop?" — and returns ids and lifecycle, never task content.
Titles and descriptions are encrypted at rest in task-svc under a per-org DEK;
clients join these ids against GET /api/v1/tasks/sticky for the text.
"""

from __future__ import annotations

from pydantic import BaseModel


class StickyPinDTO(BaseModel):
    """One open commitment, as the client needs to see it."""

    taskId: str
    orgId: str
    assigneeId: str
    senderId: str | None = None
    #: SENT | ACKNOWLEDGED — lets a client render the note's buttons without a
    #: second call, and stays a mirror of task-svc rather than an authority.
    assigneeStatus: str
    statusVersion: int
    openedAt: str
    #: NULL until a client confirms the note actually reached a screen.
    lastDeliveredAt: str | None = None


class UndeliveredPinDTO(BaseModel):
    """An open pin nobody has confirmed receiving — sticky-relay's input."""

    taskId: str
    orgId: str
    assigneeId: str
    openedAt: str
    deliveryAttempts: int
