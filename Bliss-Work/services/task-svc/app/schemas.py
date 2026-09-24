from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

AssigneeStatus = Literal["SENT", "IGNORED", "ACKNOWLEDGED", "COMPLETED", "LEFT"]
TaskActionT = Literal["ACKNOWLEDGE", "IGNORE", "COMPLETE", "LEAVE"]

# Cap on how many people one task-create request can fan out to. Applied here
# to the client-supplied `assigneeIds` list (pydantic 422s past this), and
# re-applied in routes/tasks_write.py to the server-resolved "assign to whole
# channel" list — that path never passes through this field, so it needs the
# same bound enforced explicitly rather than inheriting it for free. Public
# (no leading underscore): it's imported by tasks_write.py for that reason.
MAX_ASSIGNEES = 500


class RecurrenceSpec(BaseModel):
    startAt: datetime
    frequency: Literal["DAILY", "WEEKLY", "MONTHLY"]
    interval: int = Field(default=1, ge=1, le=365)
    weekdays: list[int] = Field(default_factory=list, max_length=7)
    monthlyRule: Literal["DAY_OF_MONTH", "WEEKDAY_PATTERN"] | None = None
    monthlyDay: int | None = Field(default=None, ge=1, le=31)
    monthlyOrdinal: int | None = Field(default=None, ge=1, le=5)
    monthlyWeekday: int | None = Field(default=None, ge=0, le=6)
    endCondition: Literal["NO_END", "AFTER_OCCURRENCES", "ON_DATE"] = "NO_END"
    endAt: datetime | None = None
    occurrenceCount: int | None = Field(default=None, ge=1, le=100_000)

    @field_validator("startAt", "endAt")
    @classmethod
    def _datetimes_are_aware(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("schedule datetimes must include a timezone")
        return value

    @field_validator("weekdays")
    @classmethod
    def _weekdays_are_valid(cls, value: list[int]) -> list[int]:
        if len(set(value)) != len(value) or any(day < 0 or day > 6 for day in value):
            raise ValueError("weekdays must contain unique values from 0 through 6")
        return value

    @model_validator(mode="after")
    def _validate_recurrence(self) -> "RecurrenceSpec":
        if self.startAt <= datetime.now(timezone.utc):
            raise ValueError("recurring task startAt must be in the future")
        if self.frequency == "WEEKLY" and not self.weekdays:
            raise ValueError("weekly recurrence requires at least one weekday")
        if self.frequency != "WEEKLY" and self.weekdays:
            raise ValueError("weekdays are only valid for weekly recurrence")
        if self.frequency == "MONTHLY":
            if self.monthlyRule == "DAY_OF_MONTH" and self.monthlyDay is None:
                raise ValueError("monthly day-of-month rule requires monthlyDay")
            if self.monthlyRule == "WEEKDAY_PATTERN" and (
                self.monthlyOrdinal is None or self.monthlyWeekday is None
            ):
                raise ValueError("monthly weekday rule requires ordinal and weekday")
            if self.monthlyRule is None:
                raise ValueError("monthly recurrence requires a recurrence rule")
        elif any(value is not None for value in (self.monthlyRule, self.monthlyDay, self.monthlyOrdinal, self.monthlyWeekday)):
            raise ValueError("monthly recurrence fields are only valid for monthly recurrence")
        if self.endCondition == "AFTER_OCCURRENCES" and self.occurrenceCount is None:
            raise ValueError("occurrenceCount is required")
        if self.endCondition == "ON_DATE":
            if self.endAt is None:
                raise ValueError("endAt is required")
            if self.endAt <= self.startAt:
                raise ValueError("endAt must be after startAt")
        elif self.endAt is not None or self.occurrenceCount is not None:
            raise ValueError("endAt and occurrenceCount must match endCondition")
        return self


# Upper bounds on every free-text / list field. Without them a client can submit
# multi-MB strings or huge id lists — storage bloat, expensive at-rest encryption,
# and a cheap DoS (e.g. fanning a task to an unbounded assignee list). Mirrors the
# bounds discipline already in auth-svc/app/schemas.py. UUID-shaped fields are
# validated as UUIDs so a malformed id is a clean 422 at the edge rather than a
# deeper failure when it reaches a SQL binding or the messaging-svc fan-out.
class CreateTaskRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=10_000)
    assigneeIds: list[str] = Field(default_factory=list, max_length=MAX_ASSIGNEES)
    # When set, task-svc resolves the channel's current members via
    # messaging-svc's internal endpoint and fans out at server side. The
    # task is tagged with channel_id so future joiners can be auto-added
    # via the ChannelMemberJoined event consumer.
    channelId: str | None = None
    allocation: Literal["NOW", "SCHEDULED", "RECURRING"] = "NOW"
    scheduledFor: datetime | None = None
    recurrence: RecurrenceSpec | None = None

    @field_validator("scheduledFor")
    @classmethod
    def _scheduled_for_is_aware(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("scheduledFor must include a timezone")
        return value

    @model_validator(mode="after")
    def _validate_allocation(self) -> "CreateTaskRequest":
        if self.allocation == "NOW":
            if self.scheduledFor is not None or self.recurrence is not None:
                raise ValueError("scheduledFor and recurrence require deferred allocation")
        elif self.allocation == "SCHEDULED":
            if self.scheduledFor is None:
                raise ValueError("scheduledFor is required")
            if self.scheduledFor <= datetime.now(timezone.utc):
                raise ValueError("scheduledFor must be in the future")
            if self.recurrence is not None:
                raise ValueError("recurrence is only valid for recurring allocation")
        elif self.recurrence is None:
            raise ValueError("recurrence is required")
        if self.allocation == "RECURRING" and self.scheduledFor is not None:
            raise ValueError("scheduledFor is only valid for scheduled allocation")
        return self

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
    scheduleId: str | None = None


class ScheduledAssignee(BaseModel):
    userId: str
    username: str


class ScheduledTaskDTO(BaseModel):
    scheduleId: str
    title: str
    description: str
    channelId: str | None = None
    kind: Literal["SCHEDULED", "RECURRING"]
    scheduledFor: str | None = None
    startAt: str
    nextRunAt: str
    frequency: str | None = None
    interval: int | None = None
    weekdays: list[int] = []
    monthlyRule: str | None = None
    monthlyDay: int | None = None
    monthlyOrdinal: int | None = None
    monthlyWeekday: int | None = None
    endCondition: str
    endAt: str | None = None
    occurrenceLimit: int | None = None
    occurrenceCount: int
    assignees: list[ScheduledAssignee]


class UpdateScheduleRequest(BaseModel):
    nextRunAt: datetime

    @field_validator("nextRunAt")
    @classmethod
    def _next_run_is_aware_and_future(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("nextRunAt must include a timezone")
        if value <= datetime.now(timezone.utc):
            raise ValueError("nextRunAt must be in the future")
        return value


class AddTaskAssigneesRequest(BaseModel):
    userIds: list[str] = Field(min_length=1, max_length=MAX_ASSIGNEES)

    @field_validator("userIds")
    @classmethod
    def _user_ids_are_uuids(cls, v: list[str]) -> list[str]:
        for user_id in v:
            try:
                uuid.UUID(user_id)
            except (ValueError, AttributeError) as exc:
                raise ValueError("userIds must all be valid UUIDs") from exc
        return list(dict.fromkeys(v))


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
    participants: list[dict]


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
    participants: list[dict]


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
