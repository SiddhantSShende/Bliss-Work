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
    #: The user's own choice: PINNED | UNPINNED. Independent of the lifecycle —
    #: this list only ever contains OPEN pins, so an UNPINNED row here is an
    #: outstanding commitment whose note the user took off their desktop, and a
    #: client must not float it until the user pins it again.
    pinState: str = "PINNED"
    pinStateUpdatedAt: str | None = None


class PinStateDTO(BaseModel):
    """The authoritative answer to PUT/DELETE /sticky/pins/{task_id}."""

    taskId: str
    #: PINNED | UNPINNED for an open commitment; CLOSED once the task reached a
    #: terminal status (the lifecycle owns that — it is never an Unpin).
    state: str
    pinState: str
    #: OPEN | CLOSED — the lifecycle axis, shown so a client can tell apart
    #: "you unpinned it" from "the task is finished".
    status: str
    updatedAt: str


class UndeliveredPinDTO(BaseModel):
    """An open pin nobody has confirmed receiving — sticky-relay's input."""

    taskId: str
    orgId: str
    assigneeId: str
    openedAt: str
    deliveryAttempts: int
