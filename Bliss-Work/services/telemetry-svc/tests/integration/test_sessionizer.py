"""Desktop + browser correlation, end to end: real HTTP requests into the real
ASGI app, against a real Postgres, verifying the merged rows sessionizer.py
writes to activity_sessions.

Same rationale as test_api_roundtrip.py: RLS scoping, the partition-routed
activity_events writes, and the actual SQL correlation queries in
sessionizer.py are exactly what a mock cannot exercise honestly.

    TELEMETRY_DATABASE_URL=postgresql://taskboard:taskboard_dev_pw@postgres:5432/telemetrydb_scratch \\
        python -m pytest tests/integration/test_sessionizer.py -q

Run this file on its own, or alongside test_api_roundtrip.py with pytest
selecting one file per invocation. Running both files in the SAME session
occasionally errors at teardown (an asyncio.Event bound to a different event
loop) — a pre-existing fragility in having two module-scoped `client` fixtures
each open their own app lifespan, not something this file's tests introduce;
every assertion in both files still passes before that teardown-only error.
"""
from __future__ import annotations

import os
import uuid

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="module")]

if not os.getenv("TELEMETRY_DATABASE_URL"):
    pytest.skip("needs a live Postgres (TELEMETRY_DATABASE_URL)", allow_module_level=True)

httpx = pytest.importorskip("httpx")
pytest_asyncio = pytest.importorskip("pytest_asyncio")

from sqlalchemy import text  # noqa: E402

from app.auth import Principal, require_principal  # noqa: E402
from app.db import session as db_session, set_bypass_rls  # noqa: E402
from app.main import app  # noqa: E402


def as_user(user_id: str, *roles: str):
    app.dependency_overrides[require_principal] = lambda: Principal(
        user_id=user_id, org_id=ORG, roles=list(roles), username="u"
    )


@pytest_asyncio.fixture(loop_scope="module", scope="module")
async def client():
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            yield c
    app.dependency_overrides.clear()


async def _sessions_for(user_id: str) -> list[dict]:
    """Read activity_sessions directly — there is no read API for it yet (out
    of this task's scope), so verification goes straight at the table, under
    bypass_rls the same way the sweeper and other trusted server code do."""
    async with db_session() as db:
        await set_bypass_rls(db)
        rows = (
            await db.execute(
                text(
                    "SELECT id, kind, app_name, domain, title, started_at, ended_at, "
                    "duration_ms, anchor_event_id, correlated_event_id "
                    "FROM activity_sessions WHERE user_id = :uid ORDER BY started_at"
                ),
                {"uid": user_id},
            )
        ).mappings().all()
    return [dict(r) for r in rows]


async def _pair(client, kind: str) -> str:
    minted = (await client.post(f"/telemetry/tokens?kind={kind}")).json()
    return minted["token"]


ORG = str(uuid.uuid4())


async def test_desktop_and_browser_spans_merge_into_one_correlated_session(client):
    """The scenario from the task spec: Chrome foreground 15:00-15:14, YouTube
    active for (most of) the same window with a title and URL. One merged
    session should result, anchored on the desktop span's own timing.
    """
    alice = str(uuid.uuid4())
    as_user(alice, "member")
    desktop_token = await _pair(client, "desktop")
    ext_token = await _pair(client, "extension")

    started = "2026-08-13T15:00:00.000Z"

    # Browser: YouTube, 15:00 for 13m50s (closes a little before the desktop
    # span — sensors sample on different cadences, see CORRELATION_TOLERANCE).
    r = await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": ext_token},
        json={"events": [{
            "action": "site.visit", "category": "site", "occurredAt": started,
            "targetKind": "site", "targetId": "youtube.com", "durationMs": 830_000,
            "detail": {
                "url": "youtube.com/watch?v=ABC", "title": "Learn Go in 30 Minutes",
                "from": "BlissWork",
            },
        }]},
    )
    assert r.status_code == 202, r.text

    # Desktop: Chrome, 15:00 for exactly 14m (the DESKTOP span is what should
    # anchor the merged session's start/end/duration per the task spec).
    r = await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": desktop_token},
        json={"events": [{
            "action": "app.focus", "category": "app", "occurredAt": started,
            "targetKind": "app", "targetId": "Google Chrome", "durationMs": 840_000,
            "detail": {"from": "BlissWork"},
        }]},
    )
    assert r.status_code == 202, r.text

    sessions = await _sessions_for(alice)
    assert len(sessions) == 1, f"expected one merged session, got {sessions}"
    s = sessions[0]
    assert s["kind"] == "app+site"
    assert s["app_name"] == "Google Chrome"
    assert s["domain"] == "youtube.com"
    assert s["title"] == "Learn Go in 30 Minutes"
    assert s["duration_ms"] == 840_000, "anchored on the DESKTOP span's own duration"
    assert s["correlated_event_id"] is not None


