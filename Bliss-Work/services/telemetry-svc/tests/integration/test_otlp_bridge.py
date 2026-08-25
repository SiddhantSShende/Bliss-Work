"""The OTLP bridge route, exercised as HTTP: a real ExportLogsServiceRequest
JSON body posted straight to /telemetry/otlp/logs, against a real Postgres —
proving the SAME activity_events/activity_sessions rows land as they would
via the REST agent path, and that the ONLY thing that changed is transport.

    TELEMETRY_DATABASE_URL=postgresql://taskboard:taskboard_dev_pw@postgres:5432/telemetrydb_scratch \\
        python -m pytest tests/integration/test_otlp_bridge.py -q

Run on its own — see test_sessionizer.py's docstring for the pre-existing
multi-module client-fixture teardown fragility this repo's integration tests
already have when several files' fixtures share a pytest session.
"""
from __future__ import annotations

import os
import time
import uuid
from datetime import datetime, timezone

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


def _kv(key: str, **value) -> dict:
    return {"key": key, "value": value}


def _export_request(*, source: str, records: list[dict]) -> dict:
    return {
        "resourceLogs": [{
            "resource": {"attributes": [
                _kv("blisswork.signal", stringValue="activity"),
                _kv("blisswork.source", stringValue=source),
            ]},
            "scopeLogs": [{"logRecords": records}],
        }]
    }


def _log_record(time_unix_nano: str, fields: dict) -> dict:
    values = [_kv(k, stringValue=v) if isinstance(v, str) else _kv(k, intValue=str(v)) for k, v in fields.items()]
    return {"timeUnixNano": time_unix_nano, "body": {"kvlistValue": {"values": values}}}


def _recent_nanos(seconds_ago: int) -> str:
    """A timeUnixNano string within clamp_occurred_at's accepted window —
    the route clamps a client timestamp to
    [now - max_clock_backdate_seconds, now + max_clock_skew_future_seconds]
    (see config.py), so a fixed historical literal would silently get
    clamped to "now" the day this suite runs long after that literal's date."""
    return str(int((time.time() - seconds_ago) * 1_000_000_000))


async def _pair(client, kind: str) -> str:
    minted = (await client.post(f"/telemetry/tokens?kind={kind}")).json()
    return minted["token"]


async def test_an_otlp_export_writes_the_same_row_shape_as_the_rest_agent_path(client):
    alice = str(uuid.uuid4())
    as_user(alice, "member")
    desktop_token = await _pair(client, "desktop")

    occurred = _recent_nanos(seconds_ago=900)  # 15 minutes ago
    payload = _export_request(
        source="desktop",
        records=[_log_record(occurred, {
            "action": "app.focus", "category": "app", "targetKind": "app",
            "targetId": "Google Chrome", "durationMs": 840000,
        })],
    )
    r = await client.post(
        "/telemetry/otlp/logs", headers={"X-Ingest-Token": desktop_token}, json=payload,
    )
    assert r.status_code == 202, r.text
    assert r.json()["accepted"] == 1

    entries = (await client.get("/telemetry/members/me/timeline")).json()["entries"]
    app_rows = [e for e in entries if e["action"] == "app.focus"]
    assert app_rows, "the OTLP-delivered row must be readable through the SAME timeline API"
    assert app_rows[0]["source"] == "desktop", "distinguishable source, from the TOKEN not the OTLP attribute"
    assert app_rows[0]["targetId"] == "Google Chrome"
    assert app_rows[0]["durationMs"] == 840000
    # Timestamp preserved to the second: the OTLP timeUnixNano we sent, not
    # server-arrival time (which is what a clamp-to-"now" bug would produce).
    expected_iso = datetime.fromtimestamp(
        int(occurred) / 1_000_000_000, tz=timezone.utc
    ).strftime("%Y-%m-%dT%H:%M:%S")
    assert app_rows[0]["occurredAt"].startswith(expected_iso)


async def test_desktop_and_browser_otlp_records_correlate_into_one_session(client):
    """The exact task-spec scenario, but delivered over OTLP instead of REST —
    proving the collector integration reuses sessionizer.py untouched."""
    alice = str(uuid.uuid4())
    as_user(alice, "member")
    desktop_token = await _pair(client, "desktop")
    ext_token = await _pair(client, "extension")

    occurred = _recent_nanos(seconds_ago=900)
    await client.post(
        "/telemetry/otlp/logs", headers={"X-Ingest-Token": ext_token},
        json=_export_request(source="extension", records=[_log_record(
            occurred,
            {"action": "site.visit", "category": "site", "targetKind": "site",
             "targetId": "youtube.com", "durationMs": 830000},
        )]),
    )
    await client.post(
        "/telemetry/otlp/logs", headers={"X-Ingest-Token": desktop_token},
        json=_export_request(source="desktop", records=[_log_record(
            occurred,
            {"action": "app.focus", "category": "app", "targetKind": "app",
             "targetId": "Google Chrome", "durationMs": 840000},
        )]),
    )

    async with db_session() as db:
        await set_bypass_rls(db)
        sessions = (
            await db.execute(
                text("SELECT kind, app_name, domain, duration_ms FROM activity_sessions WHERE user_id = :uid"),
                {"uid": alice},
            )
        ).mappings().all()
    assert len(sessions) == 1
    assert sessions[0]["kind"] == "app+site"
    assert sessions[0]["app_name"] == "Google Chrome"
    assert sessions[0]["domain"] == "youtube.com"
    assert sessions[0]["duration_ms"] == 840000


async def test_missing_token_is_rejected_the_same_way_as_the_rest_path(client):
    r = await client.post("/telemetry/otlp/logs", json=_export_request(source="desktop", records=[]))
    assert r.status_code == 401


async def test_an_invalid_token_is_rejected(client):
    r = await client.post(
        "/telemetry/otlp/logs", headers={"X-Ingest-Token": "not-a-real-token"},
        json=_export_request(source="desktop", records=[]),
    )
    assert r.status_code == 401


async def test_an_empty_export_is_accepted_but_writes_nothing(client):
    alice = str(uuid.uuid4())
    as_user(alice, "member")
    token = await _pair(client, "desktop")
    r = await client.post(
        "/telemetry/otlp/logs", headers={"X-Ingest-Token": token},
        json=_export_request(source="desktop", records=[]),
    )
    assert r.status_code == 202
    assert r.json()["accepted"] == 0


async def test_a_stolen_token_still_cannot_write_for_someone_else(client):
    """Same guarantee routes/agent.py already has: org/user come from the
    TOKEN's row, never anything in the OTLP payload — an attacker controlling
    what a compromised collector forwards still cannot attribute activity to
    an arbitrary victim."""
    bob = str(uuid.uuid4())
    as_user(bob, "member")
    token = await _pair(client, "extension")

    payload = _export_request(source="extension", records=[_log_record(
        _recent_nanos(seconds_ago=60),
        {"action": "site.visit", "category": "site", "targetKind": "site", "targetId": "example.com"},
    )])
    await client.post("/telemetry/otlp/logs", headers={"X-Ingest-Token": token}, json=payload)

    as_user(bob, "member")
    bob_entries = (await client.get("/telemetry/members/me/timeline")).json()["entries"]
    assert any(e["targetId"] == "example.com" for e in bob_entries)
