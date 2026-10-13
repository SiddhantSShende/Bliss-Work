"""The self-send guard in `_handle`: a task assigned to the same person who
sent the event never needs an email to themselves — the in-app copy is on
their own screen already. Covers the gap left by
test_task_assignment_channel_email.py, which only ever calls
`_send_for_event` directly and so never exercises `_handle`'s own guard
(the thing that actually decides whether `_send_for_event` runs at all).

This matters for task.assigned specifically: self-assignment is a normal,
supported flow (claiming an "Available" task, or an allocator assigning to
themselves), not an edge case — and it is the most likely assignment a
developer or tester tries first, so a regression here reads exactly like
"task emails don't work" even though the pipeline is fine for anyone else.

Runs the real `_handle`; the self-send check returns before anything touches
the database, Redis or SMTP, which this test also asserts (no `_db`/`_presence`
configured at all — a reach past the guard would raise, not silently pass).
"""
from __future__ import annotations

import json
import types

from app.relay_consumer import RelayConsumer

EVENT_ID = "11111111-1111-1111-1111-111111111111"
PERSON = "22222222-2222-2222-2222-222222222222"
OTHER = "33333333-3333-3333-3333-333333333333"


def _settings() -> types.SimpleNamespace:
    return types.SimpleNamespace(
        smtp_host="mailpit", smtp_port=1025, smtp_from="no-reply@test.local",
        smtp_username="", smtp_password="", smtp_starttls=False,
        redis_url="redis://localhost:6379/0", relay_max_concurrency=4,
        poison_max_failures=3, dlq_topic="email-worker-dlq",
    )


def _task_assigned(*, assignee_id: str, sender_id: str) -> bytes:
    return json.dumps({
        "type": "task.assigned",
        "eventId": EVENT_ID,
        "orgId": "org-1",
        "occurredAt": "2026-01-01T00:00:00.000Z",
        "taskId": "task-1",
        "assigneeId": assignee_id,
        "senderId": sender_id,
        "statusVersion": 0,
        "senderUsername": "ada",
        "title": "Write the report",
        "description": "",
    }).encode()


async def test_self_assigned_task_is_skipped_before_any_claim_presence_or_send():
    c = RelayConsumer(_settings())
    # Deliberately NOT set: c._db, c._presence, c._http. Reaching any of them
    # (a NoneType/assert failure, or a real call) proves the guard did not
    # return first — the exact way a regression here would surface.

    result = await c._handle(_task_assigned(assignee_id=PERSON, sender_id=PERSON))

    assert result is True, "self-assignment must be treated as handled (offset committed), not retried"


async def test_an_ordinary_different_assignee_is_not_caught_by_the_guard():
    """Contrast case: the same event shape, a genuinely different assignee,
    must NOT be short-circuited by the self-send guard — it has to reach the
    claim step, which is exactly where this fake setup (no `_db`) fails.
    Proves the guard is keyed on assigneeId == senderId, not on event shape
    alone — a guard that always returned True would pass the test above for
    the wrong reason."""
    c = RelayConsumer(_settings())

    raised = False
    try:
        await c._handle(_task_assigned(assignee_id=OTHER, sender_id=PERSON))
    except AssertionError:
        # _claim's own `assert self._db is not None`: reaching it is the
        # proof the self-send guard was correctly NOT taken for this event.
        raised = True

    assert raised, "a different assignee should reach the claim step, not be skipped as a self-send"
