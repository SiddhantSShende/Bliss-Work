"""`POST /tasks/{id}/assignees` — adding people and/or channels to an existing task.

A channel is the same thing here as on create: its current members become
participants, once each, and it stays attached (task_channels) so a later joiner is
added too. messaging-svc is the only collaborator stubbed (a fixed channel -> members
table); schema, RLS, permission rules and the outbox are the real code on a real Postgres.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
SENDER = "33333333-3333-3333-3333-333333333333"


def _id() -> str:
    return str(uuid.uuid4())


def _as(user_id: str):
    def _principal():
        from app.auth import Principal

        return Principal(user_id=user_id, org_id=ORG, roles=["member"], username="u")

    return _principal


async def _client(user_id: str = SENDER) -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = _as(user_id)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def channels(monkeypatch):
    """channel id -> member ids, or "dead" (404: deleted / caller not in it)."""
    from fastapi import HTTPException

    from app.routes import participants, tasks_write

    table: dict[str, list[str] | str] = {}

    async def _resolve(channel_id: str, org_id: str, caller_id: str) -> list[str]:
        answer = table[channel_id]
        if answer == "dead":
            raise HTTPException(status_code=404, detail="channel not found")
        return list(answer)

    # create path and participants each bound the name at import.
    monkeypatch.setattr(tasks_write, "_resolve_channel_members", _resolve)
    monkeypatch.setattr(participants, "_resolve_channel_members", _resolve)
    return table


async def _q(sql: str, **params) -> list:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        return (await conn.execute(text(sql), params)).all()


async def _assignees(task_id: str) -> list[str]:
    rows = await _q("SELECT assignee_id FROM task_assignees WHERE task_id = :t", t=task_id)
    return sorted(str(r.assignee_id) for r in rows)


async def _task_channels(task_id: str) -> list[str]:
    rows = await _q("SELECT channel_id FROM task_channels WHERE task_id = :t", t=task_id)
    return sorted(str(r.channel_id) for r in rows)


async def _new_task(*assignees: str) -> str:
    async with await _client() as c:
        r = await c.post("/api/v1/tasks", json={"title": "Review report", "assigneeIds": list(assignees)})
    assert r.status_code == 201, r.text
    return r.json()["taskId"]


async def _add(task_id: str, user_id: str = SENDER, **body) -> httpx.Response:
    async with await _client(user_id) as c:
        return await c.post(f"/api/v1/tasks/{task_id}/assignees", json=body)


async def test_adds_a_channels_members_and_attaches_the_channel(db_app, seed_members, channels):
    a, b, m1, m2, ch = _id(), _id(), _id(), _id(), _id()
    await seed_members(ORG, a, b)
    channels[ch] = [m1, m2]
    task_id = await _new_task(a)

    r = await _add(task_id, userIds=[b], channelIds=[ch])

    assert r.status_code == 200, r.text
    assert sorted(r.json()["addedUserIds"]) == sorted([b, m1, m2])
    assert r.json()["addedChannelIds"] == [ch]
    assert await _assignees(task_id) == sorted([a, b, m1, m2])
    assert await _task_channels(task_id) == [ch]


async def test_channel_only_overlapping_existing_participant_is_added_once(db_app, seed_members, channels):
    a, m1, ch = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[ch] = [a.upper(), m1]  # a is already on the task, in another casing
    task_id = await _new_task(a)

    r = await _add(task_id, channelIds=[ch])

    assert r.status_code == 200, r.text
    assert r.json()["addedUserIds"] == [m1]
    assert await _assignees(task_id) == sorted([a, m1])


async def test_channel_whose_members_are_all_present_is_still_attached(db_app, seed_members, channels):
    a, ch = _id(), _id()
    await seed_members(ORG, a)
    channels[ch] = [a]
    task_id = await _new_task(a)

    r = await _add(task_id, channelIds=[ch])

    assert r.status_code == 200, r.text
    assert r.json()["addedUserIds"] == []
    assert await _task_channels(task_id) == [ch]


async def test_readding_a_channel_is_a_noop(db_app, seed_members, channels):
    a, m1, ch = _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[ch] = [m1]
    task_id = await _new_task(a)

    assert (await _add(task_id, channelIds=[ch])).status_code == 200
    again = await _add(task_id, channelIds=[ch])

    assert again.status_code == 200, again.text
    assert again.json()["addedUserIds"] == []
    assert await _task_channels(task_id) == [ch]


async def test_a_channel_the_caller_cannot_see_adds_nobody(db_app, seed_members, channels):
    a, m1, ch_ok, ch_dead = _id(), _id(), _id(), _id()
    await seed_members(ORG, a)
    channels[ch_ok] = [m1]
    channels[ch_dead] = "dead"
    task_id = await _new_task(a)

    r = await _add(task_id, channelIds=[ch_ok, ch_dead])

    assert r.status_code == 404
    assert await _assignees(task_id) == [a]
    assert await _task_channels(task_id) == []


async def test_people_only_still_works_and_needs_no_channel(db_app, seed_members, channels):
    a, b = _id(), _id()
    await seed_members(ORG, a, b)
    task_id = await _new_task(a)

    r = await _add(task_id, userIds=[b])

    assert r.status_code == 200, r.text
    assert r.json()["addedUserIds"] == [b]
    assert await _task_channels(task_id) == []


async def test_empty_request_is_rejected(db_app, seed_members, channels):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _new_task(a)

    assert (await _add(task_id)).status_code == 400


async def test_a_stranger_cannot_add_a_channel(db_app, seed_members, channels):
    a, ch, stranger = _id(), _id(), _id()
    await seed_members(ORG, a, stranger)
    channels[ch] = [stranger]
    task_id = await _new_task(a)

    r = await _add(task_id, user_id=stranger, channelIds=[ch])

    assert r.status_code == 403
    assert await _task_channels(task_id) == []


async def test_a_later_joiner_of_an_added_channel_is_added_to_the_task(db_app, seed_members, channels):
    """Attached means attached: the existing ChannelMemberJoined consumer picks it up."""
    from app.consumer import TaskSvcConsumer

    a, ch, late = _id(), _id(), _id()
    await seed_members(ORG, a, late)
    channels[ch] = []
    task_id = await _new_task(a)
    assert (await _add(task_id, channelIds=[ch])).status_code == 200

    await TaskSvcConsumer()._handle_channel_member_joined(  # noqa: SLF001
        {"eventId": _id(), "orgId": ORG, "channelId": ch, "userId": late}
    )

    assert await _assignees(task_id) == sorted([a, late])
