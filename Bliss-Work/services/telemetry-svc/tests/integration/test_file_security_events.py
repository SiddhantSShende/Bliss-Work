"""A chat or channel file open/download is recorded twice, on purpose, and ONCE each:
as the engagement row the activity timeline and analytics read, and as a separate
security row (`file.opened` / `file.downloaded`) the server derives from it — same
actor, time, session (hence IP / device / platform), target and context.

    TELEMETRY_DATABASE_URL=postgresql://telemetry_user:pw@host/telemetrydb \\
        python -m pytest tests/integration/test_file_security_events.py -q
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="module")]

if not os.getenv("TELEMETRY_DATABASE_URL"):
    pytest.skip("needs a live Postgres (TELEMETRY_DATABASE_URL)", allow_module_level=True)

httpx = pytest.importorskip("httpx")
pytest_asyncio = pytest.importorskip("pytest_asyncio")

from sqlalchemy import text  # noqa: E402

from app.auth import Principal, require_principal  # noqa: E402
from app.db import session, set_bypass_rls  # noqa: E402
from app.jobs import rollup  # noqa: E402
from app.main import app  # noqa: E402

ORG = str(uuid.uuid4())
USER = str(uuid.uuid4())
SESSION = str(uuid.uuid4())

DM = {"filename": "image.png", "conversation": "cv-1", "contextKind": "direct",
      "contextId": "cv-1", "contextName": "Divya Bhamri"}
CH = {"filename": "Report.pdf", "channel": "ch-1", "contextKind": "channel",
      "contextId": "ch-1", "contextName": "GRC Development"}
LEGACY = {"filename": "old.pdf", "channel": "ch-0"}


def ev(action, detail, *, surface="chats", cid=None, category="engagement"):
    return {
        "action": action, "category": category, "surface": surface, "targetKind": "attachment",
        "targetId": f"att-{uuid.uuid4().hex[:6]}", "detail": detail,
        "clientEventId": cid or str(uuid.uuid4()),
    }


@pytest_asyncio.fixture(loop_scope="module", scope="module")
async def client():
    async with app.router.lifespan_context(app):
        app.dependency_overrides[require_principal] = lambda: Principal(
            user_id=USER, org_id=ORG, roles=["member"], username="u"
        )
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            yield c
    app.dependency_overrides.clear()


async def beacon(client, events, source="web"):
    r = await client.post("/telemetry/beacon", json={"sessionId": SESSION, "source": source, "events": events})
    assert r.status_code == 200, r.text
    return r.json()


async def timeline(client, category=None):
    params = {"limit": 200, **({"category": category} if category else {})}
    r = await client.get("/telemetry/members/me/timeline", params=params)
    assert r.status_code == 200, r.text
    return r.json()["entries"]


def only(entries, action):
    return [e for e in entries if e["action"] == action]


async def test_a_dm_open_is_an_activity_row_and_a_separate_security_row(client):
    opened = ev("attachment.opened", DM)
    ack = await beacon(client, [opened])
    # One event offered, one accepted — the derived row is ours, not the client's.
    assert ack["accepted"] == 1

    work = [e for e in await timeline(client, "engagement") if e["targetId"] == opened["targetId"]]
    sec = [e for e in await timeline(client, "security") if e["targetId"] == opened["targetId"]]
    assert [e["action"] for e in work] == ["attachment.opened"]
    assert [e["action"] for e in sec] == ["file.opened"]
    assert sec[0]["category"] == "security"
    # Same facts, including the chat context, in both.
    for e in (work[0], sec[0]):
        assert e["detail"] == DM and e["surface"] == "chats" and e["targetKind"] == "attachment"
    assert sec[0]["occurredAt"] == work[0]["occurredAt"] and sec[0]["source"] == work[0]["source"] == "web"


async def test_a_channel_download_likewise(client):
    dl = ev("attachment.downloaded", CH, surface="channels")
    await beacon(client, [dl], source="desktop")

    sec = [e for e in await timeline(client, "security") if e["targetId"] == dl["targetId"]]
    assert [e["action"] for e in sec] == ["file.downloaded"]
    assert sec[0]["detail"] == CH and sec[0]["source"] == "desktop"


async def test_the_security_row_shares_the_activity_rows_session(client):
    # The session is where IP, user agent and platform are recorded, so sharing it IS
    # carrying that metadata.
    e = ev("attachment.opened", DM)
    await beacon(client, [e])
    async with session() as db:
        await set_bypass_rls(db)
        rows = (await db.execute(
            text("SELECT category, action, session_id::text AS sid FROM activity_events "
                 "WHERE org_id = :o AND target_id = :t ORDER BY category"),
            {"o": ORG, "t": e["targetId"]},
        )).all()
    assert [(r.category, r.action) for r in rows] == [("engagement", "attachment.opened"), ("security", "file.opened")]
    assert rows[0].sid == rows[1].sid == SESSION


async def test_the_everything_view_shows_the_act_once(client):
    e = ev("attachment.opened", DM)
    await beacon(client, [e])
    everything = [x for x in await timeline(client, None) if x["targetId"] == e["targetId"]]
    assert [x["action"] for x in everything] == ["attachment.opened"]
    # …and no view that is not Security picks up the derived row.
    for cat in ("engagement", "navigation", "auth", "app", "outside"):
        assert not [x for x in await timeline(client, cat) if x["action"].startswith("file.")], cat


async def test_a_retried_beacon_adds_neither_row_again(client):
    e = ev("attachment.opened", CH, surface="channels", cid="11111111-1111-4111-8111-111111111111")
    await beacon(client, [e])
    again = await beacon(client, [e])
    assert again["accepted"] == 0

    assert len([x for x in await timeline(client, "engagement") if x["targetId"] == e["targetId"]]) == 1
    assert len([x for x in await timeline(client, "security") if x["targetId"] == e["targetId"]]) == 1


async def test_a_client_cannot_submit_the_security_actions_itself(client):
    forged = ev("file.opened", CH, category="security", surface="channels")
    ack = await beacon(client, [forged])
    assert ack["accepted"] == 0
    assert not [x for x in await timeline(client, "security") if x["targetId"] == forged["targetId"]]


async def test_a_legacy_event_without_context_is_stored_and_mirrored_as_it_was(client):
    e = ev("attachment.opened", LEGACY, surface="channels")
    await beacon(client, [e])
    sec = [x for x in await timeline(client, "security") if x["targetId"] == e["targetId"]]
    assert len(sec) == 1 and sec[0]["detail"] == LEGACY


async def test_existing_security_events_are_untouched_and_beside_the_new_ones(client):
    shot = {"action": "screenshot.attempted", "category": "security", "detail": {"context": "a chat"},
            "clientEventId": str(uuid.uuid4())}
    await beacon(client, [shot], source="desktop")
    actions = {x["action"] for x in await timeline(client, "security")}
    assert {"screenshot.attempted", "file.opened", "file.downloaded"} <= actions


async def test_other_activity_derives_nothing(client):
    before = len(await timeline(client, "security"))
    await beacon(client, [{"action": "message.sent", "category": "engagement", "surface": "chats",
                           "clientEventId": str(uuid.uuid4())},
                          {"action": "route.enter", "category": "navigation", "surface": "tasks",
                           "clientEventId": str(uuid.uuid4())}])
    assert len(await timeline(client, "security")) == before


async def test_analytics_counts_a_file_act_once(client):
    async with session() as db:
        await set_bypass_rls(db)
        await db.execute(text("DELETE FROM activity_daily WHERE org_id = :o"), {"o": ORG})
        await db.commit()
    day = datetime.now(ZoneInfo(rollup._TZ)).date()
    await rollup.rollup_day(day)

    async with session() as db:
        await set_bypass_rls(db)
        r = (await db.execute(
            text("SELECT events_count, by_action FROM activity_daily "
                 "WHERE org_id = :o AND user_id = :u AND day = :d"),
            {"o": ORG, "u": USER, "d": day},
        )).one()
        total = (await db.execute(
            text("SELECT count(*) FROM activity_events WHERE org_id = :o AND user_id = :u "
                 "AND action NOT IN ('file.opened','file.downloaded')"),
            {"o": ORG, "u": USER},
        )).scalar()
    assert r.events_count == total
    assert "file.opened" not in r.by_action and "file.downloaded" not in r.by_action
    assert r.by_action["attachment.opened"] >= 1
