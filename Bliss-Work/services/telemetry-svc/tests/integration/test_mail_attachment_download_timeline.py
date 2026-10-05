"""A mail attachment download, from Kafka event to the member's timeline.

Runs the real pieces end to end against a real Postgres: the consumer's mapping
(`_to_claimable`) and its real batch write (`_flush` → `_claim_many` →
`insert_events` → encrypted `detail_enc`), then the real timeline API read back
through the ASGI app. Only JWT verification is stubbed, as in test_api_roundtrip.

    TELEMETRY_DATABASE_URL=postgresql://telemetry_user:pw@host/telemetrydb \\
        python -m pytest tests/integration/test_mail_attachment_download_timeline.py -q
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="module")]

if not os.getenv("TELEMETRY_DATABASE_URL"):
    pytest.skip("needs a live Postgres (TELEMETRY_DATABASE_URL)", allow_module_level=True)

httpx = pytest.importorskip("httpx")
pytest_asyncio = pytest.importorskip("pytest_asyncio")

from sqlalchemy import text  # noqa: E402

from app import consumer  # noqa: E402
from app.auth import Principal, require_principal  # noqa: E402
from app.db import session, set_bypass_rls  # noqa: E402
from app.main import app  # noqa: E402

ORG = str(uuid.uuid4())
ACTOR = str(uuid.uuid4())
OTHER = str(uuid.uuid4())
FILENAME = f"Confidential-{uuid.uuid4().hex[:8]}.pdf"


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


def _download(attachment_id: str, **kw):
    base = {
        "eventId": str(uuid.uuid4()),
        "orgId": ORG,
        "type": "mail.attachment.downloaded",
        "actorId": ACTOR,
        "mailId": str(uuid.uuid4()),
        "attachmentId": attachment_id,
        "filename": FILENAME,
        "mime": "application/pdf",
        "sizeBytes": 4096,
        "occurredAt": datetime.now(timezone.utc).isoformat(),
    }
    base.update(kw)
    return base


async def _consume(*events):
    """What TelemetryConsumer does with a fetch, minus the Kafka transport."""
    pending = [consumer._to_claimable(e) for e in events]
    assert all(p is not None for p in pending), "every event here must be mappable"
    await consumer.TelemetryConsumer()._flush(pending)


async def _entries(client, attachment_id: str):
    as_user(ACTOR, "member")
    r = await client.get("/telemetry/members/me/timeline")
    assert r.status_code == 200, r.text
    return [e for e in r.json()["entries"]
            if e["action"] == "mail.attachment.downloaded" and e["targetId"] == attachment_id]


async def test_a_download_appears_in_the_actors_timeline_with_its_detail(client):
    att = str(uuid.uuid4())
    evt = _download(att)
    await _consume(evt)

    (entry,) = await _entries(client, att)
    assert entry["category"] == "engagement"
    assert entry["surface"] == "mail"
    assert entry["targetKind"] == "attachment"
    assert entry["source"] == "server", "server-observed, so the UI marks it Verified"
    assert entry["detail"] == {
        "filename": FILENAME,
        "mime": "application/pdf",
        "sizeBytes": "4096",
        "mailId": evt["mailId"],
    }


async def test_an_admin_can_read_it_and_another_member_cannot(client):
    att = str(uuid.uuid4())
    await _consume(_download(att))

    as_user(OTHER, "org_admin")
    r = await client.get(f"/telemetry/members/{ACTOR}/timeline")
    assert any(e["targetId"] == att for e in r.json()["entries"])

    as_user(OTHER, "member")
    assert (await client.get(f"/telemetry/members/{ACTOR}/timeline")).status_code == 403


async def test_the_filename_is_encrypted_at_rest(client):
    att = str(uuid.uuid4())
    await _consume(_download(att))
    async with session() as db:
        await set_bypass_rls(db)
        blob = (await db.execute(
            text("SELECT detail_enc FROM activity_events WHERE org_id = :o AND target_id = :t"),
            {"o": ORG, "t": att},
        )).scalar_one()
    assert blob is not None
    assert FILENAME.encode() not in bytes(blob), "the filename must not be stored in plaintext"


async def test_separate_downloads_each_get_a_row_but_a_redelivery_does_not(client):
    att = str(uuid.uuid4())
    first, second = _download(att), _download(att)  # two presses: two eventIds

    await _consume(first, second)
    assert len(await _entries(client, att)) == 2

    await _consume(first)  # Kafka redelivers the first one
    assert len(await _entries(client, att)) == 2, "a redelivered eventId must not add a row"
