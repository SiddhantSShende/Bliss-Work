from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from datetime import time as time_of_day_t
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field, field_validator, model_validator

AssigneeStatus = Literal["SENT", "IGNORED", "ACKNOWLEDGED", "COMPLETED", "LEFT", "MISSED"]
TaskActionT = Literal["ACKNOWLEDGE", "IGNORE", "COMPLETE", "LEAVE"]

# Cap on how many people one task-create request can fan out to. Applied here
# to the client-supplied `assigneeIds` list (pydantic 422s past this), and
# re-applied in routes/tasks_write.py to the server-resolved "assign to whole
# channel" list — that path never passes through this field, so it needs the
# same bound enforced explicitly rather than inheriting it for free. Public
# (no leading underscore): it's imported by tasks_write.py for that reason.
MAX_ASSIGNEES = 500
# Channels one task may be allocated to. Each is resolved against messaging-svc at
# creation (and again at every scheduled occurrence), so this bounds that fan-out.
MAX_CHANNELS_PER_TASK = 20


# Longest "N after each occurrence" a recurring deadline may be, in minutes. A
# deadline a year out is a plausible annual review; beyond that it is a typo.
MAX_RELATIVE_DEADLINE_MINUTES = 366 * 24 * 60
_UNIT_MINUTES = {"MINUTES": 1, "HOURS": 60, "DAYS": 24 * 60}
_TIME_OF_DAY = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


class DeadlineRuleSpec(BaseModel):
    """How a recurring series derives the deadline of each occurrence.

    A series has no single deadline — every occurrence needs its own — so the
    series stores this RULE and task-svc resolves it against each occurrence's own
    time (app/deadlines.py). Also the shape the rule is read back in.

      RELATIVE    `amount` `unit` after the occurrence. MINUTES and HOURS are
                  elapsed time; DAYS are calendar days on the wall clock of
                  `timeZone` (so "1 day after Monday 10:00" is Tuesday 10:00 even
                  across a DST change).
      FIXED_TIME  `time` ("HH:MM") on the occurrence's own date, in `timeZone`.
    """

    kind: Literal["RELATIVE", "FIXED_TIME"]
    amount: int | None = Field(default=None, ge=1, le=MAX_RELATIVE_DEADLINE_MINUTES)
    unit: Literal["MINUTES", "HOURS", "DAYS"] | None = None
    time: str | None = None
    # IANA zone the rule is read in (e.g. "America/New_York"), sent by the client
    # because an offset alone cannot say what a wall-clock time means after a DST
    # change.
    timeZone: str = Field(min_length=1, max_length=64)

    @field_validator("timeZone")
    @classmethod
    def _time_zone_is_known(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError, OSError) as exc:
            raise ValueError("timeZone must be a valid IANA time zone") from exc
        return value

    @model_validator(mode="after")
    def _validate_rule(self) -> "DeadlineRuleSpec":
        if self.kind == "RELATIVE":
            if self.amount is None or self.unit is None:
                raise ValueError("a relative deadline requires amount and unit")
            if self.time is not None:
                raise ValueError("time is only valid for a fixed-time deadline")
            if self.amount * _UNIT_MINUTES[self.unit] > MAX_RELATIVE_DEADLINE_MINUTES:
                raise ValueError("a relative deadline may be at most 366 days")
        else:
            if self.time is None or not _TIME_OF_DAY.match(self.time):
                raise ValueError("a fixed-time deadline requires time as HH:MM")
            if self.amount is not None or self.unit is not None:
                raise ValueError("amount and unit are only valid for a relative deadline")
        return self

    def time_of_day(self) -> time_of_day_t:
        hour, minute = (int(part) for part in (self.time or "00:00").split(":"))
        return time_of_day_t(hour, minute)


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
    # Absent = no deadline, exactly as before this field existed.
    deadline: DeadlineRuleSpec | None = None

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
        if self.deadline is not None and self.deadline.kind == "FIXED_TIME":
            # Every occurrence happens at the start's time of day, so a fixed time
            # that is not later than it would put each deadline at or before its
            # own occurrence — every task born already missed.
            start_local = self.startAt.astimezone(ZoneInfo(self.deadline.timeZone)).time()
            if self.deadline.time_of_day() <= start_local.replace(second=0, microsecond=0):
                raise ValueError("a fixed deadline time must be later than the recurrence's start time")
        return self


