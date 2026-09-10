"""GET /telemetry/members/{user_id}/activity-sessions — the read side of the
CORRELATED desktop+browser records sessionizer.py builds. Distinct from
/sessions (user_sessions, login presence) and from /timeline (raw
activity_events) — this proves the new endpoint actually returns
sessionizer.py's merged rows over real HTTP, against a real Postgres.

    TELEMETRY_DATABASE_URL=postgresql://taskboard:taskboard_dev_pw@postgres:5432/telemetrydb_scratch \\
        python -m pytest tests/integration/test_activity_sessions_api.py -q

Run on its own — see test_sessionizer.py's docstring for the pre-existing
multi-module client-fixture teardown fragility this repo's integration tests
already have when several files' fixtures share a pytest session.
"""
from __future__ import annotations

import os
import time
import uuid

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="module")]

if not os.getenv("TELEMETRY_DATABASE_URL"):
    pytest.skip("needs a live Postgres (TELEMETRY_DATABASE_URL)", allow_module_level=True)

httpx = pytest.importorskip("httpx")
pytest_asyncio = pytest.importorskip("pytest_asyncio")

from app.auth import Principal, require_principal  # noqa: E402
from app.main import app  # noqa: E402

ORG = str(uuid.uuid4())


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


def _recent_nanos(seconds_ago: int) -> str:
    return str(int((time.time() - seconds_ago) * 1_000_000_000))


async def _pair(client, kind: str) -> str:
    minted = (await client.post(f"/telemetry/tokens?kind={kind}")).json()
    return minted["token"]


async def test_a_correlated_app_plus_site_session_is_readable_over_http(client):
    """The exact target-example scenario, read back through the new endpoint
    rather than queried out of Postgres directly."""
    alice = str(uuid.uuid4())
    as_user(alice, "member")
    desktop_token = await _pair(client, "desktop")
    ext_token = await _pair(client, "extension")
    occurred = _recent_nanos(seconds_ago=900)

    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": ext_token},
        json={"events": [{
            "action": "site.visit", "category": "site",
            "occurredAt": _iso(occurred),
            "targetKind": "site", "targetId": "youtube.com", "durationMs": 830_000,
            "detail": {
                "url": "youtube.com/watch?v=dQw4w9WgXcQ", "title": "Learn Go in 30 Minutes",
                "siteKind": "video", "siteRef": "dQw4w9WgXcQ", "from": "BlissWork",
            },
        }]},
    )
    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": desktop_token},
        json={"events": [{
            "action": "app.focus", "category": "app",
            "occurredAt": _iso(occurred),
            "targetKind": "app", "targetId": "Google Chrome", "durationMs": 840_000,
            "detail": {"from": "BlissWork"},
        }]},
    )

    as_user(alice, "member")
    r = await client.get("/telemetry/members/me/activity-sessions")
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["sessions"]) == 1
    s = body["sessions"][0]
    assert s["kind"] == "app+site"
    assert s["appName"] == "Google Chrome"
    assert s["domain"] == "youtube.com"
    assert s["title"] == "Learn Go in 30 Minutes"
    assert s["durationMs"] == 840_000
    assert s["detail"]["url"] == "youtube.com/watch?v=dQw4w9WgXcQ"
    assert s["detail"]["siteKind"] == "video"
    assert s["detail"]["siteRef"] == "dQw4w9WgXcQ"


def _iso(nanos: str) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(int(nanos) / 1_000_000_000, tz=timezone.utc).isoformat()


async def test_a_desktop_only_standalone_session_is_readable_too(client):
    alice = str(uuid.uuid4())
    as_user(alice, "member")
    desktop_token = await _pair(client, "desktop")

    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": desktop_token},
        json={"events": [{
            "action": "app.focus", "category": "app",
            "occurredAt": _iso(_recent_nanos(seconds_ago=600)),
            "targetKind": "app", "targetId": "Visual Studio Code", "durationMs": 1_865_000,
            "detail": {"title": "activity.go - BlissWork", "from": "Google Chrome"},
        }]},
    )

    as_user(alice, "member")
    body = (await client.get("/telemetry/members/me/activity-sessions")).json()
    assert len(body["sessions"]) == 1
    s = body["sessions"][0]
    assert s["kind"] == "app"
    assert s["appName"] == "Visual Studio Code"
    assert s["domain"] is None
    assert s["detail"]["title"] == "activity.go - BlissWork"


async def test_a_member_cannot_read_someone_elses_activity_sessions(client):
    bob = str(uuid.uuid4())
    as_user(bob, "member")
    r = await client.get(f"/telemetry/members/{uuid.uuid4()}/activity-sessions")
    assert r.status_code == 403


async def test_an_admin_can_read_anyones_activity_sessions(client):
    bob = str(uuid.uuid4())
    as_user(bob, "member")
    desktop_token = await _pair(client, "desktop")
    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": desktop_token},
        json={"events": [{
            "action": "app.focus", "category": "app",
            "occurredAt": _iso(_recent_nanos(seconds_ago=60)),
            "targetKind": "app", "targetId": "Slack", "durationMs": 90_000,
        }]},
    )
    alice = str(uuid.uuid4())
    as_user(alice, "org_admin")
    r = await client.get(f"/telemetry/members/{bob}/activity-sessions")
    assert r.status_code == 200
    assert r.json()["sessions"]


async def test_pagination_cursor_round_trips(client):
    alice = str(uuid.uuid4())
    as_user(alice, "member")
    desktop_token = await _pair(client, "desktop")
    for i in range(3):
        await client.post(
            "/telemetry/ingest/agent",
            headers={"X-Ingest-Token": desktop_token},
            json={"events": [{
                "action": "app.focus", "category": "app",
                "occurredAt": _iso(_recent_nanos(seconds_ago=300 - i * 60)),
                "targetKind": "app", "targetId": f"App{i}", "durationMs": 30_000,
            }]},
        )

    as_user(alice, "member")
    first_page = (await client.get("/telemetry/members/me/activity-sessions?limit=2")).json()
    assert len(first_page["sessions"]) == 2
    assert first_page["nextCursor"]

    second_page = (
        await client.get(
            f"/telemetry/members/me/activity-sessions?limit=2&cursor={first_page['nextCursor']}"
        )
    ).json()
    assert len(second_page["sessions"]) >= 1
    first_ids = {s["id"] for s in first_page["sessions"]}
    second_ids = {s["id"] for s in second_page["sessions"]}
    assert first_ids.isdisjoint(second_ids)
