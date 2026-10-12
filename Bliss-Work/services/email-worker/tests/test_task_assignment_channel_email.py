"""`_send_for_event` for TASK_ASSIGNED: individual vs. channel-flavored subject,
allocator Reply-To, and skipping an ineligible recipient.

Runs the real `_send_for_event`; only `_lookup_user` (the auth-svc internal
lookup) and `_mailer.send` are faked, same harness style as test_offline_gate.py.
"""
from __future__ import annotations

import types

import httpx
import pytest

from app import relay_consumer
from app.relay_consumer import TASK_ASSIGNED, RelayConsumer

ORG_ID = "00000000-0000-4000-8000-000000000001"
OTHER_ORG_ID = "00000000-0000-4000-8000-000000000002"


def _settings() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        smtp_host="mailpit", smtp_port=1025, smtp_from="no-reply@test.local",
        smtp_username="", smtp_password="", smtp_starttls=False,
        redis_url="redis://localhost:6379/0", relay_max_concurrency=4,
        poison_max_failures=3, dlq_topic="email-worker-dlq",
        offline_threshold_seconds=60, web_origin="https://app.example.test",
        auth_internal_base="http://auth-svc:8001",
        auth_internal_token="test-token",
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

    directory = {
        user_id: {"orgId": ORG_ID, **user}
        for user_id, user in users.items()
    }

    async def _lookup_user(
        user_id: str,
        request_id: str | None = None,
        *,
        retry_transient: bool = False,
    ) -> dict | None:
        return directory.get(user_id)

    c._lookup_user = _lookup_user  # type: ignore[method-assign]
    return c, mailer


BASE_EVENT = {
    "eventId": "evt-1", "type": "task.assigned", "taskId": "t1",
    "orgId": ORG_ID,
    "senderId": "sender-1", "assigneeId": "alice",
    "title": "Ship the report", "description": "Quarterly numbers",
    "occurredAt": "2026-10-12T12:14:30.430Z",
}


async def test_individual_assignment_subject_and_reply_to():
    full_description = "Quarterly numbers. " + ("more context. " * 30)
    event = {**BASE_EVENT, "description": full_description}
    c, mailer = _consumer({
        "alice": {"email": "alice@example.com", "emailVerified": True, "status": "active"},
        "sender-1": {"email": "sam@example.com", "emailVerified": True, "username": "sam", "status": "active"},
    })

    await c._send_for_event(event, "alice", TASK_ASSIGNED)

    assert len(mailer.calls) == 1
    call = mailer.calls[0]
    assert call["to"] == "alice@example.com"
    assert call["subject"] == "BlissWork: sam assigned you a task — Ship the report"
    assert call["reply_to"] == "sam@example.com"
    assert "Assigned: 2026-10-12 12:14 UTC" in call["text_body"]
    assert "https://app.example.test/app/tasks/allocated" in call["text_body"]
    assert full_description in call["text_body"]


async def test_channel_assignment_subject_names_the_channel_not_the_allocator():
    event = {**BASE_EVENT, "channelId": "c1", "channelName": "Engineering"}
    c, mailer = _consumer({
        "alice": {"email": "alice@example.com", "emailVerified": True, "status": "active"},
        "sender-1": {"email": "sam@example.com", "emailVerified": True, "username": "sam", "status": "active"},
    })

    await c._send_for_event(event, "alice", TASK_ASSIGNED)

    call = mailer.calls[0]
    assert call["subject"] == "BlissWork: New task assigned to Engineering — Ship the report"
    assert call["reply_to"] == "sam@example.com"


async def test_reply_to_is_empty_when_the_allocator_lookup_fails():
    """A failed/partial sender lookup must not block the recipient's email —
    Reply-To is simply omitted."""
    c, mailer = _consumer({
        "alice": {"email": "alice@example.com", "emailVerified": True, "status": "active"},
    })

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert len(mailer.calls) == 1
    assert mailer.calls[0]["reply_to"] == ""


async def test_suspended_recipient_is_skipped_without_an_smtp_call():
    c, mailer = _consumer({
        "alice": {"email": "alice@example.com", "emailVerified": True, "status": "suspended"},
    })

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert mailer.calls == []


