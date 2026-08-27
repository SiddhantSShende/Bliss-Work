"""Beacon in, timeline out — through the real ASGI app against a real Postgres.

Marked `integration` because it needs a database: the behaviours it pins are
exactly the ones a mock cannot reproduce — RLS scoping, partition routing, the
session upsert, and the `resolve_subject` gate that is the whole transparency
model.

JWT verification is stubbed via FastAPI's dependency_overrides (the alternative
is standing up auth-svc and a JWKS endpoint to test something that is not the
subject of these tests). Everything downstream of the principal is real.

    TELEMETRY_DATABASE_URL=postgresql://telemetry_user:pw@host/telemetrydb \\
        python -m pytest tests/integration -q
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

# ONE event loop for the whole module, and the app's lifespan entered exactly
# once inside it. The SQLAlchemy engine and its connection pool are module-level
# singletons bound to the loop that created them, so a per-test loop leaves the
# previous test's pooled connections orphaned — which surfaces as
# "Event loop is closed" during teardown rather than as anything to do with the
# behaviour under test.
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


def as_user(user_id: str, *roles: str):
    """Stub JWT verification. Everything downstream of the principal is real —
    standing up auth-svc and a JWKS endpoint would test something these tests
    are not about."""
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


async def test_beacon_opens_a_session_and_records_activity(client):
    as_user(ALICE, "member")
    r = await client.post("/telemetry/beacon", json={
        "source": "web", "activeMs": 60000, "idleMs": 0,
        "events": [
            {"action": "route.enter", "category": "navigation", "surface": "tasks"},
            {"action": "route.dwell", "category": "navigation", "surface": "tasks",
             "durationMs": 45000},
        ],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["accepted"] == 2
    session_id = body["sessionId"]
    assert session_id

    # A second beat must extend the SAME session, not open another.
    r2 = await client.post("/telemetry/beacon", json={
        "sessionId": session_id, "source": "web", "activeMs": 60000, "events": [],
    })
    assert r2.json()["sessionId"] == session_id

    sessions = (await client.get(f"/telemetry/members/{ALICE}/sessions")).json()["sessions"]
    assert len(sessions) == 1
    assert sessions[0]["activeMs"] == 120000
    assert sessions[0]["endedAt"] is None


async def test_a_member_reads_their_own_timeline_via_me(client):
    as_user(ALICE, "member")
    await client.post("/telemetry/beacon", json={
        "source": "web", "events": [{"action": "route.enter", "surface": "chats"}],
    })
    r = await client.get("/telemetry/members/me/timeline")
    assert r.status_code == 200
    assert any(e["surface"] == "chats" for e in r.json()["entries"])


async def test_a_member_cannot_read_someone_elses_timeline(client):
    as_user(ALICE, "member")
    r = await client.get(f"/telemetry/members/{BOB}/timeline")
    assert r.status_code == 403


async def test_an_admin_can_read_anyone(client):
    as_user(BOB, "member")
    await client.post("/telemetry/beacon", json={
        "source": "web", "events": [{"action": "route.enter", "surface": "tasks"}],
    })
    as_user(ALICE, "org_admin")
    r = await client.get(f"/telemetry/members/{BOB}/timeline")
    assert r.status_code == 200
    assert r.json()["entries"]


async def test_the_roster_is_admin_only(client):
    as_user(ALICE, "member")
    assert (await client.get("/telemetry/members")).status_code == 403
    as_user(ALICE, "org_admin")
    assert (await client.get("/telemetry/members")).status_code == 200


async def test_a_client_cannot_forge_a_verified_row(client):
    # `source` is taken from the payload's declared client type and `category`
    # is clamped to the client-allowed set — a client claiming category "auth"
    # would be asserting a sign-in that never happened.
    as_user(ALICE, "member")
    await client.post("/telemetry/beacon", json={
        "source": "web",
        "events": [{"action": "login", "category": "auth"}],
    })
    entries = (await client.get("/telemetry/members/me/timeline")).json()["entries"]
    forged = [e for e in entries if e["action"] == "login"]
    assert forged, "the row should still be recorded"
    assert forged[0]["source"] == "web", "never 'server'"
    assert forged[0]["category"] == "navigation", "'auth' must be rejected"


async def test_ending_a_session_closes_it_precisely(client):
    as_user(ALICE, "member")
    started = (await client.post("/telemetry/beacon", json={
        "source": "web", "activeMs": 1000, "events": [],
    })).json()["sessionId"]
    await client.post("/telemetry/beacon", json={
        "sessionId": started, "source": "web", "ended": True, "events": [],
    })
    sessions = (await client.get("/telemetry/members/me/sessions")).json()["sessions"]
    closed = [s for s in sessions if s["id"] == started]
    assert closed and closed[0]["endedAt"] is not None
    assert closed[0]["endReason"] == "disconnect"


async def test_oversized_batches_are_rejected_not_truncated(client):
    as_user(ALICE, "member")
    r = await client.post("/telemetry/beacon", json={
        "source": "web",
        "events": [{"action": "x"} for _ in range(101)],
    })
    assert r.status_code == 422


async def test_summary_reports_todays_partial_before_any_rollup(client):
    # The nightly rollup runs at 01:30 for the PREVIOUS day, so today never has
    # one. A dashboard that showed nothing until tomorrow would be useless on the
    # day anyone actually looks at it.
    as_user(ALICE, "member")
    await client.post("/telemetry/beacon", json={
        "source": "web", "activeMs": 90000, "events": [],
    })
    s = (await client.get("/telemetry/members/me/summary")).json()
    assert s["totalActiveMs"] >= 90000
    assert s["days"]


# ── Agent pairing + agent ingest ─────────────────────────────────────────────
async def test_a_paired_agent_can_report_activity(client):
    as_user(ALICE, "member")
    minted = (await client.post("/telemetry/tokens?kind=desktop&label=Work laptop")).json()
    assert minted["token"], "the raw secret is returned exactly once"

    r = await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": minted["token"]},
        json={"events": [{
            "action": "app.focus", "category": "app", "targetKind": "app",
            "targetId": "Google Chrome", "durationMs": 300000,
        }]},
    )
    assert r.status_code == 202, r.text
    assert r.json()["accepted"] == 1

    entries = (await client.get("/telemetry/members/me/timeline")).json()["entries"]
    app_rows = [e for e in entries if e["action"] == "app.focus"]
    assert app_rows and app_rows[0]["source"] == "desktop"
    assert app_rows[0]["targetId"] == "Google Chrome"


async def test_a_retried_batch_is_not_double_counted(client):
    """Regression test for migration 0006: a client that resends a batch after
    losing the response to a network blip (activity-agent.ts's and
    background.ts's flush() both re-queue on any !res.ok or thrown error, with
    no way to tell "never arrived" apart from "arrived, ack lost") must not
    produce two rows for the same span.
    """
    as_user(ALICE, "member")
    minted = (await client.post("/telemetry/tokens?kind=desktop&label=Retry laptop")).json()
    # occurredAt set explicitly to a REALISTIC recent moment — a real agent
    # always sends one (activity-agent.ts's push() stamps every event before
    # it's ever queued), and it's always recent (the span just closed), never
    # far enough in the past to fall outside clamp_occurred_at's backdate
    # window. A timestamp old enough to BE clamped is clamped relative to a
    # fresh `now()` computed on every request, so it would (correctly, if
    # unintuitively) differ by microseconds between the original send and the
    # retry — this test is about the realistic case, where clamping never
    # engages and occurredAt round-trips byte-identical.
    occurred_at = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
    # A distinct targetId — this module's fixtures share ALICE/the client
    # across tests, and "Google Chrome" is already written by
    # test_a_paired_agent_can_report_activity above.
    batch = {"events": [{
        "action": "app.focus", "category": "app", "targetKind": "app",
        "targetId": "Retry Test App", "durationMs": 300000,
        "occurredAt": occurred_at,
        "clientEventId": "retry-regression-abc",
    }]}

    first = await client.post(
        "/telemetry/ingest/agent", headers={"X-Ingest-Token": minted["token"]}, json=batch,
    )
    assert first.status_code == 202
    assert first.json()["accepted"] == 1

    # The SAME batch, same clientEventId — exactly what a real retry resends.
    retry = await client.post(
        "/telemetry/ingest/agent", headers={"X-Ingest-Token": minted["token"]}, json=batch,
    )
    assert retry.status_code == 202
    assert retry.json()["accepted"] == 0, "a retried clientEventId must be a no-op, not a second row"

    entries = (await client.get("/telemetry/members/me/timeline")).json()["entries"]
    matching = [e for e in entries if e["targetId"] == "Retry Test App" and e["action"] == "app.focus"]
    assert len(matching) == 1, "exactly one row, not one per send"


async def test_a_batch_with_no_clientEventId_is_never_deduped(client):
    """Older/unpatched clients send no clientEventId — those rows must insert
    normally every time, not collide with each other via a shared NULL."""
    as_user(ALICE, "member")
    minted = (await client.post("/telemetry/tokens?kind=desktop&label=Old laptop")).json()
    event = {
        "action": "app.focus", "category": "app", "targetKind": "app", "targetId": "Slack",
    }

    for _ in range(2):
        r = await client.post(
            "/telemetry/ingest/agent", headers={"X-Ingest-Token": minted["token"]},
            json={"events": [event]},
        )
        assert r.status_code == 202
        assert r.json()["accepted"] == 1

    entries = (await client.get("/telemetry/members/me/timeline")).json()["entries"]
    matching = [e for e in entries if e["targetId"] == "Slack" and e["action"] == "app.focus"]
    assert len(matching) == 2, "two genuinely separate spans, neither deduped against the other"


async def test_the_raw_secret_is_never_returned_again(client):
    as_user(ALICE, "member")
    await client.post("/telemetry/tokens?kind=extension")
    listed = (await client.get("/telemetry/tokens")).json()
    assert listed
    assert all("token" not in t for t in listed)


async def test_an_unknown_agent_token_is_rejected(client):
    r = await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": "not-a-real-token"},
        json={"events": []},
    )
    assert r.status_code == 401


async def test_ingest_without_a_token_is_rejected(client):
    r = await client.post("/telemetry/ingest/agent", json={"events": []})
    assert r.status_code == 401


async def test_a_revoked_token_stops_working(client):
    as_user(ALICE, "member")
    minted = (await client.post("/telemetry/tokens?kind=extension")).json()
    await client.delete(f"/telemetry/tokens/{minted['id']}")
    r = await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": minted["token"]},
        json={"events": [{"action": "site.visit", "category": "site"}]},
    )
    assert r.status_code == 401


async def test_an_agent_cannot_write_for_someone_else(client):
    # The org and user come from the TOKEN's row, never the payload — a stolen
    # token can only ever write activity for the person who minted it.
    as_user(BOB, "member")
    minted = (await client.post("/telemetry/tokens?kind=extension")).json()
    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": minted["token"]},
        json={"events": [{
            "action": "site.visit", "category": "site",
            "targetKind": "site", "targetId": "example.com",
            # Even if a hostile agent invents these, they are not read.
            "userId": ALICE, "orgId": "00000000-0000-4000-8000-000000000000",
        }]},
    )
    as_user(BOB, "member")
    bob = (await client.get("/telemetry/members/me/timeline")).json()["entries"]
    assert any(e["targetId"] == "example.com" for e in bob)

    as_user(ALICE, "member")
    alice = (await client.get("/telemetry/members/me/timeline")).json()["entries"]
    assert not any(e["targetId"] == "example.com" for e in alice)


async def test_an_agent_cannot_claim_a_server_observed_category(client):
    as_user(ALICE, "member")
    minted = (await client.post("/telemetry/tokens?kind=desktop")).json()
    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": minted["token"]},
        json={"events": [{"action": "login", "category": "auth"}]},
    )
    entries = (await client.get("/telemetry/members/me/timeline")).json()["entries"]
    forged = [e for e in entries if e["action"] == "login" and e["source"] == "desktop"]
    assert forged, "the row is still recorded"
    assert forged[0]["category"] == "app", "'auth' must be clamped away"


# ── Automatic provisioning (deviceKey get-or-create + status pings) ─────────
async def test_provisioning_with_a_device_key_is_idempotent(client):
    """A login-time auto-provision call must be safe to repeat: the SAME
    device asking again gets told "already provisioned" (token null), not a
    second live secret for the same installation."""
    as_user(ALICE, "member")
    first = (await client.post("/telemetry/tokens?kind=desktop&deviceKey=device-abc")).json()
    assert first["token"], "first call for this device mints a real secret"

    second = (await client.post("/telemetry/tokens?kind=desktop&deviceKey=device-abc")).json()
    assert second["token"] is None, "a repeat call for the same device must not mint again"
    assert second["id"] == first["id"]

    listed = (await client.get("/telemetry/tokens")).json()
    matching = [t for t in listed if t["id"] == first["id"]]
    assert len(matching) == 1, "still exactly one row for this device"


async def test_provisioning_without_a_device_key_still_mints_every_time(client):
    """Regression guard: today's manual 'Connect' buttons never send a
    deviceKey and must keep minting a fresh token on every call, so a person
    with several desktops keeps one token per machine."""
    as_user(ALICE, "member")
    a = (await client.post("/telemetry/tokens?kind=desktop&label=No key A")).json()
    b = (await client.post("/telemetry/tokens?kind=desktop&label=No key B")).json()
    assert a["token"] and b["token"]
    assert a["id"] != b["id"]


async def test_a_different_device_key_gets_its_own_token(client):
    """Two distinct devices for the same person are two distinct, independently
    revocable rows — multi-device support survives auto-provisioning."""
    as_user(ALICE, "member")
    laptop = (await client.post("/telemetry/tokens?kind=desktop&deviceKey=laptop-1")).json()
    desktop = (await client.post("/telemetry/tokens?kind=desktop&deviceKey=desktop-1")).json()
    assert laptop["token"] and desktop["token"]
    assert laptop["id"] != desktop["id"]

    await client.delete(f"/telemetry/tokens/{laptop['id']}")
    r = await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": desktop["token"]},
        json={"events": [{"action": "app.focus", "category": "app", "targetId": "Still Works"}]},
    )
    assert r.status_code == 202, "revoking one device's token must not affect the other"


async def test_status_ping_updates_last_seen_without_writing_activity(client):
    """CONNECTED must be provable before TRACKING_ACTIVE is: a status ping is
    the 'the credential works' signal, and must never itself be an activity
    row — otherwise 'paired but not tracking yet' would leave a data trail
    indistinguishable from actually tracking."""
    as_user(ALICE, "member")
    minted = (await client.post("/telemetry/tokens?kind=desktop&deviceKey=ping-device")).json()

    r = await client.post(
        "/telemetry/tokens/status",
        headers={"X-Ingest-Token": minted["token"]},
        json={"version": "1.2.3", "platform": "macOS"},
    )
    assert r.status_code == 204

    listed = (await client.get("/telemetry/tokens")).json()
    row = next(t for t in listed if t["id"] == minted["id"])
    assert row["lastSeenAt"] is not None
    assert row["lastUsedAt"] is None, "a status ping is not activity"
    assert row["agentVersion"] == "1.2.3"
    assert row["platform"] == "macOS"


async def test_ingest_bumps_both_last_used_and_last_seen(client):
    as_user(ALICE, "member")
    minted = (await client.post("/telemetry/tokens?kind=desktop&deviceKey=ingest-device")).json()
    await client.post(
        "/telemetry/ingest/agent",
        headers={"X-Ingest-Token": minted["token"]},
        json={"events": [{"action": "app.focus", "category": "app", "targetId": "X"}]},
    )
    listed = (await client.get("/telemetry/tokens")).json()
    row = next(t for t in listed if t["id"] == minted["id"])
    assert row["lastUsedAt"] is not None
    assert row["lastSeenAt"] is not None


async def test_status_ping_rejects_an_unknown_or_missing_token(client):
    r = await client.post(
        "/telemetry/tokens/status",
        headers={"X-Ingest-Token": "not-a-real-token"},
        json={},
    )
    assert r.status_code == 401

    r2 = await client.post("/telemetry/tokens/status", json={})
    assert r2.status_code == 401


async def test_status_ping_rejects_a_revoked_token(client):
    as_user(ALICE, "member")
    minted = (await client.post("/telemetry/tokens?kind=extension&deviceKey=revoked-device")).json()
    await client.delete(f"/telemetry/tokens/{minted['id']}")
    r = await client.post(
        "/telemetry/tokens/status",
        headers={"X-Ingest-Token": minted["token"]},
        json={},
    )
    assert r.status_code == 401
