"""Desktop application spans, end to end through the HTTP API: beacon in,
Outside Activity and Top Applications out, both read from the same stored rows.

The payload below is exactly what the desktop client emits for each span
(packages/app/src/lib/activitySpans.ts: `app.focus` / category 'app' /
targetKind 'app' / targetId = executable name / durationMs, and `os.idle` for an
idle span). The cases mirror the span machine's output for: an external app,
BlissWork itself, app → BlissWork → app, an idle span, a very short span, several
applications in one period, and the same executable reported in two casings.

    TELEMETRY_DATABASE_URL=postgresql://telemetry_user:pw@host/telemetrydb \\
        python -m pytest tests/integration/test_top_apps_and_outside_in_app.py -q
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="module")]

if not os.getenv("TELEMETRY_DATABASE_URL"):
    pytest.skip("needs a live Postgres (TELEMETRY_DATABASE_URL)", allow_module_level=True)

httpx = pytest.importorskip("httpx")
pytest_asyncio = pytest.importorskip("pytest_asyncio")

from app.auth import Principal, require_principal  # noqa: E402
from app.main import app  # noqa: E402

ORG = str(uuid.uuid4())
ALICE = str(uuid.uuid4())
BOB = str(uuid.uuid4())
MINUTE = 60_000


def span(name: str, minutes_ago: int, duration_ms: int) -> dict:
    at = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return {
        "action": "app.focus", "category": "app", "targetKind": "app", "targetId": name,
        "durationMs": duration_ms, "occurredAt": at.isoformat().replace("+00:00", "Z"),
    }


# Newest last, as one run of the tracker would deliver them.
ALICE_EVENTS = [
    span("chrome.exe", 50, 20 * MINUTE),
    span("BlissWork.exe", 30, 15 * MINUTE),      # app → BlissWork
    span("chrome.exe", 15, 5 * MINUTE),          # BlissWork → app
    span("Code.exe", 10, 8 * MINUTE),
    span("OUTLOOK.EXE", 8, 2 * MINUTE),
    span("outlook.exe", 6, 1 * MINUTE),          # same app, other casing
    span("ms-teams.exe", 4, 64),                 # a flicker
    {"action": "os.idle", "category": "engagement", "durationMs": 5 * MINUTE,
     "occurredAt": (datetime.now(timezone.utc) - timedelta(minutes=3)).isoformat().replace("+00:00", "Z")},
]
BOB_EVENTS = [span("excel.exe", 5, 40 * MINUTE)]


@pytest_asyncio.fixture(loop_scope="module", scope="module")
async def client():
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            for user, events in ((ALICE, ALICE_EVENTS), (BOB, BOB_EVENTS)):
                app.dependency_overrides[require_principal] = lambda u=user: Principal(
                    user_id=u, org_id=ORG, roles=["member"], username="u"
                )
                r = await c.post("/telemetry/beacon", json={"source": "desktop", "events": events})
                assert r.status_code == 200, r.text
                assert r.json()["accepted"] == len(events)
            app.dependency_overrides[require_principal] = lambda: Principal(
                user_id=ALICE, org_id=ORG, roles=["member"], username="alice"
            )
            yield c
    app.dependency_overrides.clear()


async def outside(client) -> list[dict]:
    r = await client.get("/telemetry/members/me/timeline", params={"limit": 200, "category": "outside"})
    assert r.status_code == 200, r.text
    return r.json()["entries"]


async def summary(client, **params) -> dict:
    r = await client.get("/telemetry/members/me/summary", params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def test_top_applications_aggregate_the_persisted_spans(client):
    apps = (await summary(client))["topApps"]
    got = {a["key"]: (a["valueMs"], a["count"]) for a in apps}
    assert got == {
        "chrome.exe": (25 * MINUTE, 2),
        "code.exe": (8 * MINUTE, 1),
        "outlook.exe": (3 * MINUTE, 2),   # two casings, one application
        "ms-teams.exe": (64, 1),          # a short span is not discarded
    }
    assert [a["key"] for a in apps] == ["chrome.exe", "code.exe", "outlook.exe", "ms-teams.exe"]


async def test_blisswork_is_in_app_not_an_outside_application(client):
    assert "blisswork.exe" not in {a["key"] for a in (await summary(client))["topApps"]}
    assert "BlissWork.exe" not in {e["targetId"] for e in await outside(client)}


async def test_blisswork_time_is_still_in_the_record(client):
    # Left out of the two outside views, not deleted: the unfiltered record keeps it.
    r = await client.get("/telemetry/members/me/timeline", params={"limit": 200})
    assert "BlissWork.exe" in {e["targetId"] for e in r.json()["entries"]}


async def test_outside_activity_lists_the_same_applications_as_top_applications(client):
    spans = [e for e in await outside(client) if e["action"] == "app.focus"]
    assert {e["targetId"].lower() for e in spans} == {a["key"] for a in (await summary(client))["topApps"]}
    # And the totals agree, span for span.
    per_app: dict[str, int] = {}
    for e in spans:
        per_app[e["targetId"].lower()] = per_app.get(e["targetId"].lower(), 0) + e["durationMs"]
    assert per_app == {a["key"]: a["valueMs"] for a in (await summary(client))["topApps"]}


async def test_idle_is_outside_activity_but_never_an_application(client):
    assert "os.idle" in {e["action"] for e in await outside(client)}
    assert all(a["key"] != "os.idle" for a in (await summary(client))["topApps"])


async def test_only_the_requested_members_applications(client):
    assert "excel.exe" not in {a["key"] for a in (await summary(client))["topApps"]}
    assert "excel.exe" not in {e["targetId"] for e in await outside(client)}


async def test_the_date_range_bounds_top_applications(client):
    assert (await summary(client, **{"from": "2020-01-01", "to": "2020-01-31"}))["topApps"] == []
    today = datetime.now(timezone.utc).date()
    wide = await summary(client, **{"from": (today - timedelta(days=2)).isoformat(), "to": today.isoformat()})
    assert {a["key"] for a in wide["topApps"]} >= {"chrome.exe", "code.exe"}


async def test_the_other_members_applications_are_theirs(client):
    app.dependency_overrides[require_principal] = lambda: Principal(
        user_id=BOB, org_id=ORG, roles=["member"], username="bob"
    )
    apps = (await summary(client))["topApps"]
    assert [(a["key"], a["valueMs"]) for a in apps] == [("excel.exe", 40 * MINUTE)]