async def test_removed_recipient_is_skipped_without_an_smtp_call():
    c, mailer = _consumer({
        "alice": {"email": "alice@example.com", "emailVerified": True, "status": "removed"},
    })

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert mailer.calls == []


async def test_recipient_with_no_status_field_defaults_to_eligible():
    """Older/partial UserDTO payloads with no `status` key must not be treated
    as ineligible — active is the default membership state."""
    c, mailer = _consumer({"alice": {"email": "alice@example.com", "emailVerified": True}})

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert len(mailer.calls) == 1


async def test_unverified_recipient_is_skipped_without_an_smtp_call():
    c, mailer = _consumer({
        "alice": {"email": "alice@example.com", "emailVerified": False, "status": "active"},
    })

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert mailer.calls == []


async def test_recipient_without_verified_email_flag_is_skipped():
    c, mailer = _consumer({"alice": {"email": "alice@example.com", "status": "active"}})

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert mailer.calls == []


async def test_recipient_from_another_org_is_skipped():
    c, mailer = _consumer({
        "alice": {
            "orgId": OTHER_ORG_ID,
            "email": "alice@example.com",
            "emailVerified": True,
            "status": "active",
        },
    })

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert mailer.calls == []


async def test_unverified_allocator_address_is_not_used_as_reply_to():
    c, mailer = _consumer({
        "alice": {"email": "alice@example.com", "emailVerified": True, "status": "active"},
        "sender-1": {
            "email": "sam@example.com",
            "emailVerified": False,
            "username": "sam",
            "status": "active",
        },
    })

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert len(mailer.calls) == 1
    assert mailer.calls[0]["reply_to"] == ""


async def test_allocator_lookup_circuit_open_does_not_block_task_email():
    c, mailer = _consumer({
        "alice": {"email": "alice@example.com", "emailVerified": True, "status": "active"},
    })

    async def _lookup_user(
        user_id: str,
        request_id: str | None = None,
        *,
        retry_transient: bool = False,
    ) -> dict | None:
        if user_id == "sender-1":
            raise relay_consumer.CircuitOpenError("auth-svc circuit is open")
        return {"orgId": ORG_ID, "email": "alice@example.com", "emailVerified": True}

    c._lookup_user = _lookup_user  # type: ignore[method-assign]

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert len(mailer.calls) == 1
    assert mailer.calls[0]["reply_to"] == ""


async def test_task_recipient_lookup_transient_error_is_not_swallowed(monkeypatch):
    c = RelayConsumer(_settings())
    c._http = object()  # type: ignore[assignment]

    async def _retry_async(*args, **kwargs):
        raise httpx.ConnectError("auth-svc unavailable")

    monkeypatch.setattr(relay_consumer, "retry_async", _retry_async)

    with pytest.raises(httpx.ConnectError):
        await c._lookup_user(ORG_ID, retry_transient=True)


async def test_allocator_from_another_org_is_not_attributed():
    c, mailer = _consumer({
        "alice": {"email": "alice@example.com", "emailVerified": True, "status": "active"},
        "sender-1": {
            "orgId": OTHER_ORG_ID,
            "email": "sam@example.com",
            "emailVerified": True,
            "username": "sam",
            "status": "active",
        },
    })

    await c._send_for_event(BASE_EVENT, "alice", TASK_ASSIGNED)

    assert len(mailer.calls) == 1
    assert "A teammate assigned you a task" in mailer.calls[0]["subject"]
    assert mailer.calls[0]["reply_to"] == ""


async def test_task_template_escapes_untrusted_content_in_html():
    event = {
        **BASE_EVENT,
        "title": '<img src=x onerror="alert(1)">',
        "description": "<script>alert(1)</script>",
    }
    c, mailer = _consumer({
        "alice": {"email": "alice@example.com", "emailVerified": True, "status": "active"},
        "sender-1": {"username": "sam"},
    })

    await c._send_for_event(event, "alice", TASK_ASSIGNED)

    html = mailer.calls[0]["html_body"]
    assert "&lt;img" in html
    assert "&lt;script&gt;" in html
    assert "<script>" not in html