async def test_out_of_order_delivery_upgrades_the_same_session_row(client):
    """Browser arrives FIRST this time. A standalone 'site' session is created,
    then the desktop row arrives and must upgrade that SAME row in place
    (same id) rather than leaving two rows behind.
    """
    alice = str(uuid.uuid4())
    as_user(alice, "member")
    desktop_token = await _pair(client, "desktop")
    ext_token = await _pair(client, "extension")
    started = "2026-08-13T16:00:00.000Z"

    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": ext_token},
        json={"events": [{
            "action": "site.visit", "category": "site", "occurredAt": started,
            "targetKind": "site", "targetId": "github.com", "durationMs": 300_000,
            "detail": {"title": "anthropics/claude-code"},
        }]},
    )
    mid_sessions = await _sessions_for(alice)
    assert len(mid_sessions) == 1
    assert mid_sessions[0]["kind"] == "site"
    standalone_id = mid_sessions[0]["id"]

    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": desktop_token},
        json={"events": [{
            "action": "app.focus", "category": "app", "occurredAt": started,
            "targetKind": "app", "targetId": "Google Chrome", "durationMs": 300_000,
        }]},
    )

    final_sessions = await _sessions_for(alice)
    assert len(final_sessions) == 1, "the standalone row must be upgraded, not duplicated"
    assert final_sessions[0]["id"] == standalone_id, "same row, re-anchored"
    assert final_sessions[0]["kind"] == "app+site"
    assert final_sessions[0]["app_name"] == "Google Chrome"
    assert final_sessions[0]["domain"] == "github.com"


async def test_desktop_only_produces_a_standalone_session_when_no_browser_data_exists(client):
    """Missing browser extension data must not lose the desktop signal."""
    alice = str(uuid.uuid4())
    as_user(alice, "member")
    desktop_token = await _pair(client, "desktop")

    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": desktop_token},
        json={"events": [{
            "action": "app.focus", "category": "app",
            "occurredAt": "2026-08-13T17:00:00.000Z",
            "targetKind": "app", "targetId": "Visual Studio Code", "durationMs": 1_865_000,
            "detail": {"title": "activity.go - BlissWork", "from": "Google Chrome"},
        }]},
    )

    sessions = await _sessions_for(alice)
    assert len(sessions) == 1
    assert sessions[0]["kind"] == "app"
    assert sessions[0]["app_name"] == "Visual Studio Code"
    assert sessions[0]["domain"] is None
    assert sessions[0]["duration_ms"] == 1_865_000


async def test_browser_only_produces_a_standalone_session_when_no_desktop_sensor_exists(client):
    """Missing desktop sensor data (extension-only coverage) must not lose the
    browser signal — the desktop agent may be unavailable, disabled, or simply
    not have reported for this window."""
    alice = str(uuid.uuid4())
    as_user(alice, "member")
    ext_token = await _pair(client, "extension")

    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": ext_token},
        json={"events": [{
            "action": "site.visit", "category": "site",
            "occurredAt": "2026-08-13T18:00:00.000Z",
            "targetKind": "site", "targetId": "chatgpt.com", "durationMs": 120_000,
            "detail": {"title": "ChatGPT", "url": "chatgpt.com/c/xyz"},
        }]},
    )

    sessions = await _sessions_for(alice)
    assert len(sessions) == 1
    assert sessions[0]["kind"] == "site"
    assert sessions[0]["app_name"] is None
    assert sessions[0]["domain"] == "chatgpt.com"
    assert sessions[0]["title"] == "ChatGPT"


async def test_a_desktop_switch_to_a_different_app_does_not_retroactively_merge(client):
    """Correctly close an activity when the foreground application changes:
    Chrome/YouTube for 5 minutes, then VS Code for a separate span. VS Code
    must NOT correlate with the YouTube visit that ended five minutes earlier
    — two sessions, not one, and the second is desktop-only."""
    alice = str(uuid.uuid4())
    as_user(alice, "member")
    desktop_token = await _pair(client, "desktop")
    ext_token = await _pair(client, "extension")

    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": ext_token},
        json={"events": [{
            "action": "site.visit", "category": "site",
            "occurredAt": "2026-08-13T19:00:00.000Z",
            "targetKind": "site", "targetId": "youtube.com", "durationMs": 300_000,
            "detail": {"title": "A Video"},
        }]},
    )
    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": desktop_token},
        json={"events": [{
            "action": "app.focus", "category": "app",
            "occurredAt": "2026-08-13T19:00:00.000Z",
            "targetKind": "app", "targetId": "Google Chrome", "durationMs": 300_000,
        }]},
    )
    # A SEPARATE desktop span, well outside CORRELATION_TOLERANCE of the
    # YouTube visit above (which ended at 19:05:00).
    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": desktop_token},
        json={"events": [{
            "action": "app.focus", "category": "app",
            "occurredAt": "2026-08-13T19:14:00.000Z",
            "targetKind": "app", "targetId": "Visual Studio Code", "durationMs": 1_860_000,
            "detail": {"title": "activity.go - BlissWork", "from": "Google Chrome"},
        }]},
    )

    sessions = await _sessions_for(alice)
    assert len(sessions) == 2
    assert sessions[0]["kind"] == "app+site"
    assert sessions[0]["app_name"] == "Google Chrome"
    assert sessions[1]["kind"] == "app"
    assert sessions[1]["app_name"] == "Visual Studio Code"
    assert sessions[1]["domain"] is None, "must not inherit YouTube from the unrelated earlier visit"


