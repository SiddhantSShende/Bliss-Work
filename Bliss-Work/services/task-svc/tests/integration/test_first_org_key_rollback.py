"""An org's first data key must not outlive the transaction that created it.

The DEK is created lazily, inside the write transaction of the org's first
encryption. It used to be cached process-wide the moment it was generated —
before that transaction committed. If the transaction then rolled back, the
`org_keys` row vanished but the cache kept the key, so every later write in the
next few minutes was encrypted under a key that existed nowhere in the database:
no row was ever inserted for it. Once the cache expired (or the pod restarted, or
another pod served the read) that ciphertext could not be decrypted, and the tasks
were gone for good.

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


async def test_a_rolled_back_first_write_leaves_no_phantom_key_behind(db_app, seed_members, monkeypatch):
    from app.routes import tasks_write
    from crypto import cryptor

    await seed_members(ORG, SENDER)

    # The org's first create_task encrypts (creating the key), then fails before it commits.
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
            await c.post("/api/v1/tasks", json={"title": "lost with the first attempt", "assigneeIds": [SENDER]})
        assert await _org_key_rows() == 0, "the failed transaction must have rolled its key back"

        # A retry within the cache TTL: this is the write that got encrypted under the phantom key.
        r = await c.post("/api/v1/tasks", json={"title": "the retry", "assigneeIds": [SENDER]})
        assert r.status_code == 201, r.text
        assert await _org_key_rows() == 1, "the key this task was encrypted under must be in the database"

        # The cache expiring, or another pod serving the read: the key now has to come from the database.
        crypt = cryptor()
        crypt._current.clear()
        crypt._dek_cache.clear()

        sent = await c.get("/api/v1/tasks/sent")
        assert sent.status_code == 200, sent.text
        assert [t["title"] for t in sent.json()] == ["the retry"]