# Upper bounds on every free-text / list field. Without them a client can submit
# multi-MB strings or huge id lists — storage bloat, expensive at-rest encryption,
# and a cheap DoS (e.g. fanning a task to an unbounded assignee list). Mirrors the
# bounds discipline already in auth-svc/app/schemas.py. UUID-shaped fields are
# validated as UUIDs so a malformed id is a clean 422 at the edge rather than a
# deeper failure when it reaches a SQL binding or the messaging-svc fan-out.
class CreateTaskRequest(BaseModel):
    # The task's own identity — what every task list, card, chat header,
    # notification and export shows as its heading. Kept separate from `title`
    # below, which (despite the name) is actually the PROJECT this task is
    # filed under: it is looked up/created via resolve_or_create_project and
    # never stored as the task's title. Renaming `title` would ripple through
    # every existing caller and test that already treats it as the project
    # name, so it is left as-is and the real task title is this new field.
    taskTitle: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=10_000)
    assigneeIds: list[str] = Field(default_factory=list, max_length=MAX_ASSIGNEES)
    # Channels the task is allocated to, alongside `assigneeIds` (either, or both).
    # task-svc resolves each channel's current members via messaging-svc's
    # internal endpoint and fans out server-side; the task stays tagged with its
    # channels (task_channels) so future joiners are auto-added via the
    # ChannelMemberJoined consumer. Everyone — named or via a channel — ends up
    # as ONE task_assignees row, so overlap never duplicates a recipient.
    #
    # `channelId` is the original single-channel field and is still accepted;
    # it is simply one more entry of `channelIds`.
    channelId: str | None = None
    channelIds: list[str] = Field(default_factory=list, max_length=MAX_CHANNELS_PER_TASK)
    allocation: Literal["NOW", "SCHEDULED", "RECURRING"] = "NOW"
    scheduledFor: datetime | None = None
    recurrence: RecurrenceSpec | None = None
    # One concrete deadline, for an immediate or one-off scheduled task. A
    # recurring series carries a RULE instead (`recurrence.deadline`).
    deadlineAt: datetime | None = None

    @field_validator("scheduledFor", "deadlineAt")
    @classmethod
    def _scheduled_for_is_aware(cls, value: datetime | None) -> datetime | None:
        if value is not None and value.tzinfo is None:
            raise ValueError("datetimes must include a timezone")
        return value

    @field_validator("taskTitle")
    @classmethod
    def _task_title_is_not_blank(cls, value: str) -> str:
        # min_length=1 alone would accept a whitespace-only string (len > 0 but
        # nothing to show as the task's heading), so trim here and reject what
        # that leaves empty — the client is expected to trim too, but the
        # server is the boundary that actually enforces it.
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("taskTitle must not be empty or whitespace-only")
        return trimmed

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
        if self.deadlineAt is not None:
            if self.allocation == "RECURRING":
                raise ValueError("a recurring task takes a deadline rule (recurrence.deadline), not deadlineAt")
            # The deadline must be after the moment the task actually lands.
            starts_at = self.scheduledFor if self.allocation == "SCHEDULED" else datetime.now(timezone.utc)
            if self.deadlineAt <= starts_at:
                raise ValueError("deadlineAt must be in the future and after the task is allocated")
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

    @field_validator("channelIds")
    @classmethod
    def _channel_ids_are_uuids(cls, v: list[str]) -> list[str]:
        for c in v:
            try:
                uuid.UUID(c)
            except (ValueError, AttributeError) as exc:
                raise ValueError("channelIds must all be valid UUIDs") from exc
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

    def target_channel_ids(self) -> list[str]:
        """Every channel named, once each, in the order given (`channelId` first).
        Compared as canonical UUIDs: the same channel in two spellings is one."""
        return list(dict.fromkeys(
            str(uuid.UUID(c)) for c in ([self.channelId] if self.channelId else []) + self.channelIds
        ))


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
    projectId: str | None = None
    # First channel only, kept for existing readers; `channelIds` is the full list.
    channelId: str | None = None
    channelIds: list[str] = []
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
    # SCHEDULED: the one absolute deadline. RECURRING: the rule each occurrence's
    # deadline is resolved from. Both null when the task has no deadline.
    deadlineAt: str | None = None
    deadlineRule: DeadlineRuleSpec | None = None


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
    """People and/or channels to add to an existing task — the same two target
    kinds `CreateTaskRequest` takes. A channel's current members join the task and
    the channel is attached (task_channels), so later joiners are added too."""

    userIds: list[str] = Field(default_factory=list, max_length=MAX_ASSIGNEES)
    channelIds: list[str] = Field(default_factory=list, max_length=MAX_CHANNELS_PER_TASK)

    @field_validator("userIds")
    @classmethod
    def _user_ids_are_uuids(cls, v: list[str]) -> list[str]:
        for user_id in v:
            try:
                uuid.UUID(user_id)
            except (ValueError, AttributeError) as exc:
                raise ValueError("userIds must all be valid UUIDs") from exc
        return list(dict.fromkeys(v))

    @field_validator("channelIds")
    @classmethod
    def _channel_ids_are_uuids(cls, v: list[str]) -> list[str]:
        try:
            return list(dict.fromkeys(str(uuid.UUID(c)) for c in v))
        except (ValueError, AttributeError) as exc:
            raise ValueError("channelIds must all be valid UUIDs") from exc