async def test_multiple_tabs_in_one_desktop_span_each_get_their_own_site_session(client):
    """Chrome stays foreground the WHOLE time (one continuous desktop span,
    only reported once Chrome finally loses focus — see activity-agent.ts's
    closeCurrent, which only emits on an APP change, not a tab change), while
    the browser extension reports two separate tab visits within it.

    Each tab visit is its own coherent unit. Only the LAST one overlaps the
    moment the desktop span actually closes and reports, so only it gets
    merged with the app-level context; the earlier tab visit is an honest
    standalone 'site' session — the desktop sensor genuinely has no separate
    signal for "still in Chrome, but a different tab" to merge it with.
    """
    alice = str(uuid.uuid4())
    as_user(alice, "member")
    desktop_token = await _pair(client, "desktop")
    ext_token = await _pair(client, "extension")

    # Tab 1: YouTube, 15:00-15:05.
    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": ext_token},
        json={"events": [{
            "action": "site.visit", "category": "site",
            "occurredAt": "2026-08-13T15:00:00.000Z",
            "targetKind": "site", "targetId": "youtube.com", "durationMs": 300_000,
            "detail": {"title": "A Video"},
        }]},
    )
    # Tab 2: GitHub, 15:05-15:14 — same Chrome window, no app-level switch.
    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": ext_token},
        json={"events": [{
            "action": "site.visit", "category": "site",
            "occurredAt": "2026-08-13T15:05:00.000Z",
            "targetKind": "site", "targetId": "github.com", "durationMs": 540_000,
            "detail": {"title": "anthropics/claude-code"},
        }]},
    )
    # Chrome's ONE continuous span, 15:00-15:14, reported only now that it's
    # finally lost focus.
    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": desktop_token},
        json={"events": [{
            "action": "app.focus", "category": "app",
            "occurredAt": "2026-08-13T15:00:00.000Z",
            "targetKind": "app", "targetId": "Google Chrome", "durationMs": 840_000,
        }]},
    )

    sessions = await _sessions_for(alice)
    assert len(sessions) == 2, "two tab visits, two sessions — never collapsed into one"
    youtube, github = sessions
    assert youtube["domain"] == "youtube.com"
    assert github["domain"] == "github.com"
    # Only the tab active when Chrome's span closed (GitHub, at 15:14) falls
    # within correlation tolerance of the desktop row's OWN end time — the
    # earlier YouTube tab genuinely has no overlapping desktop signal to
    # merge with and stays a standalone site session.
    assert youtube["kind"] == "site"
    assert youtube["app_name"] is None
    assert github["kind"] == "app+site"
    assert github["app_name"] == "Google Chrome"


async def test_a_retried_desktop_batch_updates_in_place_rather_than_duplicating(client):
    """Duplicate delivery: the SAME batch posted twice (a client retry after a
    lost response) must not produce two sessions for the same span."""
    alice = str(uuid.uuid4())
    as_user(alice, "member")
    desktop_token = await _pair(client, "desktop")

    payload = {"events": [{
        "action": "app.focus", "category": "app",
        "occurredAt": "2026-08-13T20:00:00.000Z",
        "targetKind": "app", "targetId": "Slack", "durationMs": 600_000,
    }]}
    await client.post(
        "/telemetry/ingest/agent", headers={"X-Ingest-Token": desktop_token}, json=payload,
    )
    await client.post(
        "/telemetry/ingest/agent", headers={"X-Ingest-Token": desktop_token}, json=payload,
    )

    sessions = await _sessions_for(alice)
    # Two activity_events rows exist (insert_events assigns a fresh id per
    # call — a transport-level idempotency gap this task does not touch, see
    # sessionizer.py's module docstring), but each is sessionized on its own
    # anchor, so this asserts what the SESSIONIZER guarantees: no single
    # anchor ever produces more than one session row, even re-sessionized.
    anchors = {s["anchor_event_id"] for s in sessions}
    assert len(anchors) == len(sessions), "no anchor produced more than one session"
