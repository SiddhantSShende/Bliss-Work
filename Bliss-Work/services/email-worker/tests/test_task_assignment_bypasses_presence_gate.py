"""TASK_ASSIGNED must reach `_send_for_event` unconditionally — no presence
check, no reconnect-grace wait — unlike MESSAGE_CREATED, which test_offline_gate.py
covers. A task assignment is not something the recipient is guaranteed to have
seen just because the app happens to be open somewhere for them right now, so
the email must not be conditioned on presence the way a chat notification is.

Runs the real `_handle`; only the database, presence, mailer and clock-sleep are
faked, same harness style as test_offline_gate.py.
"""
from __future__ import annotations

import json
import types
from datetime import datetime, timezone

from app.relay_consumer import RelayConsumer

THRESHOLD = 60


def _settings() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        smtp_host="mailpit", smtp_port=1025, smtp_from="no-reply@test.local",
        smtp_username="", smtp_password="", smtp_starttls=False,
        redis_url="redis://localhost:6379/0", relay_max_concurrency=4,
        poison_max_failures=3, dlq_topic="email-worker-dlq",
        offline_threshold_seconds=THRESHOLD,
    )


def _event(*, assignee_id: str = "alice", sender_id: str = "sender-1") -> bytes:
    return json.dumps({
        "type": "task.assigned", "eventId": "evt-1", "senderId": sender_id,
        "assigneeId": assignee_id, "statusVersion": 0, "senderUsername": "sam",
        "title": "Ship the report", "description": "",
        "occurredAt": datetime.now(timezone.utc).isoformat(),
    }).encode()


class _Presence:
    def __init__(self, online: bool):
        self.online = online
        self.checks = 0

    async def is_online(self, _user):
        self.checks += 1
        return self.online


class _Harness:
    def __init__(self, *, online: bool):
        self.c = RelayConsumer(_settings())
        self.presence = _Presence(online)
        self.sent: list[str] = []
        self.marked_sent: list[str] = []
        self.waits: list[float] = []
        c = self.c
        c._presence = self.presence

        async def _claim(*_a):
            return True

        async def _send_for_event(_event, recipient, _etype):
            self.sent.append(recipient)

        async def _mark_sent(_event_id, recipient):
            self.marked_sent.append(recipient)
            return True

        async def _sleep_or_stop(seconds):
            self.waits.append(seconds)

        c._claim = _claim
        c._send_for_event = _send_for_event
        c._mark_sent = _mark_sent
        c._sleep_or_stop = _sleep_or_stop


async def test_an_online_assignee_still_gets_the_task_email():
    h = _Harness(online=True)

    ok = await h.c._handle(_event())

    assert ok is True
    assert h.sent == ["alice"], "online must not suppress a task-assignment email"
    assert h.marked_sent == ["alice"]


async def test_an_offline_assignee_gets_the_task_email_with_no_wait():
    h = _Harness(online=False)

    ok = await h.c._handle(_event())

    assert ok is True
    assert h.sent == ["alice"]
    assert h.waits == [], "task assignments skip the reconnect-grace wait entirely"


async def test_presence_is_never_consulted_for_a_task_assignment():
    h = _Harness(online=True)

    await h.c._handle(_event())

    assert h.presence.checks == 0, "the presence gate must not run at all for TASK_ASSIGNED"
