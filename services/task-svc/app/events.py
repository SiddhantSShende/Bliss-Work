from __future__ import annotations

from datetime import datetime, timezone

import uuid6

# Canonical Kafka topic for task events (key = taskId).
TASK_TOPIC = "task.events.v1"
AUTH_TOPIC = "auth.events"


def new_event_id() -> str:
    return str(uuid6.uuid7())


def now_iso_z() -> str:
    """ISO-8601 UTC with a trailing 'Z'."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _envelope(org_id: str, event_type: str) -> dict:
    return {
        "eventId": new_event_id(),
        "orgId": org_id,
        "occurredAt": now_iso_z(),
        "type": event_type,
    }


def task_assigned(
    *, org_id: str, task_id: str, assignee_id: str, sender_id: str,
    status_version: int, sender_username: str, title: str, description: str,
) -> dict:
    return {
        **_envelope(org_id, "task.assigned"),
        "taskId": task_id,
        "assigneeId": assignee_id,
        "senderId": sender_id,
        "statusVersion": status_version,
        "senderUsername": sender_username,
        "title": title,
        "description": description,
    }


def task_acknowledged(
    *, org_id: str, task_id: str, assignee_id: str, sender_id: str,
    status_version: int, assignee_username: str,
) -> dict:
    return {
        **_envelope(org_id, "task.acknowledged"),
        "taskId": task_id,
        "assigneeId": assignee_id,
        "senderId": sender_id,
        "statusVersion": status_version,
        "assigneeUsername": assignee_username,
    }


def task_completed(
    *, org_id: str, task_id: str, assignee_id: str, sender_id: str,
    status_version: int, assignee_username: str,
) -> dict:
    return {
        **_envelope(org_id, "task.completed"),
        "taskId": task_id,
        "assigneeId": assignee_id,
        "senderId": sender_id,
        "statusVersion": status_version,
        "assigneeUsername": assignee_username,
    }


def task_ignored(
    *, org_id: str, task_id: str, assignee_id: str, sender_id: str,
    status_version: int, assignee_username: str,
) -> dict:
    return {
        **_envelope(org_id, "task.ignored"),
        "taskId": task_id,
        "assigneeId": assignee_id,
        "senderId": sender_id,
        "statusVersion": status_version,
        "assigneeUsername": assignee_username,
    }


def task_left(
    *, org_id: str, task_id: str, assignee_id: str, sender_id: str,
    status_version: int, assignee_username: str,
) -> dict:
    return {
        **_envelope(org_id, "task.left"),
        "taskId": task_id,
        "assigneeId": assignee_id,
        "senderId": sender_id,
        "statusVersion": status_version,
        "assigneeUsername": assignee_username,
    }
