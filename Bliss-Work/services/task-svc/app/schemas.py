from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field, field_validator

AssigneeStatus = Literal["SENT", "IGNORED", "ACKNOWLEDGED", "COMPLETED", "LEFT"]
TaskActionT = Literal["ACKNOWLEDGE", "IGNORE", "COMPLETE", "LEAVE"]


# Upper bounds on every free-text / list field. Without them a client can submit
# multi-MB strings or huge id lists — storage bloat, expensive at-rest encryption,
# and a cheap DoS (e.g. fanning a task to an unbounded assignee list). Mirrors the
# bounds discipline already in auth-svc/app/schemas.py. UUID-shaped fields are
# validated as UUIDs so a malformed id is a clean 422 at the edge rather than a
# deeper failure when it reaches a SQL binding or the messaging-svc fan-out.
class CreateTaskRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=10_000)
    assigneeIds: list[str] = Field(default_factory=list, max_length=500)
    # When set, task-svc resolves the channel's current members via
    # messaging-svc's internal endpoint and fans out at server side. The
    # task is tagged with channel_id so future joiners can be auto-added
    # via the ChannelMemberJoined event consumer.
    channelId: str | None = None

    @field_validator("channelId")
    @classmethod
    def _channel_id_is_uuid(cls, v: str | None) -> str | None:
        if v is None:
            return v
        try:
            uuid.UUID(v)
        except (ValueError, AttributeError) as exc:
            raise ValueError("channelId must be a valid UUID") from exc
        return v

    @field_validator("assigneeIds")
    @classmethod
    def _assignee_ids_are_uuids(cls, v: list[str]) -> list[str]:
        for a in v:
            try:
                uuid.UUID(a)
            except (ValueError, AttributeError) as exc:
                raise ValueError("assigneeIds must all be valid UUIDs") from exc
        return v


class CreateTaskResponse(BaseModel):
    taskId: str


class StickyTaskDTO(BaseModel):
    taskId: str
    orgId: str
    title: str
    description: str
    senderId: str
    senderUsername: str
    # The allocator's real name. `senderUsername` is the email local-part
    # (auth-svc derives it at signup), so a task note rendered from it alone
    # reads "from j.okafor". Empty until the projection catches up; clients fall
    # back to senderUsername.
    senderDisplayName: str = ""
    myStatus: AssigneeStatus
    actions: list[TaskActionT]
    statusVersion: int
    assignedAt: str
    acknowledgedAt: str | None = None
    # Full per-assignment timeline + the review the assignee received (all
    # nullable — a milestone is only set once that transition happens).
    completedAt: str | None = None
    ignoredAt: str | None = None
    leftAt: str | None = None
    reviewedAt: str | None = None
    review: str | None = None
    reviewRating: int | None = None


class SentAssignee(BaseModel):
    assigneeId: str
    assigneeUsername: str
    status: AssigneeStatus
    # Timeline milestones for this assignment (nullable until they occur) +
    # the review the sender left (decrypted). Powers the sender-side timeline
    # and "Write review" UI without a second round-trip.
    assignedAt: str | None = None
    acknowledgedAt: str | None = None
    completedAt: str | None = None
    ignoredAt: str | None = None
    leftAt: str | None = None
    reviewedAt: str | None = None
    review: str | None = None
    reviewRating: int | None = None


class SentTaskDTO(BaseModel):
    taskId: str
    title: str
    description: str
    createdAt: str
    assignees: list[SentAssignee]


class TransitionResponse(BaseModel):
    status: AssigneeStatus
    statusVersion: int


# ── Reviews (allocator → completed assignee) ──────────────────────────────────
class ReviewRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4_000)
    rating: int | None = Field(default=None, ge=1, le=5)


class ReviewResponse(BaseModel):
    reviewedAt: str
    review: str
    reviewRating: int | None = None


# ── Export (one row per (task, assignee)) ─────────────────────────────────────
class TaskExportRow(BaseModel):
    taskId: str
    title: str
    description: str
    allocatedById: str
    allocatedByUsername: str
    allocatedToId: str
    allocatedToUsername: str
    status: AssigneeStatus
    allocatedAt: str
    acknowledgedAt: str | None = None
    ignoredAt: str | None = None
    completedAt: str | None = None
    leftAt: str | None = None
    # Whole-turnaround seconds (completed_at − assigned_at); None unless completed.
    timeTakenSeconds: int | None = None
    reviewedAt: str | None = None
    review: str | None = None
    reviewRating: int | None = None


# ── Availability roster ───────────────────────────────────────────────────────
# Counts only: the authoritative member list lives in auth-svc (/auth/directory),
# and this service's user_projection is a partial `user.created`-only mirror. The
# client joins these counts onto the directory it already caches and treats a
# user absent from `counts` as 0/0 — so a new hire with no task history is
# available immediately.
class AvailabilityCount(BaseModel):
    userId: str
    # >0 ⇒ NOT available. An unacknowledged allocation is not committed work, so
    # only ACKNOWLEDGED consumes availability.
    acknowledged: int
    # SENT rows — surfaced as the "n pending, unacked" hint, never a blocker.
    pending: int


class AvailabilityDTO(BaseModel):
    counts: list[AvailabilityCount]
    # Users an org admin removed from the roster. An ORGANIZATIONAL filter, not
    # an access control — these ids are already public via the directory, and the
    # roster is assembled client-side so the set has to ship to every member.
    hiddenUserIds: list[str]
    # Caller holds org_admin → the client renders the hide / unhide affordances.
    canManage: bool


class HideUserRequest(BaseModel):
    userId: str

    @field_validator("userId")
    @classmethod
    def _user_id_is_uuid(cls, v: str) -> str:
        try:
            uuid.UUID(v)
        except (ValueError, AttributeError) as exc:
            raise ValueError("userId must be a valid UUID") from exc
        return v


def actions_for(status: str) -> list[TaskActionT]:
    if status == "SENT":
        return ["ACKNOWLEDGE", "IGNORE"]
    if status == "ACKNOWLEDGED":
        return ["COMPLETE", "LEAVE"]
    return []
