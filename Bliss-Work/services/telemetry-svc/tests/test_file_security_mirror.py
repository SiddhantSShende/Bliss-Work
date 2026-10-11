"""The security record of a chat file open/download is derived from the activity
row, never accepted from a client (unit-level; the stored behaviour is in
tests/integration/test_file_security_events.py)."""
from __future__ import annotations

from datetime import datetime, timezone

from app.ingest import (
    FILE_SECURITY_ACTIONS,
    SECURITY_MIRROR_ACTIONS,
    ActivityRow,
    security_mirror_of,
)

AT = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)


def _row(action: str, **over) -> ActivityRow:
    base = dict(
        org_id="org", user_id="u1", session_id="s1", occurred_at=AT, source="desktop",
        category="engagement", action=action, surface="channels", target_kind="attachment",
        target_id="att-1", detail={"filename": "Report.pdf", "contextKind": "channel",
                                   "contextName": "GRC Development"},
        client_event_id="evt-1",
    )
    base.update(over)
    return ActivityRow(**base)


def test_an_opened_file_derives_a_file_opened_security_row_with_the_same_facts():
    base = _row("attachment.opened")
    m = security_mirror_of(base)

    assert m is not None and m is not base
    assert (m.category, m.action) == ("security", "file.opened")
    # Same actor, time, session (so the same IP / device / platform), platform and target.
    for f in ("org_id", "user_id", "session_id", "occurred_at", "source", "surface", "target_kind", "target_id"):
        assert getattr(m, f) == getattr(base, f), f
    assert m.detail == base.detail
    # A copy, not the same dict: changing one row must not change the other.
    assert m.detail is not base.detail


def test_a_downloaded_file_derives_file_downloaded():
    assert security_mirror_of(_row("attachment.downloaded")).action == "file.downloaded"


def test_every_other_action_derives_nothing():
    for action in ("message.sent", "mail.attachment.downloaded", "screenshot.attempted", "file.opened", "route.enter"):
        assert security_mirror_of(_row(action)) is None, action


def test_the_derived_id_is_stable_distinct_and_absent_without_a_base_id():
    a1 = security_mirror_of(_row("attachment.opened", client_event_id="evt-1"))
    a2 = security_mirror_of(_row("attachment.opened", client_event_id="evt-1"))
    b = security_mirror_of(_row("attachment.opened", client_event_id="evt-2"))
    assert a1.client_event_id == a2.client_event_id          # a retry derives the same id
    assert a1.client_event_id != "evt-1"                       # and never collides with the base's
    assert a1.client_event_id != b.client_event_id
    assert len(a1.client_event_id) <= 64                       # BeaconEvent.clientEventId's bound
    assert security_mirror_of(_row("attachment.opened", client_event_id=None)).client_event_id is None


def test_the_reserved_actions_are_exactly_the_derived_ones():
    assert SECURITY_MIRROR_ACTIONS == set(FILE_SECURITY_ACTIONS.values()) == {"file.opened", "file.downloaded"}
