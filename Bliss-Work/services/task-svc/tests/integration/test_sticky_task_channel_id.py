"""`StickyTaskDTO.channelId` — the field the task card's "Chat" button relies on
to open the task's actual channel instead of falling back to a DM.

Root cause this guards: `_sticky_list` / `task_detail` (routes/tasks_read.py)
never selected `task_channels`, so every sticky task DTO had `channelId: null`
regardless of how the task was sent, and the frontend's Chat button always
treated it as a DM target. This exercises the real HTTP endpoints against the
real schema (task_channels, task_assignees), not the SQL in isolation.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "77777777-7777-7777-7777-777777777777"
ASSIGNEE = "88888888-8888-8888-8888-888888888888"
SENDER = "99999999-9999-9999-9999-999999999999"


def _principal():
    from app.auth import Principal

    return Principal(user_id=ASSIGNEE, org_id=ORG, roles=["member"], username="assignee")


async def _client() -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: _principal()
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def _seed_task(task_id: str, *, channel_ids: list[str] = (), title: str = "seed") -> None:
    from crypto import cryptor
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        title_enc = await cryptor().encrypt(conn, ORG, title)
        await conn.execute(
            text("INSERT INTO tasks (id, org_id, sender_id, title_enc) VALUES (:id, :org, :sender, :t)"),
            {"id": task_id, "org": ORG, "sender": SENDER, "t": title_enc},
        )
        await conn.execute(
            text(
                "INSERT INTO task_assignees (task_id, org_id, assignee_id, status) "
                "VALUES (:tid, :org, :aid, 'SENT')"
            ),
            {"tid": task_id, "org": ORG, "aid": ASSIGNEE},
        )
        for ch in channel_ids:
            await conn.execute(
                text("INSERT INTO task_channels (task_id, org_id, channel_id) VALUES (:tid, :org, :ch)"),
                {"tid": task_id, "org": ORG, "ch": ch},
            )


async def test_task_with_a_channel_reports_it_on_inbox_sticky_and_detail(db_app):
    task_id = str(uuid.uuid4())
    channel_id = str(uuid.uuid4())
    await _seed_task(task_id, channel_ids=[channel_id])

    async with await _client() as c:
        for path in ("/api/v1/tasks/inbox", "/api/v1/tasks/sticky", "/api/v1/tasks/assigned"):
            r = await c.get(path)
            assert r.status_code == 200, r.text
            row = next(row for row in r.json() if row["taskId"] == task_id)
            assert row["channelId"] == channel_id, path

        r = await c.get(f"/api/v1/tasks/{task_id}/detail")
        assert r.status_code == 200, r.text
        assert r.json()["channelId"] == channel_id


async def test_task_sent_to_named_people_only_has_no_channel(db_app):
    task_id = str(uuid.uuid4())
    await _seed_task(task_id, channel_ids=[])

    async with await _client() as c:
        r = await c.get("/api/v1/tasks/inbox")
        assert r.status_code == 200, r.text
        row = next(row for row in r.json() if row["taskId"] == task_id)
        assert row["channelId"] is None


async def test_task_attached_to_several_channels_reports_the_first_one(db_app):
    """A task fanned out to multiple channels still surfaces exactly one —
    the earliest attached, mirroring the legacy single-channel semantic the
    migration note (012_task_channels.sql) documents for tasks.channel_id."""
    task_id = str(uuid.uuid4())
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    await _seed_task(task_id, channel_ids=[])

    from app.db import get_engine

    # Explicit, distinct created_at values so ordering is deterministic
    # regardless of how fast these two inserts land.
    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text(
                "INSERT INTO task_channels (task_id, org_id, channel_id, created_at) "
                "VALUES (:tid, :org, :ch, now())"
            ),
            {"tid": task_id, "org": ORG, "ch": first},
        )
        await conn.execute(
            text(
                "INSERT INTO task_channels (task_id, org_id, channel_id, created_at) "
                "VALUES (:tid, :org, :ch, now() + interval '1 second')"
            ),
            {"tid": task_id, "org": ORG, "ch": second},
        )

    async with await _client() as c:
        r = await c.get("/api/v1/tasks/inbox")
        row = next(row for row in r.json() if row["taskId"] == task_id)
        assert row["channelId"] == first
