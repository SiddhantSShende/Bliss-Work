"""A failed task write must not invalidate its already-created project key.

Project resolution now encrypts and commits the project name before the task
transaction starts. A later task rollback must leave that committed key usable;
otherwise the persisted project ciphertext (and subsequent tasks) would become
undecryptable.

Needs a real Postgres: it is the rollback that matters.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "77777777-7777-7777-7777-777777777777"
SENDER = "88888888-8888-8888-8888-888888888888"


async def _client() -> httpx.AsyncClient:
    from app.auth import Principal, require_principal
    from app.main import app

    principal = Principal(user_id=SENDER, org_id=ORG, roles=["member"], username="sender")
    app.dependency_overrides[require_principal] = lambda: principal
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _org_key_rows() -> int:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        return (await conn.execute(text("SELECT count(*) FROM org_keys WHERE org_id = :o"), {"o": ORG})).scalar()


async def test_failed_task_write_preserves_committed_project_key(db_app, seed_members, monkeypatch):
    from app.routes import tasks_write
    from crypto import cryptor

    await seed_members(ORG, SENDER)

    # Project-name encryption commits its key before the task transaction. The
    # task then fails after encrypting its own fields but before commit.
    real_insert = tasks_write._insert_task_assignees
    failures = {"left": 1}

    async def _fail_once(*args, **kwargs):
        if failures["left"]:
            failures["left"] -= 1
            raise RuntimeError("the assignee insert failed after the key was created")
        return await real_insert(*args, **kwargs)

    monkeypatch.setattr(tasks_write, "_insert_task_assignees", _fail_once)

    async with await _client() as c:
        with pytest.raises(RuntimeError):
            await c.post(
                "/api/v1/tasks",
                json={
                    "taskTitle": "lost with the first attempt",
                    "title": "lost with the first attempt",
                    "assigneeIds": [SENDER],
                },
            )
        assert await _org_key_rows() == 1, "the committed project key must survive the failed task transaction"

        # A retry within the cache TTL must use the committed project key.
        r = await c.post(
            "/api/v1/tasks",
            json={"taskTitle": "the retry", "title": "the retry", "assigneeIds": [SENDER]},
        )
        assert r.status_code == 201, r.text
        assert await _org_key_rows() == 1

        # The cache expiring, or another pod serving the read, must still be able
        # to decrypt project and task data from the database key.
        crypt = cryptor()
        crypt._current.clear()
        crypt._dek_cache.clear()

        sent = await c.get("/api/v1/tasks/sent")
        assert sent.status_code == 200, sent.text
        assert [t["title"] for t in sent.json()] == ["the retry"]
