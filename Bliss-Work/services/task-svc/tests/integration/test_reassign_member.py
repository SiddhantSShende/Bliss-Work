"""`POST /tasks/{id}/assignees/{userId}/reassign` — reopening one member's row
without waiting for (or touching) the rest of the task.

The scenario the whole-task `/reassign` route can't reach: Divya is assigned a
task, ignores it, but other assignees are still actively working it, so the
task is not eligible for the whole-task route. This hands just Divya's row
back to her.

Same real app, RLS, migrations, transition routes and outbox as
`test_reassign_task.py`; nothing is stubbed.
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


def _id() -> str:
    return str(uuid.uuid4())


async def _as(user_id: str, org: str = ORG) -> httpx.AsyncClient:
    from app.auth import Principal, require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: Principal(
        user_id=user_id, org_id=org, roles=["member"], username="u"
    )
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _q(sql: str, **params) -> list:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        return (await conn.execute(text(sql), params)).all()


async def _new_task(*assignees: str, **extra) -> str:
    async with await _as(SENDER) as c:
        r = await c.post(
            "/api/v1/tasks",
            json={
                "taskTitle": "Review report",
                "title": "Review report",
                "description": "Q3 numbers",
                "assigneeIds": list(assignees),
                **extra,
            },
        )
    assert r.status_code == 201, r.text
    return r.json()["taskId"]


async def _act(user_id: str, task_id: str, action: str) -> httpx.Response:
    async with await _as(user_id) as c:
        return await c.post(f"/api/v1/tasks/{task_id}/assignees/me/{action}")


async def _complete(user_id: str, task_id: str) -> None:
    for action in ("acknowledge", "complete"):
        r = await _act(user_id, task_id, action)
        assert r.status_code == 200, r.text


async def _reassign_member(task_id: str, assignee_id: str, user_id: str = SENDER, org: str = ORG) -> httpx.Response:
    async with await _as(user_id, org) as c:
        return await c.post(f"/api/v1/tasks/{task_id}/assignees/{assignee_id}/reassign")


async def _rows(task_id: str) -> dict[str, object]:
    rows = await _q(
        "SELECT assignee_id, status, status_version, assigned_at, acknowledged_at, completed_at "
        "FROM task_assignees WHERE task_id = :t",
        t=task_id,
    )
    return {str(r.assignee_id): r for r in rows}


async def test_an_ignoring_member_can_be_reassigned_while_others_are_still_active(db_app, seed_members):
    divya, bob = _id(), _id()
    await seed_members(ORG, divya, bob)
    task_id = await _new_task(divya, bob)
    assert (await _act(divya, task_id, "ignore")).status_code == 200
    await _act(bob, task_id, "acknowledge")  # bob keeps working it
    before = (await _rows(task_id))[divya]

    r = await _reassign_member(task_id, divya)

    assert r.status_code == 200, r.text
    assert r.json() == {"taskId": task_id, "assigneeId": divya}
    after = await _rows(task_id)
    assert after[divya].status == "SENT"
    assert after[divya].status_version == before.status_version + 1
    assert after[divya].assigned_at > before.assigned_at
    assert after[divya].acknowledged_at is None and after[divya].completed_at is None
    # Bob's row is completely untouched.
    assert after[bob].status == "ACKNOWLEDGED"


async def test_reassigning_divya_does_not_change_other_members_states_or_assignments(db_app, seed_members):
    divya, bob, carol = _id(), _id(), _id()
    await seed_members(ORG, divya, bob, carol)
    task_id = await _new_task(divya, bob, carol)
    assert (await _act(divya, task_id, "ignore")).status_code == 200
    await _act(bob, task_id, "acknowledge")
    await _complete(carol, task_id)
    before = await _rows(task_id)

    await _reassign_member(task_id, divya)

    after = await _rows(task_id)
    assert sorted(after) == sorted([divya, bob, carol])  # nobody added or removed
    for u in (bob, carol):
        assert (after[u].status, after[u].status_version) == (before[u].status, before[u].status_version)


async def test_divya_reappears_in_her_inbox_with_the_normal_actions(db_app, seed_members):
    divya, bob = _id(), _id()
    await seed_members(ORG, divya, bob)
    task_id = await _new_task(divya, bob)
    assert (await _act(divya, task_id, "ignore")).status_code == 200
    await _act(bob, task_id, "acknowledge")
    async with await _as(divya) as c:
        inbox_before = {t["taskId"] for t in (await c.get("/api/v1/tasks/inbox")).json()}
    assert task_id not in inbox_before

    await _reassign_member(task_id, divya)

    async with await _as(divya) as c:
        inbox = (await c.get("/api/v1/tasks/inbox")).json()
    mine = next(t for t in inbox if t["taskId"] == task_id)
    assert mine["myStatus"] == "SENT" and mine["actions"] == ["ACKNOWLEDGE", "IGNORE"]


async def test_member_reassignment_does_not_complete_or_otherwise_change_the_task_lifecycle(db_app, seed_members):
    divya, bob = _id(), _id()
    await seed_members(ORG, divya, bob)
    task_id = await _new_task(divya, bob)
    assert (await _act(divya, task_id, "ignore")).status_code == 200
    await _act(bob, task_id, "acknowledge")

    await _reassign_member(task_id, divya)

    # Tasks carry no aggregate "status" column of their own in this schema beyond
    # the per-assignee rows; what matters is bob's row, untouched and still open.
    assert (await _rows(task_id))[bob].status == "ACKNOWLEDGED"


async def test_whole_task_reassign_is_still_refused_while_bob_remains_active(db_app, seed_members):
    divya, bob = _id(), _id()
    await seed_members(ORG, divya, bob)
    task_id = await _new_task(divya, bob)
    assert (await _act(divya, task_id, "ignore")).status_code == 200
    await _act(bob, task_id, "acknowledge")

    await _reassign_member(task_id, divya)

    async with await _as(SENDER) as c:
        r = await c.post(f"/api/v1/tasks/{task_id}/reassign")
    assert r.status_code == 409, r.text


async def test_whole_task_reassign_still_works_once_the_lifecycle_actually_completes(db_app, seed_members):
    a, b = _id(), _id()
    await seed_members(ORG, a, b)
    task_id = await _new_task(a, b)
    for u in (a, b):
        await _complete(u, task_id)

    async with await _as(SENDER) as c:
        r = await c.post(f"/api/v1/tasks/{task_id}/reassign")
    assert r.status_code == 200, r.text
    assert sorted(r.json()["reassignedUserIds"]) == sorted([a, b])


async def test_a_still_active_member_has_nothing_to_reassign(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _new_task(a)

    r = await _reassign_member(task_id, a)

    assert r.status_code == 409, r.text
    assert "nothing to reassign" in r.json()["error"]["message"]
    assert (await _rows(task_id))[a].status == "SENT"


async def test_a_missed_member_has_nothing_to_reassign_at_the_member_level_either(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _new_task(a)
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text("UPDATE task_assignees SET status = 'MISSED', missed_at = now() WHERE task_id = :t AND assignee_id = :u"),
            {"t": task_id, "u": a},
        )

    r = await _reassign_member(task_id, a)

    assert r.status_code == 409, r.text
    assert (await _rows(task_id))[a].status == "MISSED"


async def test_only_the_allocator_may_reassign_a_member(db_app, seed_members):
    divya, bystander = _id(), _id()
    await seed_members(ORG, divya, bystander)
    task_id = await _new_task(divya)
    assert (await _act(divya, task_id, "ignore")).status_code == 200

    for who in (divya, bystander):
        r = await _reassign_member(task_id, divya, who)
        assert r.status_code == 403, (who, r.text)

    assert (await _rows(task_id))[divya].status == "IGNORED"


async def test_an_assignee_not_on_the_task_is_404(db_app, seed_members):
    a, outsider = _id(), _id()
    await seed_members(ORG, a, outsider)
    task_id = await _new_task(a)
    assert (await _act(a, task_id, "ignore")).status_code == 200

    r = await _reassign_member(task_id, outsider)

    assert r.status_code == 404, r.text


async def test_another_org_cannot_see_or_reassign_a_member(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _new_task(a)
    assert (await _act(a, task_id, "ignore")).status_code == 200

    r = await _reassign_member(task_id, a, SENDER, OTHER_ORG)

    assert r.status_code == 404, r.text
    assert (await _rows(task_id))[a].status == "IGNORED"


async def test_unknown_and_malformed_ids_are_404_for_member_reassign(db_app):
    assert (await _reassign_member(_id(), _id())).status_code == 404
    assert (await _reassign_member("not-a-uuid", _id())).status_code == 404
    assert (await _reassign_member(_id(), "not-a-uuid")).status_code == 404


async def test_a_task_past_its_deadline_cannot_have_a_member_reassigned(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _new_task(a)
    assert (await _act(a, task_id, "ignore")).status_code == 200
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(text("UPDATE tasks SET deadline_at = now() - interval '1 minute' WHERE id = :t"), {"t": task_id})

    r = await _reassign_member(task_id, a)

    assert r.status_code == 409 and "deadline" in r.json()["error"]["message"]
    assert (await _rows(task_id))[a].status == "IGNORED"


async def test_a_second_request_for_the_same_member_is_refused_and_creates_no_duplicates(db_app, seed_members):
    a, b = _id(), _id()
    await seed_members(ORG, a, b)
    task_id = await _new_task(a, b)
    assert (await _act(a, task_id, "ignore")).status_code == 200
    await _act(b, task_id, "acknowledge")

    first = await _reassign_member(task_id, a)
    second = await _reassign_member(task_id, a)

    assert first.status_code == 200 and second.status_code == 409
    assert sorted(await _rows(task_id)) == sorted([a, b])


async def test_a_completed_member_can_also_be_reassigned_individually(db_app, seed_members):
    a, b = _id(), _id()
    await seed_members(ORG, a, b)
    task_id = await _new_task(a, b)
    await _complete(a, task_id)
    await _act(b, task_id, "acknowledge")
    before = (await _rows(task_id))[a]

    r = await _reassign_member(task_id, a)

    assert r.status_code == 200, r.text
    after = await _rows(task_id)
    assert after[a].status == "SENT"
    assert after[a].status_version == before.status_version + 1
    assert after[b].status == "ACKNOWLEDGED"


async def test_a_left_member_can_also_be_reassigned_individually(db_app, seed_members):
    a, b = _id(), _id()
    await seed_members(ORG, a, b)
    task_id = await _new_task(a, b)
    await _act(a, task_id, "acknowledge")
    assert (await _act(a, task_id, "leave")).status_code == 200
    await _act(b, task_id, "acknowledge")

    r = await _reassign_member(task_id, a)

    assert r.status_code == 200, r.text
    assert (await _rows(task_id))[a].status == "SENT"
