"""Every file open/download is reported to auth-svc's audit log — after it is
stored here, once per act, and retried (never lost) when auth-svc cannot confirm.

The HTTP boundary to auth-svc is replaced by an in-process transport that
records what is sent; auth-svc's own behaviour (the audit row, the hash chain,
idempotency on eventId) is covered in auth-svc's tests and by the two-service
run documented with this change.

    TELEMETRY_DATABASE_URL=postgresql://telemetry_user:pw@host/telemetrydb \\
        python -m pytest tests/integration/test_file_audit_forwarding.py -q
"""
from __future__ import annotations

import json
import os
import uuid

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="module")]

if not os.getenv("TELEMETRY_DATABASE_URL"):
    pytest.skip("needs a live Postgres (TELEMETRY_DATABASE_URL)", allow_module_level=True)

httpx = pytest.importorskip("httpx")
pytest_asyncio = pytest.importorskip("pytest_asyncio")

from app import audit_forward  # noqa: E402
from app.auth import Principal, require_principal  # noqa: E402
from app.config import settings  # noqa: E402
from app.main import app  # noqa: E402

ORG = str(uuid.uuid4())
USER = str(uuid.uuid4())
SESSION = str(uuid.uuid4())
AUTH_SESSION = "auth-family-1"

DM = {"filename": "image.png", "conversation": "cv-1", "contextKind": "direct",
      "contextId": "cv-1", "contextName": "Divya Bhamri"}
CH = {"filename": "Report.pdf", "channel": "ch-1", "contextKind": "channel",
      "contextId": "ch-1", "contextName": "GRC Development"}
LEGACY = {"filename": "old.pdf", "channel": "ch-0"}
HEADERS = {"user-agent": "Mozilla/5.0 (Test)", "x-forwarded-for": "203.0.113.9", "x-request-id": "req-77"}


def ev(action, detail, *, cid=None, category="engagement", with_id=True):
    e = {"action": action, "category": category, "surface": "chats", "targetKind": "attachment",
         "targetId": f"att-{uuid.uuid4().hex[:6]}", "detail": detail}
    if with_id:
        e["clientEventId"] = cid or str(uuid.uuid4())
    return e


