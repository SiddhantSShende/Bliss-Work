"""Task comments (routes/tasks_comments.py): a task-scoped, text-only
threaded discussion, separate from Chat (messaging-svc's task_discussions —
the task-linked conversation the Chat button opens, which this suite never
touches). Covers:

  * only the task's sender and its assignees can read or post (404, not 403,
    for anyone else — same "don't disclose existence" convention as
    messaging-svc's internal channel-members lookup);
  * three top-level comments load by default, newest-first, and the keyset
    cursor stays stable when a new comment arrives mid-pagination;
  * a reply nests under its TOP-LEVEL parent only (one reply level — the
    thread cannot grow a third level) and must belong to the same task;
  * blank/whitespace-only comments are rejected;
  * the outbox event is signal-only (no comment text) and addressed to every
    current participant.
"""

from __future__ import annotations

import json

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
SENDER = "33333333-3333-3333-3333-333333333333"
ASSIGNEE = "44444444-4444-4444-4444-444444444444"
OUTSIDER = "55555555-5555-5555-5555-555555555555"


def _principal(user_id: str, org_id: str = ORG):
    from app.auth import Principal

    return Principal(user_id=user_id, org_id=org_id, roles=["member"], username=user_id[:8])


async def _client(user_id: str, org_id: str = ORG) -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: _principal(user_id, org_id)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def _q(sql: str, **params) -> list:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        result = await conn.execute(text(sql), params)
        return result.all() if result.returns_rows else []


def _payload(row) -> dict:
    return json.loads(row.payload) if isinstance(row.payload, str) else row.payload


async def _comment_events(task_id: str) -> list[dict]:
    rows = await _q(
        "SELECT payload FROM outbox WHERE kafka_key = :t AND payload->>'type' = 'task.comment_created'",
        t=task_id,
    )
    return [_payload(r) for r in rows]


async def _create_task(sender: str = SENDER, assignee: str = ASSIGNEE) -> str:
    async with await _client(sender) as c:
        r = await c.post(
            "/api/v1/tasks",
            json={
                "taskTitle": "Comments test task",
                "title": "Comments test task",
                "assigneeIds": [assignee],
            },
        )
        assert r.status_code == 201, r.text
        return r.json()["taskId"]


async def test_sender_and_assignee_can_post_and_read_comments(db_app, seed_members):
    await seed_members(ORG, SENDER, ASSIGNEE)
    task_id = await _create_task()

    async with await _client(SENDER) as c:
        r = await c.post(f"/api/v1/tasks/{task_id}/comments", json={"body": "First comment"})
        assert r.status_code == 200, r.text
        comment = r.json()
        assert comment["body"] == "First comment"
        assert comment["parentCommentId"] is None
        assert comment["authorId"] == SENDER

    async with await _client(ASSIGNEE) as c:
        r = await c.get(f"/api/v1/tasks/{task_id}/comments")
        assert r.status_code == 200, r.text
        page = r.json()
        assert len(page["comments"]) == 1
        assert page["comments"][0]["body"] == "First comment"
        assert page["hasMore"] is False


async def test_outsider_gets_404_not_403_on_read_or_write(db_app, seed_members):
    await seed_members(ORG, SENDER, ASSIGNEE, OUTSIDER)
    task_id = await _create_task()

    async with await _client(OUTSIDER) as c:
        assert (await c.get(f"/api/v1/tasks/{task_id}/comments")).status_code == 404
        r = await c.post(f"/api/v1/tasks/{task_id}/comments", json={"body": "sneaky"})
        assert r.status_code == 404


async def test_blank_comment_is_rejected(db_app, seed_members):
    await seed_members(ORG, SENDER, ASSIGNEE)
    task_id = await _create_task()
    async with await _client(SENDER) as c:
        r = await c.post(f"/api/v1/tasks/{task_id}/comments", json={"body": "   "})
        assert r.status_code == 422


