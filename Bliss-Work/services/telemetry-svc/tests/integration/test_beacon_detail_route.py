"""B-TEL-2 through the real route: an oversized beacon `detail` is a 422 that
writes nothing, and a normal one still lands.

    TELEMETRY_DATABASE_URL=postgresql://telemetry_user:pw@host/telemetrydb \\
        python -m pytest tests/integration/test_beacon_detail_route.py -q
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
USER = str(uuid.uuid4())


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


def _body(detail):
    return {
        "source": "web",
        "events": [{"action": "attachment.opened", "category": "engagement", "detail": detail}],
    }


async def test_a_normal_detail_is_accepted(client):
    r = await client.post("/telemetry/beacon", json=_body({"filename": "report.pdf", "channel": "c-1"}))
    assert r.status_code == 200, r.text
    assert r.json()["accepted"] == 1


async def test_an_oversized_detail_is_rejected_before_anything_is_written(client):
    r = await client.post("/telemetry/beacon", json=_body({"blob": "x" * 200_000}))
    assert r.status_code == 422, r.text


async def test_a_batch_whose_details_add_up_to_too_much_is_a_422_not_a_500(client):
    event = {"action": "a", "detail": {"a": "x" * 1000, "b": "x" * 1000}}
    r = await client.post("/telemetry/beacon", json={"source": "web", "events": [event] * 30})
    assert r.status_code == 422, r.text
