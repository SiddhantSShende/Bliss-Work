"""Task event payload contract (pure-logic; no DB/Kafka).

Regression guard: task.ignored and task.left MUST carry assigneeUsername so the
allocator gets a durable, named notification ("Task ignored by alice" / "left by
alice") — notification-svc and the WS toast both read this field. Acknowledged /
completed already carried it; ignored/left were added so EVERY outcome notifies
the allocator. Also pins the shared envelope (type/eventId/orgId/occurredAt).
"""
from __future__ import annotations

from app import events

_ENVELOPE = {"type", "eventId", "orgId", "occurredAt"}
_TASK_FIELDS = {"taskId", "assigneeId", "senderId", "statusVersion"}


def _common(evt: dict, expected_type: str) -> None:
    assert _ENVELOPE <= set(evt)
    assert _TASK_FIELDS <= set(evt)
    assert evt["type"] == expected_type


def test_task_ignored_includes_assignee_username() -> None:
    evt = events.task_ignored(
        org_id="org", task_id="t", assignee_id="a", sender_id="s",
        status_version=2, assignee_username="alice",
    )
    _common(evt, "task.ignored")
    assert evt["assigneeUsername"] == "alice"


def test_task_left_includes_assignee_username() -> None:
    evt = events.task_left(
        org_id="org", task_id="t", assignee_id="a", sender_id="s",
        status_version=3, assignee_username="bob",
    )
    _common(evt, "task.left")
    assert evt["assigneeUsername"] == "bob"


def test_task_withdrawn_routes_to_all_affected_participants() -> None:
    evt = events.task_withdrawn(
        org_id="org", task_id="t", assignee_id="a", sender_id="s",
        status_version=4, assignee_username="alice", members=["s", "a", "b"],
    )
    _common(evt, "task.withdrawn")
    assert evt["assigneeUsername"] == "alice"
    assert evt["members"] == ["s", "a", "b"]


def test_task_missed_carries_what_every_consumer_needs() -> None:
    """task.missed is emitted by task-svc's deadline sweeper, never by a client.
    ws-gateway routes it to [senderId, assigneeId] (so both fields are required), the
    web client names the assignee in the allocator's toast (assigneeUsername), and
    sticky-svc / messaging-svc order it by statusVersion."""
    evt = events.task_missed(
        org_id="org", task_id="t", assignee_id="a", sender_id="s",
        status_version=4, assignee_username="carol",
    )
    _common(evt, "task.missed")
    assert evt["assigneeUsername"] == "carol"
    assert evt["statusVersion"] == 4