async def test_pagination_three_then_load_more_is_stable_under_a_late_insert(db_app, seed_members):
    await seed_members(ORG, SENDER, ASSIGNEE)
    task_id = await _create_task()

    async with await _client(SENDER) as c:
        for i in range(5):
            r = await c.post(f"/api/v1/tasks/{task_id}/comments", json={"body": f"comment {i}"})
            assert r.status_code == 200, r.text

        page1 = (await c.get(f"/api/v1/tasks/{task_id}/comments")).json()
        assert len(page1["comments"]) == 3
        assert page1["hasMore"] is True
        # Newest-first: "comment 4" was posted last.
        assert page1["comments"][0]["body"] == "comment 4"

        # Posted while the first page is already on screen — a keyset cursor
        # must not reshuffle or repeat what was already loaded.
        late = await c.post(f"/api/v1/tasks/{task_id}/comments", json={"body": "comment 5 (late)"})
        assert late.status_code == 200, late.text

        page2 = (
            await c.get(f"/api/v1/tasks/{task_id}/comments", params={"cursor": page1["nextCursor"]})
        ).json()
        bodies = [c["body"] for c in page1["comments"]] + [c["body"] for c in page2["comments"]]
        assert len(set(bodies)) == len(bodies), "no comment repeated across pages"
        assert "comment 5 (late)" not in bodies
        assert page2["hasMore"] is False
        assert len(page2["comments"]) == 2


async def test_reply_nests_under_its_parent_and_counts_toward_reply_count(db_app, seed_members):
    await seed_members(ORG, SENDER, ASSIGNEE)
    task_id = await _create_task()

    async with await _client(SENDER) as c:
        top = (await c.post(f"/api/v1/tasks/{task_id}/comments", json={"body": "top"})).json()

    async with await _client(ASSIGNEE) as c:
        reply = await c.post(
            f"/api/v1/tasks/{task_id}/comments/{top['id']}/replies", json={"body": "a reply"}
        )
        assert reply.status_code == 200, reply.text
        assert reply.json()["parentCommentId"] == top["id"]

        listing = (await c.get(f"/api/v1/tasks/{task_id}/comments")).json()
        assert listing["comments"][0]["replyCount"] == 1

        replies_page = (
            await c.get(f"/api/v1/tasks/{task_id}/comments/{top['id']}/replies")
        ).json()
        assert len(replies_page["comments"]) == 1
        assert replies_page["comments"][0]["body"] == "a reply"


async def test_reply_cannot_target_a_comment_from_a_different_task(db_app, seed_members):
    await seed_members(ORG, SENDER, ASSIGNEE)
    task_a = await _create_task()
    task_b = await _create_task()

    async with await _client(SENDER) as c:
        top_a = (await c.post(f"/api/v1/tasks/{task_a}/comments", json={"body": "on task A"})).json()
        r = await c.post(
            f"/api/v1/tasks/{task_b}/comments/{top_a['id']}/replies",
            json={"body": "sneaky cross-task reply"},
        )
        assert r.status_code == 404


async def test_reply_cannot_target_another_reply(db_app, seed_members):
    await seed_members(ORG, SENDER, ASSIGNEE)
    task_id = await _create_task()
    async with await _client(SENDER) as c:
        top = (await c.post(f"/api/v1/tasks/{task_id}/comments", json={"body": "top"})).json()
        reply = (
            await c.post(f"/api/v1/tasks/{task_id}/comments/{top['id']}/replies", json={"body": "r1"})
        ).json()
        r = await c.post(
            f"/api/v1/tasks/{task_id}/comments/{reply['id']}/replies",
            json={"body": "r2 - too deep"},
        )
        assert r.status_code == 404


async def test_comment_emits_a_signal_only_event_to_every_participant(db_app, seed_members):
    await seed_members(ORG, SENDER, ASSIGNEE)
    task_id = await _create_task()
    async with await _client(ASSIGNEE) as c:
        posted = (
            await c.post(f"/api/v1/tasks/{task_id}/comments", json={"body": "secret content"})
        ).json()

    events = await _comment_events(task_id)
    assert len(events) == 1
    evt = events[0]
    assert evt["taskId"] == task_id
    assert evt["commentId"] == posted["id"]
    assert evt["parentCommentId"] is None
    assert evt["authorId"] == ASSIGNEE
    assert sorted(evt["members"]) == sorted([SENDER, ASSIGNEE])
    assert "secret content" not in json.dumps(evt)
