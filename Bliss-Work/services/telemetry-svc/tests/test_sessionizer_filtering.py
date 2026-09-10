"""Pure logic in sessionizer.py: what `sessionize_inserted` filters out before
ever touching the database, and the span-boundary math.

The correlation SQL itself (finding an uncorrelated overlapping row, the
re-anchor upgrade, the upsert) needs real Postgres semantics — RLS, ordering,
row locking under concurrent writers — and is exercised by
tests/integration/test_sessionizer.py against a real database, the same split
test_non_event_actions.py/test_api_roundtrip.py already establish for the rest
of this service. This file covers what does NOT need a database: which rows
`sessionize_inserted` even hands to the correlator, and the arithmetic that
turns (occurred_at, duration_ms) into a session's boundaries.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

ingest = pytest.importorskip(
    "app.ingest", reason="telemetry-svc deps not installed locally; CI installs requirements.txt.",
)
sessionizer = pytest.importorskip(
    "app.sessionizer", reason="telemetry-svc deps not installed locally; CI installs requirements.txt.",
)

ORG = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
ALICE = "3f2504e0-4f89-11d3-9a0c-0305e82c3302"
T0 = datetime(2026, 8, 13, 15, 0, 0, tzinfo=timezone.utc)


def _inserted(action: str, category: str, *, duration_ms: int | None = 60_000, target_id: str | None = "x") -> "ingest.InsertedRow":
    row = ingest.ActivityRow(
        org_id=ORG, user_id=ALICE, occurred_at=T0, source="desktop",
        category=category, action=action, target_id=target_id, duration_ms=duration_ms,
    )
    return ingest.InsertedRow(id="row-id", row=row)


class _RecordingDb:
    """Stands in for sessionize()'s db parameter, recording whether it was
    ever called — sessionize_inserted's filtering is what these tests check,
    not what sessionize() itself does with a row once handed one."""

    def __init__(self) -> None:
        self.sessionize_calls: list[list] = []


async def test_non_app_site_categories_are_never_sessionized(monkeypatch):
    """auth/navigation/engagement/system/security rows have no foreground span
    — sessionize() must never even be called for them."""
    calls: list[list] = []

    async def _fake_sessionize(_db, rows):
        calls.append(rows)

    monkeypatch.setattr(sessionizer, "sessionize", _fake_sessionize)

    inserted = [
        _inserted("login", "auth"),
        _inserted("route.enter", "navigation"),
        _inserted("task.completed", "engagement"),
        _inserted("screen.locked", "system"),
        _inserted("screenshot.attempted", "security"),
    ]
    await sessionizer.sessionize_inserted(_RecordingDb(), inserted)

    assert calls == [], "none of these categories should reach sessionize() at all"


async def test_app_and_site_rows_are_forwarded(monkeypatch):
    calls: list[list] = []

    async def _fake_sessionize(_db, rows):
        calls.append(rows)

    monkeypatch.setattr(sessionizer, "sessionize", _fake_sessionize)

    inserted = [_inserted("app.focus", "app"), _inserted("site.visit", "site")]
    await sessionizer.sessionize_inserted(_RecordingDb(), inserted)

    assert len(calls) == 1
    forwarded = calls[0]
    assert [r.category for r in forwarded] == ["app", "site"]
    assert [r.id for r in forwarded] == ["row-id", "row-id"]


async def test_a_span_with_no_duration_is_skipped_not_fabricated(monkeypatch):
    """An app/site row that never got a duration (a producer bug, or a
    non-span action that slipped past the route's category filter) must not
    be sessionized with a fabricated zero-length duration — see the
    docstring in sessionize_inserted for why that would be a false record,
    not a conservative default."""
    calls: list[list] = []

    async def _fake_sessionize(_db, rows):
        calls.append(rows)

    monkeypatch.setattr(sessionizer, "sessionize", _fake_sessionize)

    inserted = [
        _inserted("app.focus", "app", duration_ms=None),
        _inserted("site.visit", "site", duration_ms=5_000),
    ]
    await sessionizer.sessionize_inserted(_RecordingDb(), inserted)

    assert len(calls) == 1
    assert len(calls[0]) == 1
    assert calls[0][0].action == "site.visit"


async def test_sessionize_is_not_called_at_all_when_nothing_qualifies(monkeypatch):
    """A pure navigation/engagement batch must cost zero calls into the
    correlator, not one call with an empty list — the routes call this on
    every ingest, and a wasted round trip on the overwhelmingly common batch
    shape (web beacons, mostly navigation) would be needless work."""
    calls: list[list] = []

    async def _fake_sessionize(_db, rows):
        calls.append(rows)

    monkeypatch.setattr(sessionizer, "sessionize", _fake_sessionize)

    await sessionizer.sessionize_inserted(_RecordingDb(), [_inserted("route.enter", "navigation")])

    assert calls == []


def test_span_of_adds_duration_to_occurred_at():
    row = sessionizer.SessionizableRow(
        id="1", org_id=ORG, user_id=ALICE, category="app", action="app.focus",
        occurred_at=T0, duration_ms=840_000, target_id="Google Chrome", detail={},
    )
    start, end = sessionizer._span_of(row)
    assert start == T0
    assert (end - start).total_seconds() == 840.0


def test_span_of_handles_a_missing_duration_as_zero_length():
    row = sessionizer.SessionizableRow(
        id="1", org_id=ORG, user_id=ALICE, category="app", action="app.focus",
        occurred_at=T0, duration_ms=None, target_id="x", detail={},
    )
    start, end = sessionizer._span_of(row)
    assert start == end == T0


def test_merged_span_uses_the_anchors_own_timing_not_the_others():
    """The task spec's example: the DESKTOP span's boundaries (15:00-15:14)
    are what the merged session reports, even when the browser's own span
    closed at a slightly different moment (15:00-15:13:50)."""
    desktop = sessionizer.SessionizableRow(
        id="d", org_id=ORG, user_id=ALICE, category="app", action="app.focus",
        occurred_at=T0, duration_ms=840_000, target_id="Google Chrome", detail={},
    )
    browser = sessionizer.SessionizableRow(
        id="b", org_id=ORG, user_id=ALICE, category="site", action="site.visit",
        occurred_at=T0, duration_ms=830_000, target_id="youtube.com", detail={},
    )
    start, end = sessionizer._merged_span(desktop, browser)
    assert start == T0
    assert (end - start).total_seconds() == 840.0, "the DESKTOP duration, not the browser's"
