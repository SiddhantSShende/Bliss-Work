"""The timeline's `outside` view: desktop activity detected outside BlissWork.

`app.focus` is stored as category 'app', but the focus / blur / idle readings are
stored as 'engagement' — the same category as work done in the app — so no single
stored category is "outside". These tests pin that the filter is answered from
the stored rows (category + action) in SQL, that it does not disturb the existing
category filters, and that the rows themselves are stored exactly as before.

    TELEMETRY_DATABASE_URL=postgresql://telemetry_user:pw@host/telemetrydb \\
        python -m pytest tests/integration/test_timeline_outside_filter.py -q
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

from app.auth import Principal, require_principal  # noqa: E402
from app.main import app  # noqa: E402

ORG = str(uuid.uuid4())
ALICE = str(uuid.uuid4())

EVENTS = [
    # Outside BlissWork: an application in front, away/back, and both idle kinds.
    {"action": "app.focus", "category": "app", "targetKind": "app", "targetId": "chrome.exe", "durationMs": 60000},
    # The applications people actually name when they report this: File Explorer,
    # Excel and VS Code are executable names to the store, like any other.
    {"action": "app.focus", "category": "app", "targetKind": "app", "targetId": "explorer.exe", "durationMs": 15000},
    {"action": "app.focus", "category": "app", "targetKind": "app", "targetId": "EXCEL.EXE", "durationMs": 120000},
    {"action": "app.focus", "category": "app", "targetKind": "app", "targetId": "Code.exe", "durationMs": 90000},
    {"action": "blur", "category": "engagement"},
    {"action": "focus", "category": "engagement"},
    {"action": "idle.start", "category": "engagement"},
    {"action": "idle.end", "category": "engagement"},
    {"action": "os.idle", "category": "engagement", "durationMs": 300000},
    # Inside BlissWork, one per remaining client-writable category.
    {"action": "task.completed", "category": "engagement"},
    {"action": "route.enter", "category": "navigation", "surface": "tasks"},
    {"action": "screenshot.attempted", "category": "security"},
]
OUTSIDE = {"app.focus", "blur", "focus", "idle.start", "idle.end", "os.idle"}
EXTERNAL_APPS = {"chrome.exe", "explorer.exe", "EXCEL.EXE", "Code.exe"}
N_OUTSIDE = sum(1 for e in EVENTS if e["action"] in OUTSIDE)


@pytest_asyncio.fixture(loop_scope="module", scope="module")
async def client():
    async with app.router.lifespan_context(app):
        app.dependency_overrides[require_principal] = lambda: Principal(
            user_id=ALICE, org_id=ORG, roles=["member"], username="alice"
        )
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            r = await c.post("/telemetry/beacon", json={"source": "desktop", "events": EVENTS})
            assert r.status_code == 200, r.text
            assert r.json()["accepted"] == len(EVENTS)
            yield c
    app.dependency_overrides.clear()


async def actions(client, category: str | None) -> list[str]:
    params = {"limit": 200, **({"category": category} if category else {})}
    r = await client.get("/telemetry/members/me/timeline", params=params)
    assert r.status_code == 200, r.text
    return [e["action"] for e in r.json()["entries"]]


async def entries(client, category: str | None) -> list[dict]:
    params = {"limit": 200, **({"category": category} if category else {})}
    r = await client.get("/telemetry/members/me/timeline", params=params)
    assert r.status_code == 200, r.text
    return r.json()["entries"]


async def test_outside_returns_exactly_the_desktop_activity(client):
    got = await actions(client, "outside")
    assert set(got) == OUTSIDE
    assert len(got) == N_OUTSIDE


async def test_outside_is_not_a_stored_category(client):
    # Everything is the unfiltered view and still holds every row.
    assert set(await actions(client, None)) == {e["action"] for e in EVENTS}
    r = await client.get("/telemetry/members/me/timeline", params={"limit": 200, "category": "outside"})
    assert {e["category"] for e in r.json()["entries"]} == {"app", "engagement"}


async def test_existing_category_filters_are_unchanged(client):
    assert set(await actions(client, "engagement")) == {
        "blur", "focus", "idle.start", "idle.end", "os.idle", "task.completed",
    }
    assert await actions(client, "navigation") == ["route.enter"]
    assert await actions(client, "security") == ["screenshot.attempted"]
    assert await actions(client, "app") == ["app.focus"] * len(EXTERNAL_APPS)
    assert await actions(client, "auth") == []


async def test_outside_pages_without_losing_or_repeating_rows(client):
    seen: list[str] = []
    cursor = None
    while True:
        params = {"limit": 2, "category": "outside", **({"cursor": cursor} if cursor else {})}
        body = (await client.get("/telemetry/members/me/timeline", params=params)).json()
        seen += [e["id"] for e in body["entries"]]
        cursor = body["nextCursor"]
        if not cursor:
            break
    assert len(seen) == len(set(seen)) == N_OUTSIDE


async def test_app_spans_are_stored_with_the_raw_executable_name(client):
    r = await client.get("/telemetry/members/me/timeline", params={"category": "outside", "limit": 200})
    span = next(e for e in r.json()["entries"] if e["targetId"] == "chrome.exe")
    assert span["action"] == "app.focus"
    assert span["category"] == "app"


async def test_every_external_application_is_listed_with_its_source_and_duration(client):
    spans = [e for e in await entries(client, "outside") if e["action"] == "app.focus"]
    assert {e["targetId"] for e in spans} == EXTERNAL_APPS
    assert {e["source"] for e in spans} == {"desktop"}
    sent = {e["targetId"]: e["durationMs"] for e in EVENTS if e["action"] == "app.focus"}
    assert {e["targetId"]: e["durationMs"] for e in spans} == sent


async def test_activity_inside_blisswork_is_not_outside(client):
    got = await actions(client, "outside")
    for inside in ("task.completed", "route.enter", "screenshot.attempted"):
        assert inside not in got


async def test_away_and_back_are_outside_and_the_inside_work_stays_out(client):
    got = await actions(client, "outside")
    assert "blur" in got and "focus" in got  # "Switched away from" / "Came back to" BlissWork
    assert "task.completed" not in got       # same stored category ('engagement'), different claim


async def test_everything_and_outside_agree_row_for_row(client):
    everything = await entries(client, None)
    outside = await entries(client, "outside")
    by_id = {e["id"]: e for e in everything}

    # The same rows, not look-alikes: every outside row IS an Everything row,
    # identical in every field, and nothing is listed twice.
    assert len({e["id"] for e in outside}) == len(outside)
    assert all(by_id[e["id"]] == e for e in outside)

    # Outside is exactly Everything restricted to the outside actions — and in
    # the same newest-first order, so the two tabs never disagree about sequence.
    expected = [e["id"] for e in everything if e["action"] in OUTSIDE]
    assert [e["id"] for e in outside] == expected
