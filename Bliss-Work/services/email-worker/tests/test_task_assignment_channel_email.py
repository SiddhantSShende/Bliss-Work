"""`_send_for_event` for TASK_ASSIGNED: individual vs. channel-flavored subject,
allocator Reply-To, and skipping an ineligible recipient.

Runs the real `_send_for_event`; only `_lookup_user` (the auth-svc internal
lookup) and `_mailer.send` are faked, same harness style as test_offline_gate.py.
"""
from __future__ import annotations

import types

from app.relay_consumer import TASK_ASSIGNED, RelayConsumer


def _settings() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        smtp_host="mailpit", smtp_port=1025, smtp_from="no-reply@test.local",
        smtp_username="", smtp_password="", smtp_starttls=False,
        redis_url="redis://localhost:6379/0", relay_max_concurrency=4,
        poison_max_failures=3, dlq_topic="email-worker-dlq",
        offline_threshold_seconds=60, web_origin="https://app.example.test",
    )


class _FakeMailer:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def send(self, **kwargs) -> None:
        self.calls.append(kwargs)


def _consumer(users: dict[str, dict]) -> tuple[RelayConsumer, _FakeMailer]:
    c = RelayConsumer(_settings())
    mailer = _FakeMailer()
    c._mailer = mailer  # type: ignore[assignment]

    async def _lookup_user(user_id: str, request_id: str | None = None) -> dict | None:
        return users.get(user_id)

    c._lookup_user = _lookup_user  # type: ignore[method-assign]
    return c, mailer


BASE_EVENT = {
    "eventId": "evt-1", "type": "task.assigned", "taskId": "t1",
    "senderId": "sender-1", "assigneeId": "alice",
    "title": "Ship the report", "description": "Quarterly numbers",
}


async def test_individual_assignment_subject_and_reply_to():
    c, mailer = _consumer({
        "alice": {"email": "alice@example.com", "status": "active"},
        "sender-1": {"email": "sam@example.com", "username": "sam", "status": "active"},
    })

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert len(mailer.calls) == 1
    call = mailer.calls[0]
    assert call["to"] == "alice@example.com"
    assert call["subject"] == "BlissWork: sam assigned you a task — Ship the report"
    assert call["reply_to"] == "sam@example.com"


async def test_channel_assignment_subject_names_the_channel_not_the_allocator():
    event = {**BASE_EVENT, "channelId": "c1", "channelName": "Engineering"}
    c, mailer = _consumer({
        "alice": {"email": "alice@example.com", "status": "active"},
        "sender-1": {"email": "sam@example.com", "username": "sam", "status": "active"},
    })

    await c._send_for_event(event, "alice", TASK_ASSIGNED)

    call = mailer.calls[0]
    assert call["subject"] == "BlissWork: New task assigned to Engineering — Ship the report"
    assert call["reply_to"] == "sam@example.com"


async def test_reply_to_is_empty_when_the_allocator_lookup_fails():
    """A failed/partial sender lookup must not block the recipient's email —
    Reply-To is simply omitted."""
    c, mailer = _consumer({"alice": {"email": "alice@example.com", "status": "active"}})

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert len(mailer.calls) == 1
    assert mailer.calls[0]["reply_to"] == ""


async def test_suspended_recipient_is_skipped_without_an_smtp_call():
    c, mailer = _consumer({"alice": {"email": "alice@example.com", "status": "suspended"}})

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert mailer.calls == []


async def test_removed_recipient_is_skipped_without_an_smtp_call():
    c, mailer = _consumer({"alice": {"email": "alice@example.com", "status": "removed"}})

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert mailer.calls == []


async def test_recipient_with_no_status_field_defaults_to_eligible():
    """Older/partial UserDTO payloads with no `status` key must not be treated
    as ineligible — active is the default membership state."""
    c, mailer = _consumer({"alice": {"email": "alice@example.com"}})

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert len(mailer.calls) == 1
