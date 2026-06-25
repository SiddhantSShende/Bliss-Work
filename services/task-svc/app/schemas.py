from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

AssigneeStatus = Literal["SENT", "IGNORED", "ACKNOWLEDGED", "COMPLETED", "LEFT"]
TaskActionT = Literal["ACKNOWLEDGE", "IGNORE", "COMPLETE", "LEAVE"]


class CreateTaskRequest(BaseModel):
    title: str = Field(min_length=1)
    description: str = ""
    assigneeIds: list[str] = Field(default_factory=list)
    # When set, task-svc resolves the channel's current members via
    # messaging-svc's internal endpoint and fans out at server side. The
    # task is tagged with channel_id so future joiners can be auto-added
    # via the ChannelMemberJoined event consumer.
    channelId: str | None = None


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
