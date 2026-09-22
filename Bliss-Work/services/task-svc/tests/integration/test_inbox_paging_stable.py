"""`GET /tasks/inbox` (and /assigned, /sticky, which share the query): paging must be stable.

Several tasks assigned in one transaction (a bulk assignment) share an
`assigned_at`. The list was ordered by that column alone, so LIMIT/OFFSET pages
could skip a task or show it twice — PostgreSQL's top-N sort breaks ties
differently for each LIMIT+OFFSET. The client pages this list, so a skipped task
was simply never shown. Ordering by (assigned_at DESC, task_id DESC) is total.

Needs a real Postgres, like the sibling suites.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "44444444-4444-4444-4444-444444444444"
SENDER = "55555555-5555-5555-5555-555555555555"
ME = "66666666-6666-6666-6666-666666666666"


def _task_id(n: int) -> str:
    return f"{n:08x}-0000-4000-8000-000000000000"


async def _client() -> httpx.AsyncClient:
    from app.auth import Principal, require_principal
    from app.main import app

    principal = Principal(user_id=ME, org_id=ORG, roles=["member"], username="me")
    app.dependency_overrides[require_principal] = lambda: principal
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _assign_to_me(task_ids: list[str], assigned_at: datetime) -> None:
    from crypto import cryptor
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        for task_id in task_ids:
            title_enc = await cryptor().encrypt(conn, ORG, f"Task {task_id[:8]}")
            desc_enc = await cryptor().encrypt(conn, ORG, "")
            await conn.execute(
                text(
                    "INSERT INTO tasks (id, org_id, sender_id, title_enc, description_enc) "
                    "VALUES (:id, :org, :sender, :t, :d)"
                ),
                {"id": task_id, "org": ORG, "sender": SENDER, "t": title_enc, "d": desc_enc},
            )
            await conn.execute(
                text(
                    "INSERT INTO task_assignees (task_id, org_id, assignee_id, status, assigned_at) "
                    "VALUES (:tid, :org, :me, CAST('SENT' AS assignee_status), :at)"
                ),
                {"tid": task_id, "org": ORG, "me": ME, "at": assigned_at},
            )


async def _page(path: str, **params) -> list[str]:
    async with await _client() as c:
        r = await c.get(path, params=params)
        assert r.status_code == 200, r.text
        return [row["taskId"] for row in r.json()]


@pytest.mark.parametrize("path", ["/api/v1/tasks/inbox", "/api/v1/tasks/assigned", "/api/v1/tasks/sticky"])
async def test_paging_shows_every_task_once_when_they_share_an_assigned_at(db_app, path):
    ids = [_task_id(n) for n in range(1, 13)]
    await _assign_to_me(ids, datetime.now(timezone.utc))

    everything = await _page(path, limit=100)
    paged: list[str] = []
    for offset in range(0, 12, 3):
        paged += await _page(path, limit=3, offset=offset)

    assert sorted(paged) == sorted(ids)  # none skipped, none repeated
    assert paged == everything  # and in the order one unpaged read gives
    assert paged == sorted(ids, reverse=True)  # task id is the tiebreaker
