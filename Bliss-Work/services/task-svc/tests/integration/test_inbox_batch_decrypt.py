"""`GET /tasks/inbox` end-to-end through the batch-decrypt pipeline.

Phase 5 replaced `_sticky_list`'s per-row `await cryptor().decrypt()` loop
with the peek_version -> warm_dek_versions -> decrypt_batch_cached split (see
crypto.py's "Batch decrypt" section and routes/tasks_read.py). That change
was validated live at the time but its regression test was never committed
(see docs/... Phase 10 test-durability findings) — this recreates it against
the CURRENT implementation of both crypto.py and tasks_read.py, exercising
the real HTTP endpoint rather than calling the helpers directly, so a future
refactor of either side is still caught.

Three things must hold:
  * a normal batch of encrypted title/description round-trips correctly;
  * a batch spanning a DEK ROTATION decrypts each row under its own embedded
    key_version — proving warm_dek_versions actually warms every version a
    response needs, not just the current one;
  * a NULL ciphertext (review_enc is optional) passes through as None rather
    than raising — the explicit `if blob is None` branch in both
    peek_version and decrypt_batch_cached.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration

ORG = "44444444-4444-4444-4444-444444444444"
ASSIGNEE = "55555555-5555-5555-5555-555555555555"
SENDER = "66666666-6666-6666-6666-666666666666"


def _principal():
    from app.auth import Principal

    return Principal(user_id=ASSIGNEE, org_id=ORG, roles=["member"], username="assignee")


async def _client() -> httpx.AsyncClient:
    from app.auth import require_principal
    from app.main import app

    app.dependency_overrides[require_principal] = lambda: _principal()
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def _seed_task(
    task_id: str, title: str, *, description: str = "seed", review: str | None = None
) -> None:
    """Insert one task + its assignee row under bypass, encrypting every
    ciphertext column with the real Cryptor exactly like the app does — no
    fixture ever writes a fake/placeholder ciphertext."""
    import uuid

    from crypto import cryptor
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        title_enc = await cryptor().encrypt(conn, ORG, title)
        desc_enc = await cryptor().encrypt(conn, ORG, description)
        review_enc = await cryptor().encrypt(conn, ORG, review) if review is not None else None
        await conn.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, title_enc, description_enc) "
                "VALUES (:id, :org, :sender, :title_enc, :desc_enc)"
            ),
            {"id": task_id, "org": ORG, "sender": SENDER, "title_enc": title_enc, "desc_enc": desc_enc},
        )
        await conn.execute(
            text(
                "INSERT INTO task_assignees (task_id, org_id, assignee_id, status, review_enc) "
                "VALUES (:tid, :org, :aid, 'SENT', :review_enc)"
            ),
            {"tid": task_id, "org": ORG, "aid": ASSIGNEE, "review_enc": review_enc},
        )


async def test_inbox_round_trips_title_description_and_null_review(db_app):
    task_id = "11111111-0000-0000-0000-000000000001"
    await _seed_task(task_id, "Ship the release notes", description="Before Friday")

    async with await _client() as c:
        r = await c.get("/api/v1/tasks/inbox")
        assert r.status_code == 200, r.text
        rows = {row["taskId"]: row for row in r.json()}

    assert task_id in rows
    row = rows[task_id]
    assert row["title"] == "Ship the release notes"
    assert row["description"] == "Before Friday"
    # review_enc was never written for this row -> decrypt_batch_cached must
    # treat the NULL blob as None, not raise.
    assert row["review"] is None


async def test_inbox_decrypts_rows_spanning_a_dek_rotation(db_app):
    """Two tasks, encrypted before and after rotate_dek(): a single /tasks/inbox
    response must warm BOTH key_versions and decrypt each row under its own
    embedded version — the exact scenario warm_dek_versions(versions: set[int])
    exists for."""
    from crypto import cryptor
    from app.db import get_engine

    pre_rotation_id = "22222222-0000-0000-0000-000000000002"
    await _seed_task(pre_rotation_id, "Before rotation", description="v1 key")

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        old_version, new_version = await cryptor().rotate_dek(conn, ORG)
    assert new_version == old_version + 1

    post_rotation_id = "33333333-0000-0000-0000-000000000003"
    await _seed_task(post_rotation_id, "After rotation", description="v2 key")

    async with await _client() as c:
        r = await c.get("/api/v1/tasks/inbox", params={"limit": 100})
        assert r.status_code == 200, r.text
        rows = {row["taskId"]: row for row in r.json()}

    assert rows[pre_rotation_id]["title"] == "Before rotation"
    assert rows[pre_rotation_id]["description"] == "v1 key"
    assert rows[post_rotation_id]["title"] == "After rotation"
    assert rows[post_rotation_id]["description"] == "v2 key"


async def test_inbox_pagination_limit_is_honoured_across_a_batch(db_app):
    """limit/offset are applied before the batch-decrypt step (see the SQL
    LIMIT/OFFSET in _sticky_list) — a small limit must still decrypt exactly
    that many rows, not silently return the whole org's backlog."""
    for i in range(5):
        await _seed_task(f"7777777{i}-0000-0000-0000-00000000000{i}", f"Task {i}")

    async with await _client() as c:
        r = await c.get("/api/v1/tasks/inbox", params={"limit": 2})
        assert r.status_code == 200, r.text
        rows = r.json()

    assert len(rows) == 2
    assert all(row["title"].startswith("Task ") for row in rows)
