"""Input-validation contract for ``app.schemas.CreateTaskRequest``.

These bounds are the edge defence against unbounded-input DoS / storage abuse and
malformed-id failures reaching the SQL layer or the messaging-svc fan-out, so the
contract is load-bearing:

  * title           -> 1..200 chars (empty or over-long rejected)
  * description     -> 0..10_000 chars (over-long rejected)
  * assigneeIds     -> <=500 items, every item a valid UUID
  * channelId       -> None, or a valid UUID

Pure-logic checks: importing ``app.schemas`` only pulls in pydantic (no DB / Kafka /
Redis). We import the REAL production model and skip cleanly if pydantic isn't
installed in a bare local interpreter, so the test never silently passes against a
re-implemented copy. CI installs requirements.txt and runs it for real.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

schemas = pytest.importorskip(
    "app.schemas",
    reason="task-svc deps (pydantic) not installed locally; CI installs requirements.txt.",
)
CreateTaskRequest = schemas.CreateTaskRequest
ValidationError = pytest.importorskip("pydantic").ValidationError

_UID = str(uuid.uuid4())
_UID2 = str(uuid.uuid4())


def test_minimal_valid_request() -> None:
    req = CreateTaskRequest(title="Ship it", assigneeIds=[_UID])
    assert req.title == "Ship it"
    assert req.description == ""
    assert req.assigneeIds == [_UID]
    assert req.channelId is None


def test_valid_with_channel_and_description() -> None:
    req = CreateTaskRequest(title="x", description="d" * 10_000, channelId=_UID)
    assert req.channelId == _UID
    assert len(req.description) == 10_000


@pytest.mark.parametrize(
    "kwargs",
    [
        {"title": ""},  # below min_length
        {"title": "x" * 201},  # above max_length
        {"title": "ok", "description": "d" * 10_001},  # description over cap
        {"title": "ok", "assigneeIds": [_UID] * 501},  # too many assignees
        {"title": "ok", "assigneeIds": ["not-a-uuid"]},  # non-UUID assignee
        {"title": "ok", "assigneeIds": [_UID, ""]},  # empty-string assignee
        {"title": "ok", "channelId": "nope"},  # non-UUID channel
        {"title": "ok", "channelId": "12345"},  # numeric-but-not-UUID channel
    ],
)
def test_invalid_requests_rejected(kwargs: dict) -> None:
    with pytest.raises(ValidationError):
        CreateTaskRequest(**kwargs)


def test_boundary_values_accepted() -> None:
    # Exactly at the limits is valid (off-by-one guard).
    CreateTaskRequest(title="t" * 200, description="d" * 10_000, assigneeIds=[_UID] * 500)


def test_multiple_valid_uuid_assignees() -> None:
    req = CreateTaskRequest(title="t", assigneeIds=[_UID, _UID2])
    assert req.assigneeIds == [_UID, _UID2]


def test_scheduled_request_requires_a_future_timezone_aware_time() -> None:
    when = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    req = CreateTaskRequest(title="later", assigneeIds=[_UID], allocation="SCHEDULED", scheduledFor=when)
    assert req.allocation == "SCHEDULED"
    assert req.scheduledFor is not None and req.scheduledFor.tzinfo is not None


def test_weekly_recurrence_requires_weekdays() -> None:
    with pytest.raises(ValidationError):
        CreateTaskRequest(
            title="weekly",
            assigneeIds=[_UID],
            allocation="RECURRING",
            recurrence={
                "startAt": (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
                "frequency": "WEEKLY",
                "interval": 1,
            },
        )


def test_monthly_recurrence_requires_a_rule() -> None:
    with pytest.raises(ValidationError):
        CreateTaskRequest(
            title="monthly",
            assigneeIds=[_UID],
            allocation="RECURRING",
            recurrence={
                "startAt": (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(),
                "frequency": "MONTHLY",
                "interval": 1,
            },
        )


def test_recurrence_end_conditions_require_matching_values() -> None:
    start = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    with pytest.raises(ValidationError):
        CreateTaskRequest(
            title="daily",
            assigneeIds=[_UID],
            allocation="RECURRING",
            recurrence={"startAt": start, "frequency": "DAILY", "endCondition": "AFTER_OCCURRENCES"},
        )
