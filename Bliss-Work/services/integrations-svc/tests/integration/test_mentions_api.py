"""End-to-end mentions API against a real Postgres.

The claim flow's whole safety argument rests on two things working together:
a deterministic idempotency key, and a conditional UPDATE guarded on
`mention_state='pending'`. Unit tests cover each half; only this suite proves
they compose — including the nasty case where the task IS created but the claim
write is lost.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
import uuid6
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "11111111-1111-1111-1111-111111111111"
ME = "33333333-3333-3333-3333-333333333333"
OTHER = "44444444-4444-4444-4444-444444444444"
# claimed_task_id is a uuid column, and task-svc returns uuid7 — a fake id like
# "task-1" is rejected by Postgres, so the stubs must look like the real thing.
TASK_1 = "55555555-5555-5555-5555-555555555551"
TASK_2 = "55555555-5555-5555-5555-555555555552"


def _principal(user_id=ME, org_id=ORG):
    from app.auth import Principal

    return Principal(user_id=user_id, org_id=org_id, roles=["member"], username="me")


async def _client(monkeypatch, principal=None, task_ids=None):
    """The real ASGI app with auth stubbed and task-svc faked."""
    from app import task_client
    from app.auth import require_principal
    from app.main import app
    from app.routes import mentions

    app.dependency_overrides[require_principal] = lambda: principal or _principal()

    created: list[dict] = []
    ids = list(task_ids or [])

    async def fake_create_task(*, bearer, activity_id, title, description, assignee_id):
        # Mirror task-svc's real contract: a repeated idempotency key returns the
        # ORIGINAL task id rather than making a second task.
        key = task_client.claim_idempotency_key(activity_id)
        for c in created:
            if c["key"] == key:
                return c["taskId"]
        task_id = ids.pop(0) if ids else str(uuid.uuid4())
        created.append(
            {"key": key, "taskId": task_id, "assignee": assignee_id, "title": title}
        )
        return task_id

    monkeypatch.setattr(mentions, "create_task", fake_create_task)
    transport = httpx.ASGITransport(app=app)
    client = httpx.AsyncClient(transport=transport, base_url="http://t")
    return client, created


async def _seed_mention(state="pending", user_id=ME, org_id=ORG, body="please review"):
    """Insert one connection + one mention row, returning the activity id."""
    from app.crypto import cryptor
    from app.db import session, set_bypass_rls

    conn_id = str(uuid6.uuid7())
    act_id = str(uuid6.uuid7())
    async with session() as db:
        await set_bypass_rls(db)
        await db.execute(
            text(
                "INSERT INTO integration_connections (id, org_id, owner_user_id, created_by,"
                " provider, status) VALUES (:i,:o,:u,:u,'slack','connected')"
            ),
            {"i": conn_id, "o": org_id, "u": user_id},
        )
        await db.execute(
            text(
                """
                INSERT INTO provider_activity
                    (id, org_id, owner_user_id, connection_id, provider, direction, kind,
                     peer_enc, body_enc, status, occurred_at,
                     is_mention, mention_user_id, mention_state, claimed_task_id)
                VALUES (:i,:o,:u,:c,'slack','inbound','message',:peer,:body,'received', now(),
                        true, :u, :state, :tid)
                """
            ),
            {
                "i": act_id,
                "o": org_id,
                "u": user_id,
                "c": conn_id,
                "peer": await cryptor().encrypt(db, org_id, "U0123"),
                "body": await cryptor().encrypt(db, org_id, body),
                "state": state,
                # The CHECK constraint requires a task id whenever state='claimed'.
                "tid": str(uuid.uuid4()) if state == "claimed" else None,
            },
        )
        await db.commit()
    return act_id


async def _state_of(act_id):
    from app.db import session, set_bypass_rls

    async with session() as db:
        await set_bypass_rls(db)
        row = (
            await db.execute(
                text(
                    "SELECT mention_state, claimed_task_id, claimed_by"
                    "  FROM provider_activity WHERE id = :i"
                ),
                {"i": act_id},
            )
        ).one()
    return row


# ── listing ───────────────────────────────────────────────────────────────────
async def test_pending_mention_is_listed_and_decrypted(db_app, monkeypatch):
    act = await _seed_mention(body="can you look at this")
    client, _ = await _client(monkeypatch)
    r = await client.get("/api/v1/integrations/mentions")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1
    assert items[0]["id"] == act
    assert items[0]["body"] == "can you look at this"
    assert items[0]["state"] == "pending"


async def test_another_users_mention_is_invisible(db_app, monkeypatch):
    await _seed_mention(user_id=OTHER)
    client, _ = await _client(monkeypatch)
    r = await client.get("/api/v1/integrations/mentions")
    assert r.json()["items"] == []


async def test_state_filter_separates_the_tabs(db_app, monkeypatch):
    await _seed_mention(state="pending")
    await _seed_mention(state="ignored")
    client, _ = await _client(monkeypatch)
    assert len((await client.get("/api/v1/integrations/mentions?state=pending")).json()["items"]) == 1
    assert len((await client.get("/api/v1/integrations/mentions?state=ignored")).json()["items"]) == 1


async def test_invalid_state_and_cursor_are_400_not_500(db_app, monkeypatch):
    client, _ = await _client(monkeypatch)
    assert (await client.get("/api/v1/integrations/mentions?state=bogus")).status_code == 400
    assert (await client.get("/api/v1/integrations/mentions?cursor=!!!")).status_code == 400


async def test_pagination_walks_every_row_exactly_once(db_app, monkeypatch):
    for i in range(5):
        await _seed_mention(body=f"msg{i}")
    client, _ = await _client(monkeypatch)

    seen, cursor, pages = [], None, 0
    while True:
        url = "/api/v1/integrations/mentions?limit=2" + (f"&cursor={cursor}" if cursor else "")
        page = (await client.get(url)).json()
        seen.extend(i["id"] for i in page["items"])
        pages += 1
        cursor = page["nextCursor"]
        if not cursor or pages > 10:
            break

    assert len(seen) == 5, "every row returned"
    assert len(set(seen)) == 5, "no row returned twice"


async def test_limit_is_clamped(db_app, monkeypatch):
    client, _ = await _client(monkeypatch)
    assert (await client.get("/api/v1/integrations/mentions?limit=500")).status_code == 422


# ── claim ─────────────────────────────────────────────────────────────────────
async def test_claim_creates_a_task_assigned_to_me(db_app, monkeypatch):
    act = await _seed_mention()
    client, created = await _client(monkeypatch, task_ids=[TASK_1])

    r = await client.post(f"/api/v1/integrations/mentions/{act}/claim")
    assert r.status_code == 200
    assert r.json() == {"taskId": TASK_1, "state": "claimed"}

    assert created[0]["assignee"] == ME, "allocated to me"
    row = await _state_of(act)
    assert row.mention_state == "claimed"
    assert str(row.claimed_task_id) == TASK_1
    assert str(row.claimed_by) == ME


async def test_claiming_twice_yields_one_task(db_app, monkeypatch):
    act = await _seed_mention()
    client, created = await _client(monkeypatch, task_ids=[TASK_1])

    first = await client.post(f"/api/v1/integrations/mentions/{act}/claim")
    second = await client.post(f"/api/v1/integrations/mentions/{act}/claim")

    assert first.json()["taskId"] == second.json()["taskId"]
    assert len(created) == 1, "a re-click must not create a second task"


async def test_claim_self_heals_when_the_claim_write_was_lost(db_app, monkeypatch):
    """The nastiest window: task-svc created the task, then we crashed before
    recording it. The row is still pending, so the user clicks again — and the
    deterministic key must return the SAME task rather than making a new one."""
    act = await _seed_mention()
    client, created = await _client(monkeypatch, task_ids=[TASK_1, TASK_2])

    # Simulate the lost write: create the task through the same fake, but never
    # let the route record it.
    from app.routes import mentions

    original = mentions.create_task
    lost = await original(
        bearer="B", activity_id=act, title="t", description="d", assignee_id=ME
    )
    assert (await _state_of(act)).mention_state == "pending"

    # User retries.
    r = await client.post(f"/api/v1/integrations/mentions/{act}/claim")
    assert r.json()["taskId"] == lost, "retry re-uses the original task"
    assert len(created) == 1, "still exactly one task"
    assert (await _state_of(act)).mention_state == "claimed"


async def test_claim_after_ignore_is_409(db_app, monkeypatch):
    act = await _seed_mention(state="ignored")
    client, created = await _client(monkeypatch)
    r = await client.post(f"/api/v1/integrations/mentions/{act}/claim")
    assert r.status_code == 409
    assert created == [], "no task for a dismissed mention"


async def test_claiming_someone_elses_mention_is_404_not_403(db_app, monkeypatch):
    # 403 would confirm the row exists — i.e. leak that a colleague was tagged.
    act = await _seed_mention(user_id=OTHER)
    client, created = await _client(monkeypatch)
    assert (await client.post(f"/api/v1/integrations/mentions/{act}/claim")).status_code == 404
    assert created == []


async def test_claim_leaves_the_mention_pending_when_task_svc_fails(db_app, monkeypatch):
    act = await _seed_mention()
    client, _ = await _client(monkeypatch)

    from app.routes import mentions
    from app.task_client import TaskServiceError

    async def boom(**_kw):
        raise TaskServiceError("task-svc down")

    monkeypatch.setattr(mentions, "create_task", boom)

    r = await client.post(f"/api/v1/integrations/mentions/{act}/claim")
    assert r.status_code == 502
    assert (await _state_of(act)).mention_state == "pending", "retryable, nothing stranded"


async def test_claim_of_unknown_id_is_404(db_app, monkeypatch):
    client, _ = await _client(monkeypatch)
    r = await client.post(f"/api/v1/integrations/mentions/{uuid6.uuid7()}/claim")
    assert r.status_code == 404


# ── ignore ────────────────────────────────────────────────────────────────────
async def test_ignore_dismisses_and_is_idempotent(db_app, monkeypatch):
    act = await _seed_mention()
    client, _ = await _client(monkeypatch)

    assert (await client.post(f"/api/v1/integrations/mentions/{act}/ignore")).status_code == 200
    # Second call is a no-op success, not an error.
    assert (await client.post(f"/api/v1/integrations/mentions/{act}/ignore")).status_code == 200
    assert (await _state_of(act)).mention_state == "ignored"

    # And it stays gone from the pending feed after a reload.
    assert (await client.get("/api/v1/integrations/mentions")).json()["items"] == []


async def test_ignore_after_claim_is_409(db_app, monkeypatch):
    act = await _seed_mention()
    client, _ = await _client(monkeypatch, task_ids=[TASK_1])
    await client.post(f"/api/v1/integrations/mentions/{act}/claim")

    r = await client.post(f"/api/v1/integrations/mentions/{act}/ignore")
    assert r.status_code == 409
    assert (await _state_of(act)).mention_state == "claimed"


async def test_ignoring_someone_elses_mention_is_404(db_app, monkeypatch):
    act = await _seed_mention(user_id=OTHER)
    client, _ = await _client(monkeypatch)
    assert (await client.post(f"/api/v1/integrations/mentions/{act}/ignore")).status_code == 404


# ── declared handles ──────────────────────────────────────────────────────────
async def test_declare_list_and_delete_a_handle(db_app, monkeypatch):
    client, _ = await _client(monkeypatch)

    created = await client.post(
        "/api/v1/integrations/identities", json={"provider": "slack", "handle": "U0123ABCD"}
    )
    assert created.status_code == 201
    ident = created.json()
    assert ident["handle"] == "U0123ABCD"
    assert ident["source"] == "declared"

    listed = await client.get("/api/v1/integrations/identities")
    assert [i["id"] for i in listed.json()] == [ident["id"]]

    assert (
        await client.delete(f"/api/v1/integrations/identities/{ident['id']}")
    ).status_code == 204
    assert (await client.get("/api/v1/integrations/identities")).json() == []


async def test_a_handle_already_owned_by_a_teammate_is_409(db_app, monkeypatch):
    # Otherwise one user could farm another user's mentions into their own list.
    client_other, _ = await _client(monkeypatch, principal=_principal(user_id=OTHER))
    await client_other.post(
        "/api/v1/integrations/identities", json={"provider": "slack", "handle": "U0123ABCD"}
    )

    client_me, _ = await _client(monkeypatch)
    r = await client_me.post(
        "/api/v1/integrations/identities", json={"provider": "slack", "handle": "U0123ABCD"}
    )
    assert r.status_code == 409


async def test_redeclaring_my_own_handle_is_not_an_error(db_app, monkeypatch):
    client, _ = await _client(monkeypatch)
    body = {"provider": "slack", "handle": "U0123ABCD"}
    assert (await client.post("/api/v1/integrations/identities", json=body)).status_code == 201
    assert (await client.post("/api/v1/integrations/identities", json=body)).status_code == 201
    assert len((await client.get("/api/v1/integrations/identities")).json()) == 1


async def test_blank_handle_is_rejected(db_app, monkeypatch):
    client, _ = await _client(monkeypatch)
    r = await client.post(
        "/api/v1/integrations/identities", json={"provider": "slack", "handle": "   "}
    )
    assert r.status_code == 400


async def test_deleting_someone_elses_handle_is_404(db_app, monkeypatch):
    client_other, _ = await _client(monkeypatch, principal=_principal(user_id=OTHER))
    ident = (
        await client_other.post(
            "/api/v1/integrations/identities", json={"provider": "slack", "handle": "U9"}
        )
    ).json()

    client_me, _ = await _client(monkeypatch)
    assert (
        await client_me.delete(f"/api/v1/integrations/identities/{ident['id']}")
    ).status_code == 404
