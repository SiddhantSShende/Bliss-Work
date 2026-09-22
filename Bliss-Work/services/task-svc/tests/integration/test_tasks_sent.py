"""`GET /tasks/sent`: which assignees the sender sees, and stable paging.

Two behaviours callers depend on:
  * By default an assignee who ignored the task is hidden from the sender
    (Ignore sets sender_dismissed) — TasksList, Search and the mobile app rely
    on that. `includeIgnored=true` is My Tasks' opt-in to see those rows, which
    its Ignored filter needs.
  * Pages are ordered by (created_at DESC, id DESC). Tasks created in one
    transaction share a created_at, so ordering by created_at alone let
    LIMIT/OFFSET paging skip or repeat them between pages.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "88888888-8888-8888-8888-888888888888"
SENDER = "99999999-9999-9999-9999-999999999999"
ACTIVE = "aaaaaaaa-0000-0000-0000-00000000000a"
IGNORER = "bbbbbbbb-0000-0000-0000-00000000000b"


def _task_id(n: int) -> str:
    return f"{n:08x}-0000-4000-8000-000000000000"


async def _client() -> httpx.AsyncClient:
    from app.auth import Principal, require_principal
    from app.main import app

    principal = Principal(user_id=SENDER, org_id=ORG, roles=["member"], username="sender")
    app.dependency_overrides[require_principal] = lambda: principal
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _seed(task_id: str, created_at: datetime, assignees: list[tuple[str, str, bool]]) -> None:
    """Insert one task sent by SENDER, with `(assignee_id, status, sender_dismissed)`
    rows, encrypting the title exactly like the app does."""
    from crypto import cryptor
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        title_enc = await cryptor().encrypt(conn, ORG, f"Task {task_id[:8]}")
        desc_enc = await cryptor().encrypt(conn, ORG, "")
        await conn.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, title_enc, description_enc, created_at) "
                "VALUES (:id, :org, :sender, :title_enc, :desc_enc, :created_at)"
            ),
            {"id": task_id, "org": ORG, "sender": SENDER, "title_enc": title_enc,
             "desc_enc": desc_enc, "created_at": created_at},
        )
        for assignee_id, status, dismissed in assignees:
            await conn.execute(
                text(
                    "INSERT INTO task_assignees "
                    "  (task_id, org_id, assignee_id, status, sender_dismissed, ignored_at) "
                    "VALUES (:tid, :org, :aid, CAST(:status AS assignee_status), :dismissed, :ignored_at)"
                ),
                {"tid": task_id, "org": ORG, "aid": assignee_id, "status": status, "dismissed": dismissed,
                 "ignored_at": datetime.now(timezone.utc) if status == "IGNORED" else None},
            )


async def _sent(**params) -> list[dict]:
    async with await _client() as c:
        r = await c.get("/api/v1/tasks/sent", params=params)
        assert r.status_code == 200, r.text
        return r.json()


def _assignees(rows: list[dict]) -> dict[str, dict[str, str]]:
    return {row["taskId"]: {a["assigneeId"]: a["status"] for a in row["assignees"]} for row in rows}


async def test_default_hides_ignored_assignees_and_include_ignored_returns_them(db_app):
    now = datetime.now(timezone.utc)
    all_ignored, live, mixed = _task_id(1), _task_id(2), _task_id(3)
    await _seed(all_ignored, now, [(IGNORER, "IGNORED", True)])
    await _seed(live, now, [(ACTIVE, "ACKNOWLEDGED", False)])
    await _seed(mixed, now, [(ACTIVE, "ACKNOWLEDGED", False), (IGNORER, "IGNORED", True)])

    # Default: what TasksList, Search and mobile have always seen.
    assert _assignees(await _sent()) == {
        live: {ACTIVE: "ACKNOWLEDGED"},
        mixed: {ACTIVE: "ACKNOWLEDGED"},
    }

    rows = await _sent(includeIgnored="true")
    assert _assignees(rows) == {
        all_ignored: {IGNORER: "IGNORED"},
        live: {ACTIVE: "ACKNOWLEDGED"},
        mixed: {ACTIVE: "ACKNOWLEDGED", IGNORER: "IGNORED"},
    }
    ignored = next(a for r in rows if r["taskId"] == all_ignored for a in r["assignees"])
    assert ignored["ignoredAt"] is not None


async def test_paging_is_stable_when_tasks_share_a_created_at(db_app):
    shared = datetime.now(timezone.utc)
    ids = [_task_id(n) for n in range(1, 8)]
    for task_id in ids:
        await _seed(task_id, shared, [(ACTIVE, "SENT", False)])

    everything = [row["taskId"] for row in await _sent(limit=100)]
    paged = []
    for offset in (0, 3, 6):
        paged += [row["taskId"] for row in await _sent(limit=3, offset=offset)]

    assert sorted(paged) == sorted(ids)  # every task exactly once: none skipped, none repeated
    assert paged == everything  # and in the same order as one unpaged read
    assert paged == sorted(ids, reverse=True)  # id is the documented tiebreaker
