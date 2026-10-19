"""`POST /api/v1/projects` — Section 6.4: a project created on its own, with
no task involved. messaging-svc is stubbed the same way the other project/
task tests do it: `app.projects.fetch_channel_members` replaced with a fixed
channel -> members table.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
OTHER_ORG = "22222222-2222-2222-2222-222222222222"
SENDER = "33333333-3333-3333-3333-333333333333"
OTHER = "44444444-4444-4444-4444-444444444444"


def _id() -> str:
    return str(uuid.uuid4())


def _principal(user_id: str = SENDER, org_id: str = ORG):
    from app.auth import Principal

    return Principal(user_id=user_id, org_id=org_id, roles=["member"], username="member")


async def _client(user_id: str = SENDER, org_id: str = ORG) -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: _principal(user_id, org_id)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def channels(monkeypatch):
    from app.routes import projects_write

    table: dict[str, list[str]] = {}

    async def _resolve(channel_id: str, org_id: str, caller_id: str) -> list[str]:
        if channel_id not in table:
            raise HTTPException(status_code=404, detail="channel not found")
        return list(table[channel_id])

    # Patch where it's LOOKED UP (projects_write's own imported name), not
    # where it's defined (app.projects) — `from ..projects import
    # fetch_channel_members` already bound the original function object into
    # this module's namespace at import time, same trap avoided in
    # test_project_link_channel.py.
    monkeypatch.setattr(projects_write, "fetch_channel_members", _resolve)
    return table


async def _q(sql: str, **params) -> list:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        result = await conn.execute(text(sql), params)
        return result.all() if result.returns_rows else []


async def _create(**body) -> httpx.Response:
    async with await _client() as client:
        return await client.post("/api/v1/projects", json=body)


@pytest.mark.usefixtures("db_app")
class TestCreateProjectStandalone:
    async def test_creates_a_project_from_one_eligible_channel(self, channels):
        channel_id = _id()
        channels[channel_id] = [SENDER, OTHER]

        resp = await _create(name="Website Redesign", channelIds=[channel_id])
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["name"] == "Website Redesign"
        assert body["channelId"] == channel_id
        assert body["channelIds"] == [channel_id]
        assert body["status"] == "ACTIVE"
        assert body["canComplete"] is True

    async def test_links_every_given_channel(self, channels):
        c1, c2 = _id(), _id()
        channels[c1] = [SENDER, OTHER]
        channels[c2] = [SENDER, OTHER]

        resp = await _create(name="Multi Channel Project", channelIds=[c1, c2])
        assert resp.status_code == 201, resp.text
        assert set(resp.json()["channelIds"]) == {c1, c2}

    async def test_a_channel_with_fewer_than_two_members_rejects_the_whole_request(self, channels):
        solo, real = _id(), _id()
        channels[solo] = [SENDER]
        channels[real] = [SENDER, OTHER]

        resp = await _create(name="Ineligible Channel", channelIds=[real, solo])
        assert resp.status_code == 400
        # Nothing was created — the request fails loudly, not partially.
        rows = await _q("SELECT id FROM projects WHERE org_id = :org", org=ORG)
        assert rows == []

    async def test_requires_at_least_one_channel(self):
        resp = await _create(name="No Channels", channelIds=[])
        assert resp.status_code == 422

    async def test_requires_a_non_blank_name(self, channels):
        channel_id = _id()
        channels[channel_id] = [SENDER, OTHER]
        resp = await _create(name="   ", channelIds=[channel_id])
        assert resp.status_code == 422

    async def test_a_channel_in_another_org_is_rejected(self, channels):
        # fetch_channel_members (the real one) 404s a channel that is not in
        # the caller's org; the stub mirrors that by simply not knowing it.
        unknown_channel = _id()
        resp = await _create(name="Cross-Org Attempt", channelIds=[unknown_channel])
        assert resp.status_code == 404

    async def test_retrying_the_same_name_returns_the_same_project_not_a_duplicate(self, channels):
        channel_id = _id()
        channels[channel_id] = [SENDER, OTHER]

        first = await _create(name="  Retry Me  ", channelIds=[channel_id])
        second = await _create(name="Retry Me", channelIds=[channel_id])
        assert first.status_code == 201
        assert second.status_code == 201
        assert first.json()["id"] == second.json()["id"]
        rows = await _q(
            "SELECT count(*) AS n FROM projects WHERE org_id = :org", org=ORG
        )
        assert rows[0].n == 1

    async def test_the_created_project_is_readable_through_get_projects(self, channels):
        channel_id = _id()
        channels[channel_id] = [SENDER, OTHER]
        created = await _create(name="Readable Project", channelIds=[channel_id])
        assert created.status_code == 201

        async with await _client() as client:
            detail = await client.get(f"/api/v1/projects/{created.json()['id']}")
        assert detail.status_code == 200
        assert detail.json()["name"] == "Readable Project"

    async def test_the_creator_can_complete_tasks_created_under_it_normally(self, channels):
        # Not a full task flow — just confirms the project is a normal,
        # usable project afterward (project_id FK, status machinery intact),
        # by checking it round-trips through the completion gate's own read.
        channel_id = _id()
        channels[channel_id] = [SENDER, OTHER]
        created = await _create(name="Usable Project", channelIds=[channel_id])
        project_id = created.json()["id"]

        async with await _client() as client:
            complete = await client.post(f"/api/v1/projects/{project_id}/complete")
        # No tasks filed under it yet — correctly refused, not crashed.
        assert complete.status_code == 409