class FakeAuth:
    """Stands in for auth-svc's HTTP surface and records every call."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.token_seen: list[str | None] = []
        self.status = 200

    def handler(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        self.calls.append(body)
        self.token_seen.append(req.headers.get("x-internal-token"))
        if self.status != 200:
            return httpx.Response(self.status)
        n = len(body["events"])
        return httpx.Response(200, json={"written": n, "duplicates": 0, "rejected": 0})

    @property
    def events(self) -> list[dict]:
        return [e for call in self.calls for e in call["events"]]


@pytest_asyncio.fixture(loop_scope="module", scope="module")
async def client():
    async with app.router.lifespan_context(app):
        app.dependency_overrides[require_principal] = lambda: Principal(
            user_id=USER, org_id=ORG, roles=["member"], username="u", session_id=AUTH_SESSION
        )
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
            yield c
    app.dependency_overrides.clear()


@pytest.fixture
def auth(monkeypatch):
    fake = FakeAuth()
    monkeypatch.setattr(settings, "auth_internal_token", "secret-token")
    monkeypatch.setattr(
        audit_forward, "_client", httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))
    )
    return fake


async def beacon(client, events, *, expect=200):
    r = await client.post(
        "/telemetry/beacon", json={"sessionId": SESSION, "source": "web", "events": events}, headers=HEADERS
    )
    assert r.status_code == expect, r.text
    return r.json()


async def timeline(client, category):
    r = await client.get("/telemetry/members/me/timeline", params={"limit": 200, "category": category})
    assert r.status_code == 200, r.text
    return r.json()["entries"]


async def test_a_dm_open_is_reported_with_its_chat_file_and_request_metadata(client, auth):
    opened = ev("attachment.opened", DM)

    await beacon(client, [opened])

    [sent] = auth.events
    assert auth.token_seen == ["secret-token"]
    assert auth.calls[0]["orgId"] == ORG
    uuid.UUID(sent["eventId"])
    assert sent | {"eventId": None, "occurredAt": None} == {
        "eventId": None, "occurredAt": None,
        "actorId": USER, "action": "file.opened", "platform": "web",
        "fileId": opened["targetId"], "fileName": "image.png",
        "contextKind": "direct", "contextId": "cv-1", "contextName": "Divya Bhamri",
        "activitySessionId": SESSION, "sessionId": AUTH_SESSION,
        "ip": "203.0.113.9", "userAgent": "Mozilla/5.0 (Test)", "requestId": "req-77",
    }


async def test_a_channel_download_is_reported_as_file_downloaded_in_its_channel(client, auth):
    await beacon(client, [ev("attachment.downloaded", CH)])

    [sent] = auth.events
    assert (sent["action"], sent["contextKind"], sent["contextName"]) == ("file.downloaded", "channel", "GRC Development")


async def test_a_legacy_event_without_context_is_reported_without_a_chat(client, auth):
    await beacon(client, [ev("attachment.opened", LEGACY)])

    [sent] = auth.events
    assert (sent["fileName"], sent["contextKind"], sent["contextId"], sent["contextName"]) == (
        "old.pdf", None, None, None,
    )


async def test_a_batch_reports_each_act_once_in_one_call(client, auth):
    await beacon(client, [ev("attachment.opened", DM), ev("attachment.downloaded", CH), ev("message.sent", {})])

    assert len(auth.calls) == 1
    assert sorted(e["action"] for e in auth.events) == ["file.downloaded", "file.opened"]
    assert len({e["eventId"] for e in auth.events}) == 2


async def test_other_activity_is_not_reported(client, auth):
    await beacon(client, [ev("message.sent", {}), ev("route.enter", {}, category="navigation")])
    await beacon(client, [])

    assert auth.calls == []


async def test_a_forged_file_action_is_dropped_and_reports_nothing(client, auth):
    forged = ev("file.opened", DM, category="security")

    ack = await beacon(client, [forged])

    assert ack["accepted"] == 0
    assert auth.calls == []


async def test_a_resent_batch_is_reported_again_with_the_same_event_id(client, auth):
    """Re-delivery is the retry mechanism; auth-svc dedupes on this id."""
    opened = ev("attachment.opened", DM)

    await beacon(client, [opened])
    await beacon(client, [opened])

    first, second = auth.events
    assert first["eventId"] == second["eventId"]
    # ...while telemetry's own rows still hold exactly one pair.
    assert len([e for e in await timeline(client, "security") if e["targetId"] == opened["targetId"]]) == 1
    assert len([e for e in await timeline(client, "engagement") if e["targetId"] == opened["targetId"]]) == 1


async def test_when_auth_svc_cannot_confirm_the_beacon_fails_and_the_resend_is_reported(client, auth):
    opened = ev("attachment.downloaded", CH)

    auth.status = 503
    await beacon(client, [opened], expect=503)
    # Stored here regardless (the audit call is after the commit), so no activity is lost...
    assert len([e for e in await timeline(client, "engagement") if e["targetId"] == opened["targetId"]]) == 1

    auth.status = 200
    ack = await beacon(client, [opened])
    # ...and the resend reports it, once more, under the same id, without a second pair here.
    assert ack["accepted"] == 0
    assert len(auth.events) == 2 and auth.events[0]["eventId"] == auth.events[1]["eventId"]
    assert len([e for e in await timeline(client, "security") if e["targetId"] == opened["targetId"]]) == 1


async def test_an_invalid_payload_is_not_allowed_to_wedge_the_client(client, auth):
    auth.status = 422

    await beacon(client, [ev("attachment.opened", DM)])


async def test_an_event_from_an_old_client_without_an_id_is_reported_when_first_stored(client, auth):
    await beacon(client, [ev("attachment.opened", DM, with_id=False)])

    [sent] = auth.events
    uuid.UUID(sent["eventId"])
