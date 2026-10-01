"""`POST /tasks/{id}/reassign` — reopening a COMPLETED task for the same people.

The real app, RLS, migrations, transition routes and outbox on a real Postgres;
nothing is stubbed. Tasks are completed through the real acknowledge / complete
routes, so the rows the reassignment starts from are the ones production produces.
"""

from __future__ import annotations

import json
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
            json={"title": "Review report", "description": "Q3 numbers", "assigneeIds": list(assignees), **extra},
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


async def _reassign(task_id: str, user_id: str = SENDER, org: str = ORG) -> httpx.Response:
    async with await _as(user_id, org) as c:
        return await c.post(f"/api/v1/tasks/{task_id}/reassign")


async def _rows(task_id: str) -> dict[str, object]:
    rows = await _q(
        "SELECT assignee_id, status, status_version, assigned_at, acknowledged_at, completed_at, "
        "       review_rating, reviewed_at FROM task_assignees WHERE task_id = :t",
        t=task_id,
    )
    return {str(r.assignee_id): r for r in rows}


async def _events(task_id: str, type_: str | None = None) -> list[dict]:
    rows = await _q("SELECT payload FROM outbox WHERE kafka_key = :t ORDER BY created_at, id", t=task_id)
    out = [json.loads(r.payload) if isinstance(r.payload, str) else r.payload for r in rows]
    return [e for e in out if type_ is None or e["type"] == type_]


async def _task_row(task_id: str):
    return (await _q("SELECT title_enc, description_enc, sender_id, deadline_at FROM tasks WHERE id = :t", t=task_id))[0]


async def test_completed_task_returns_to_the_same_person_as_sent(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _new_task(a)
    await _complete(a, task_id)
    before = (await _rows(task_id))[a]
    task_before = await _task_row(task_id)
    assert before.status == "COMPLETED" and before.completed_at is not None

    r = await _reassign(task_id)

    assert r.status_code == 200, r.text
    assert r.json() == {"taskId": task_id, "reassignedUserIds": [a]}
    after = (await _rows(task_id))[a]
    assert after.status == "SENT"
    assert after.status_version == before.status_version + 1
    assert after.acknowledged_at is None and after.completed_at is None
    assert after.assigned_at > before.assigned_at
    # The task itself is not touched: same title, description (encrypted at rest), sender.
    task_after = await _task_row(task_id)
    assert bytes(task_after.title_enc) == bytes(task_before.title_enc)
    assert bytes(task_after.description_enc) == bytes(task_before.description_enc)
    assert task_after.sender_id == task_before.sender_id


async def test_every_original_assignee_is_restored_once_and_nobody_is_added(db_app, seed_members):
    a, b, c = _id(), _id(), _id()
    outsider = _id()
    await seed_members(ORG, a, b, c, outsider)
    task_id = await _new_task(a, b, c)
    for u in (a, b, c):
        await _complete(u, task_id)

    r = await _reassign(task_id)

    assert r.status_code == 200, r.text
    assert sorted(r.json()["reassignedUserIds"]) == sorted([a, b, c])
    rows = await _rows(task_id)
    assert sorted(rows) == sorted([a, b, c])  # no row added, none removed, none duplicated
    assert {r.status for r in rows.values()} == {"SENT"}
    assert outsider not in rows


async def test_reassignment_emits_one_task_assigned_per_person_that_downstream_services_already_handle(db_app, seed_members):
    a, b = _id(), _id()
    await seed_members(ORG, a, b)
    task_id = await _new_task(a, b)
    for u in (a, b):
        await _complete(u, task_id)
    first_round = await _events(task_id, "task.assigned")
    assert len(first_round) == 2

    await _reassign(task_id)

    second_round = (await _events(task_id, "task.assigned"))[2:]
    assert sorted(e["assigneeId"] for e in second_round) == sorted([a, b])
    versions = {e["assigneeId"]: e["statusVersion"] for e in second_round}
    rows = await _rows(task_id)
    for u in (a, b):
        assert versions[u] == rows[u].status_version  # monotonic, never reset to 0
        assert versions[u] > 0
    for e in second_round:
        assert e["senderId"] == SENDER
        assert e["title"] == "Review report" and e["description"] == "Q3 numbers"
        assert sorted(e["members"]) == sorted([SENDER, a, b])
    # The earlier completion events are still on the record.
    assert len(await _events(task_id, "task.completed")) == 2


async def test_only_completed_assignments_are_restored_individual_outcomes_stand(db_app, seed_members):
    done, left, ignored, missed = _id(), _id(), _id(), _id()
    await seed_members(ORG, done, left, ignored, missed)
    task_id = await _new_task(done, left, ignored, missed)
    await _complete(done, task_id)
    await _act(left, task_id, "acknowledge")
    assert (await _act(left, task_id, "leave")).status_code == 200
    assert (await _act(ignored, task_id, "ignore")).status_code == 200
    from app.db import get_engine

    # The deadline sweeper's outcome, set directly: moving a deadline is not an API.
    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text("UPDATE task_assignees SET status = 'MISSED', missed_at = now() WHERE task_id = :t AND assignee_id = :u"),
            {"t": task_id, "u": missed},
        )
    before = await _rows(task_id)

    r = await _reassign(task_id)

    assert r.status_code == 200, r.text
    assert r.json()["reassignedUserIds"] == [done]
    after = await _rows(task_id)
    assert after[done].status == "SENT"
    for u, status in ((left, "LEFT"), (ignored, "IGNORED"), (missed, "MISSED")):
        assert after[u].status == status
        assert after[u].status_version == before[u].status_version
    assert len(await _events(task_id, "task.assigned")) == 4 + 1


