"""`POST /tasks` with client-named assignees: every one must be an active member
of the caller's org.

The hole this closes: `assigneeIds` went straight into task_assignees and the
outbox. The assignee row is stamped with the CALLER's org, so RLS had nothing to
object to, and ws-gateway routes `task.assigned` (title, description and the
sender's name included) to the assignee by id alone. A user who learnt an id from
another org could push a task to that person.

Needs a real Postgres with RLS enforced, like the sibling create_task suites.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
OTHER_ORG = "22222222-2222-2222-2222-222222222222"
SENDER = "33333333-3333-3333-3333-333333333333"

REFUSAL = "every assignee must be an active member of your organisation"


async def _client() -> httpx.AsyncClient:
    from app.auth import Principal, require_principal
    from app.main import app

    principal = Principal(user_id=SENDER, org_id=ORG, roles=["member"], username="sender")
    app.dependency_overrides[require_principal] = lambda: principal
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _create(assignees: list[str]) -> httpx.Response:
    async with await _client() as c:
        return await c.post("/api/v1/tasks", json={"title": "Please look at this", "assigneeIds": assignees})


async def _written_for(user_id: str) -> tuple[int, int]:
    """(task_assignees rows, outbox events) that name this user as an assignee."""
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        rows = (
            await conn.execute(text("SELECT count(*) FROM task_assignees WHERE assignee_id = :u"), {"u": user_id})
        ).scalar()
        events = (
            await conn.execute(text("SELECT count(*) FROM outbox WHERE payload->>'assigneeId' = :u"), {"u": user_id})
        ).scalar()
    return rows, events


async def test_an_assignee_from_another_org_is_refused_and_nothing_is_written(db_app, seed_members):
    outsider = str(uuid.uuid4())
    await seed_members(OTHER_ORG, outsider)

    r = await _create([outsider])

    assert r.status_code == 400 and REFUSAL in r.text
    assert await _written_for(outsider) == (0, 0)


async def test_an_unknown_id_gets_the_same_refusal_as_a_foreign_one(db_app, seed_members):
    # Same answer either way: the endpoint must not tell "exists elsewhere" from "does not exist".
    r = await _create([str(uuid.uuid4())])

    assert r.status_code == 400 and REFUSAL in r.text


async def test_a_deactivated_member_is_refused(db_app, seed_members):
    gone = str(uuid.uuid4())
    await seed_members(ORG, gone)
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(text("UPDATE user_projection SET active = false WHERE user_id = :u"), {"u": gone})

    r = await _create([gone])

    assert r.status_code == 400 and REFUSAL in r.text
    assert await _written_for(gone) == (0, 0)


async def test_one_bad_assignee_refuses_the_whole_task(db_app, seed_members):
    colleague, outsider = str(uuid.uuid4()), str(uuid.uuid4())
    await seed_members(ORG, colleague)
    await seed_members(OTHER_ORG, outsider)

    r = await _create([colleague, outsider])

    assert r.status_code == 400
    assert await _written_for(colleague) == (0, 0)  # the valid one is not assigned either


async def test_a_colleague_is_still_assigned_whatever_the_uuid_spelling(db_app, seed_members):
    colleague = str(uuid.uuid4())
    await seed_members(ORG, colleague)

    r = await _create([colleague.upper()])

    assert r.status_code == 201, r.text
    assert (await _written_for(colleague))[0] == 1