class StickyTaskDTO(BaseModel):
    taskId: str
    orgId: str
    title: str
    description: str
    projectId: str | None = None
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
    # When this task is due (null = no deadline) and, once the deadline passed
    # before it was done, when it became MISSED. `assignedAt` above is the other
    # half of the pair a card shows.
    deadlineAt: str | None = None
    missedAt: str | None = None
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
    missedAt: str | None = None


class SentTaskDTO(BaseModel):
    taskId: str
    title: str
    description: str
    createdAt: str
    projectId: str | None = None
    deadlineAt: str | None = None
    assignees: list[SentAssignee]
    participants: list[dict]


ProjectStatus = Literal["ACTIVE", "COMPLETED"]


class ProjectDTO(BaseModel):
    id: str
    name: str
    channelId: str
    status: ProjectStatus
    # Caller is this project's creator or an org_admin → the client renders
    # the Complete Project button. The server re-checks regardless (see
    # routes/projects_write.py) — this only decides what to OFFER.
    canComplete: bool


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
    deadlineAt: str | None = None
    missedAt: str | None = None


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


# ── Analytics (snapshot-only; no history table, no trend-over-time) ───────────
#
# There is no whole-task/aggregate status anywhere in this schema — only the
# per-assignee `task_assignees.status`. Two completion measures are reported,
# always separately, NEVER conflated into one "completion rate":
#
#   assignmentCompletionRate  COMPLETED rows / ALL rows in scope. The raw rate
#                             across every assignment, including a task with
#                             five assignees where only one finished.
#   uniqueTaskCompletionRate  A TASK counts complete when every one of its
#                             assignee rows that is NOT LEFT and NOT IGNORED is
#                             COMPLETED. A task where every assignee left or
#                             ignored it (zero remaining rows) is reported
#                             separately as "abandoned" — neither complete nor
#                             incomplete.
class StatusBreakdownDTO(BaseModel):
    sent: int = 0
    acknowledged: int = 0
    completed: int = 0
    ignored: int = 0
    left: int = 0
    missed: int = 0


class CompletionMetricsDTO(BaseModel):
    totalAssignments: int
    completedAssignments: int
    assignmentCompletionRate: float  # 0..100; 0 when totalAssignments == 0

    totalUniqueTasks: int
    completedUniqueTasks: int
    abandonedUniqueTasks: int
    remainingUniqueTasks: int
    uniqueTaskCompletionRate: float  # 0..100; 0 when totalUniqueTasks == 0


class TaskAnalyticsAssigneeDTO(BaseModel):
    assigneeId: str
    assigneeUsername: str
    status: AssigneeStatus
    assignedAt: str | None = None
    acknowledgedAt: str | None = None
    completedAt: str | None = None
    ignoredAt: str | None = None
    leftAt: str | None = None
    missedAt: str | None = None
    # completedAt - assignedAt, in seconds. Null unless this assignee is COMPLETED.
    turnaroundSeconds: float | None = None


class TaskAnalyticsDTO(BaseModel):
    taskId: str
    title: str
    senderId: str
    assignees: list[TaskAnalyticsAssigneeDTO]
    statusBreakdown: StatusBreakdownDTO
    completion: CompletionMetricsDTO


class AssigneeWorkloadDTO(BaseModel):
    assigneeId: str
    assigneeUsername: str
    assignedCount: int
    completedCount: int
    completionRate: float  # 0..100; 0 when assignedCount == 0


class ChannelAnalyticsDTO(BaseModel):
    channelId: str
    statusBreakdown: StatusBreakdownDTO
    completion: CompletionMetricsDTO
    workload: list[AssigneeWorkloadDTO]


class ProjectTaskAssigneeDTO(BaseModel):
    assigneeId: str
    assigneeUsername: str
    status: AssigneeStatus
    assignedAt: str | None = None


# Per-task status in a project's breakdown list — the same completed/abandoned/
# remaining rule the completion metrics above are built from (see the module
# docstring), surfaced per task instead of only in aggregate.
ProjectTaskStatus = Literal["COMPLETED", "ABANDONED", "IN_PROGRESS"]


class ProjectTaskSummaryDTO(BaseModel):
    taskId: str
    title: str
    senderId: str
    senderUsername: str
    createdAt: str
    deadlineAt: str | None = None
    # True once at least one assignee row on this task is MISSED — the same
    # outcome deadlines.py's sweep already owns, never re-derived from
    # deadlineAt client-side.
    overdue: bool
    taskStatus: ProjectTaskStatus
    assignees: list[ProjectTaskAssigneeDTO]


class ProjectAnalyticsDTO(BaseModel):
    projectId: str
    statusBreakdown: StatusBreakdownDTO
    completion: CompletionMetricsDTO
    workload: list[AssigneeWorkloadDTO]
    overdueUniqueTasks: int
    tasks: list[ProjectTaskSummaryDTO]
    tasksOffset: int
    tasksLimit: int
    tasksTotal: int
