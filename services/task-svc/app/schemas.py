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
    myStatus: AssigneeStatus
    actions: list[TaskActionT]
    statusVersion: int
    assignedAt: str
    acknowledgedAt: str | None = None


class SentAssignee(BaseModel):
    assigneeId: str
    assigneeUsername: str
    status: AssigneeStatus


class SentTaskDTO(BaseModel):
    taskId: str
    title: str
    description: str
    createdAt: str
    assignees: list[SentAssignee]


class TransitionResponse(BaseModel):
    status: AssigneeStatus
    statusVersion: int


def actions_for(status: str) -> list[TaskActionT]:
    if status == "SENT":
        return ["ACKNOWLEDGE", "IGNORE"]
    if status == "ACKNOWLEDGED":
        return ["COMPLETE", "LEAVE"]
    return []
