"""Liveness beats must never reach activity_events.

A `heartbeat` says "this client is still open", which the beacon carrying it has
already recorded properly: `open_or_touch` advances the session's `last_seen_at`
and banks the active/idle time from the same request. Storing a row as well put
one identical entry per minute per open client on a member's timeline, between
the events that actually say what they did.

The rule lives in the shared write path rather than in the beacon handler, and
these tests hold it there: desktop builds and cached browser bundles keep
sending heartbeats for as long as they are installed, so a filter in the route
would be one stale client away from being bypassed.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

ingest = pytest.importorskip(
    "app.ingest",
    reason="telemetry-svc deps not installed locally; CI installs requirements.txt.",
)

ORG = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
ALICE = "3f2504e0-4f89-11d3-9a0c-0305e82c3302"


class _NullSavepoint:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


class _FakeDb:
    """Enough AsyncSession to observe what the insert was handed."""

    def __init__(self) -> None:
        self.batches: list[list[dict]] = []

    def begin_nested(self):
        return _NullSavepoint()

    async def execute(self, _stmt, params=None):
        self.batches.append(params)
        return None


def _row(action: str) -> "ingest.ActivityRow":
    return ingest.ActivityRow(
        org_id=ORG,
        user_id=ALICE,
        occurred_at=datetime(2026, 8, 19, 10, 47, tzinfo=timezone.utc),
        source="web",
        category="engagement",
        action=action,
    )


async def test_a_heartbeat_is_not_written():
    db = _FakeDb()

    written = await ingest.insert_events(db, [_row("heartbeat")])

    assert written == [], "insert_events now returns the rows actually written, not a count"
    assert db.batches == [], "a batch of nothing but beats must not touch the table"


async def test_the_events_around_a_heartbeat_still_are():
    """The beat is dropped from the batch, not the batch because of the beat."""
    db = _FakeDb()

    written = await ingest.insert_events(
        db, [_row("focus"), _row("heartbeat"), _row("task.completed")]
    )

    assert len(written) == 2
    assert [w.row.action for w in written] == ["focus", "task.completed"]
    assert [p["action"] for p in db.batches[0]] == ["focus", "task.completed"]
    # The returned id is the SAME id the row was actually inserted under —
    # this is the whole reason insert_events returns rows now: sessionizer.py
    # needs to know which activity_events.id a just-written span landed as.
    assert [w.id for w in written] == [p["id"] for p in db.batches[0]]


def test_the_beat_is_the_only_action_suppressed():
    """A wider set here would silently erase real activity.

    Everything else on the beacon — focus/blur, idle.start/idle.end, route
    dwell — is a thing the person did, and the timeline is the record of it.
    """
    assert ingest.NON_EVENT_ACTIONS == frozenset({"heartbeat"})