async def test_review_the_allocator_wrote_is_kept(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _new_task(a)
    await _complete(a, task_id)
    async with await _as(SENDER) as c:
        rv = await c.post(f"/api/v1/tasks/{task_id}/assignees/{a}/review", json={"text": "Not quite", "rating": 2})
    assert rv.status_code in (200, 201), rv.text

    await _reassign(task_id)

    row = (await _rows(task_id))[a]
    assert row.review_rating == 2 and row.reviewed_at is not None


async def test_a_task_someone_is_still_working_on_is_not_completed_and_is_refused(db_app, seed_members):
    a, b = _id(), _id()
    await seed_members(ORG, a, b)
    task_id = await _new_task(a, b)
    await _complete(a, task_id)  # b is still SENT
    before = await _rows(task_id)
    events_before = len(await _events(task_id))

    r = await _reassign(task_id)

    assert r.status_code == 409, r.text
    after = await _rows(task_id)
    assert {u: (x.status, x.status_version) for u, x in after.items()} == {u: (x.status, x.status_version) for u, x in before.items()}
    assert len(await _events(task_id)) == events_before


async def test_other_task_states_are_refused_and_untouched(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    sent, acked, left = await _new_task(a), await _new_task(a), await _new_task(a)
    await _act(a, acked, "acknowledge")
    await _act(a, left, "acknowledge")
    await _act(a, left, "leave")

    for task_id, status in ((sent, "SENT"), (acked, "ACKNOWLEDGED"), (left, "LEFT")):
        r = await _reassign(task_id)
        assert r.status_code == 409, (status, r.text)
        assert (await _rows(task_id))[a].status == status
        assert len(await _events(task_id, "task.assigned")) == 1


async def test_reassigning_another_completed_task_leaves_this_one_completed(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    t1, t2 = await _new_task(a), await _new_task(a)
    await _complete(a, t1)
    await _complete(a, t2)

    await _reassign(t1)

    assert (await _rows(t1))[a].status == "SENT"
    assert (await _rows(t2))[a].status == "COMPLETED"


async def test_a_second_request_is_refused_and_creates_no_duplicates(db_app, seed_members):
    a, b = _id(), _id()
    await seed_members(ORG, a, b)
    task_id = await _new_task(a, b)
    for u in (a, b):
        await _complete(u, task_id)

    first = await _reassign(task_id)
    second = await _reassign(task_id)

    assert first.status_code == 200 and second.status_code == 409
    assert sorted(await _rows(task_id)) == sorted([a, b])
    assert len(await _events(task_id, "task.assigned")) == 2 + 2  # the original two + one reopening each


async def test_only_the_allocator_may_reassign(db_app, seed_members):
    a, bystander = _id(), _id()
    await seed_members(ORG, a, bystander)
    task_id = await _new_task(a)
    await _complete(a, task_id)

    for who in (a, bystander):
        r = await _reassign(task_id, who)
        assert r.status_code == 403, (who, r.text)

    assert (await _rows(task_id))[a].status == "COMPLETED"
    assert len(await _events(task_id, "task.assigned")) == 1


async def test_another_org_cannot_see_or_reassign_it(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _new_task(a)
    await _complete(a, task_id)

    r = await _reassign(task_id, SENDER, OTHER_ORG)

    assert r.status_code == 404, r.text
    assert (await _rows(task_id))[a].status == "COMPLETED"


async def test_unknown_and_malformed_ids_are_404(db_app):
    assert (await _reassign(_id())).status_code == 404
    assert (await _reassign("not-a-uuid")).status_code == 404


async def test_a_task_past_its_deadline_cannot_be_reassigned(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _new_task(a)
    await _complete(a, task_id)
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(text("UPDATE tasks SET deadline_at = now() - interval '1 minute' WHERE id = :t"), {"t": task_id})

    r = await _reassign(task_id)

    assert r.status_code == 409 and "deadline" in r.json()["error"]["message"]
    assert (await _rows(task_id))[a].status == "COMPLETED"


async def test_the_reopened_assignment_is_actionable_again_and_can_complete_again(db_app, seed_members):
    a = _id()
    await seed_members(ORG, a)
    task_id = await _new_task(a)
    await _complete(a, task_id)

    async with await _as(a) as c:
        inbox_before = {t["taskId"] for t in (await c.get("/api/v1/tasks/inbox")).json()}
    await _reassign(task_id)
    async with await _as(a) as c:
        inbox = (await c.get("/api/v1/tasks/inbox")).json()
    async with await _as(SENDER) as c:
        sent = (await c.get("/api/v1/tasks/sent")).json()

    assert task_id not in inbox_before
    mine = next(t for t in inbox if t["taskId"] == task_id)
    assert mine["myStatus"] == "SENT" and mine["actions"] == ["ACKNOWLEDGE", "IGNORE"]
    assert next(t for t in sent if t["taskId"] == task_id)["assignees"][0]["status"] == "SENT"
    # It runs the normal lifecycle from here.
    await _complete(a, task_id)
    assert (await _rows(task_id))[a].status == "COMPLETED"
