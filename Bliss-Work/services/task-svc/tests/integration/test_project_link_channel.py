from __future__ import annotations

import uuid

import httpx
import pytest

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
SENDER = "33333333-3333-3333-3333-333333333333"
OTHER_MEMBER = "44444444-4444-4444-4444-444444444444"


def _id() -> str:
    return str(uuid.uuid4())


def _principal(user_id: str = SENDER, org_id: str = ORG, roles: list[str] | None = None):
    from app.auth import Principal

    return Principal(user_id=user_id, org_id=org_id, roles=roles or ["member"], username="member")


async def _client(user_id: str = SENDER, org_id: str = ORG, roles: list[str] | None = None) -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: _principal(user_id, org_id, roles)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _create(title: str, assignee_id: str) -> str:
    async with await _client() as client:
        resp = await client.post(
            "/api/v1/tasks",
            json={"taskTitle": title, "title": title, "assigneeIds": [assignee_id]},
        )
    return resp.json()["taskId"]


async def _project_id(title: str) -> str:
    async with await _client() as client:
        resp = await client.get("/api/v1/projects/by-name", params={"name": title})
    return resp.json()["id"]


def _mock_members(monkeypatch, members_by_channel: dict[str, list[str]]):
    from app.routes import projects_write

    async def fake(channel_id: str, org_id: str, caller_id: str) -> list[str]:
        del org_id, caller_id
        if channel_id not in members_by_channel:
            from fastapi import HTTPException

            raise HTTPException(status_code=404, detail="channel not found")
        return members_by_channel[channel_id]

    monkeypatch.setattr(projects_write, "fetch_channel_members", fake)


@pytest.mark.usefixtures("db_app", "seed_members")
class TestLinkProjectChannel:
    async def test_owner_links_an_existing_channel_with_two_members(self, monkeypatch, seed_members):
        await seed_members(ORG, SENDER, OTHER_MEMBER)
        await _create("Website Redesign", OTHER_MEMBER)
        project_id = await _project_id("Website Redesign")

        channel_id = _id()
        _mock_members(monkeypatch, {channel_id: [SENDER, OTHER_MEMBER]})

        async with await _client() as client:
            resp = await client.post(
                f"/api/v1/projects/{project_id}/channels", json={"channelId": channel_id}
            )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert channel_id in body["channelIds"]
        assert len(body["channelIds"]) == 2

    async def test_channel_with_fewer_than_two_members_is_refused(self, monkeypatch, seed_members):
        await seed_members(ORG, SENDER)
        await _create("Solo Project", SENDER)
        project_id = await _project_id("Solo Project")

        channel_id = _id()
        _mock_members(monkeypatch, {channel_id: [SENDER]})

        async with await _client() as client:
            resp = await client.post(
                f"/api/v1/projects/{project_id}/channels", json={"channelId": channel_id}
            )
        assert resp.status_code == 400

    async def test_a_non_owner_non_admin_cannot_link_a_channel(self, monkeypatch, seed_members):
        await seed_members(ORG, SENDER, OTHER_MEMBER)
        await _create("Bystander Project", OTHER_MEMBER)
        project_id = await _project_id("Bystander Project")

        channel_id = _id()
        _mock_members(monkeypatch, {channel_id: [SENDER, OTHER_MEMBER]})

        async with await _client(user_id=OTHER_MEMBER, roles=["member"]) as client:
            resp = await client.post(
                f"/api/v1/projects/{project_id}/channels", json={"channelId": channel_id}
            )
        assert resp.status_code == 403

    async def test_relinking_the_same_channel_is_idempotent(self, monkeypatch, seed_members):
        await seed_members(ORG, SENDER, OTHER_MEMBER)
        await _create("Repeatable Project", OTHER_MEMBER)
        project_id = await _project_id("Repeatable Project")

        channel_id = _id()
        _mock_members(monkeypatch, {channel_id: [SENDER, OTHER_MEMBER]})

        async with await _client() as client:
            first = await client.post(f"/api/v1/projects/{project_id}/channels", json={"channelId": channel_id})
            second = await client.post(f"/api/v1/projects/{project_id}/channels", json={"channelId": channel_id})
        assert first.status_code == 200
        assert second.status_code == 200
        assert second.json()["channelIds"].count(channel_id) == 1

    async def test_unknown_project_is_404(self, monkeypatch):
        channel_id = _id()
        _mock_members(monkeypatch, {channel_id: [SENDER, OTHER_MEMBER]})
        async with await _client() as client:
            resp = await client.post(f"/api/v1/projects/{_id()}/channels", json={"channelId": channel_id})
        assert resp.status_code == 404
