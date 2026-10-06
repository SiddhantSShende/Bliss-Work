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


async def test_outside_returns_exactly_the_desktop_activity(client):
    got = await actions(client, "outside")
    assert set(got) == OUTSIDE
    assert len(got) == len(OUTSIDE)


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
    assert await actions(client, "app") == ["app.focus"]
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
    assert len(seen) == len(set(seen)) == len(OUTSIDE)


async def test_app_spans_are_stored_with_the_raw_executable_name(client):
    r = await client.get("/telemetry/members/me/timeline", params={"category": "outside", "limit": 200})
    span = next(e for e in r.json()["entries"] if e["action"] == "app.focus")
    assert span["targetId"] == "chrome.exe"
    assert span["category"] == "app"
