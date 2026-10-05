"""`channel.member.joined` retroactive task fan-out, end to end through a real
Postgres — TaskSvcConsumer._handle_channel_member_joined has never had a test
at any level before this.

This pins behavior BEFORE an optimization pass batches its per-row work
(N sequential `await cryptor().decrypt()` calls -> one asyncio.to_thread
decrypt_batch_cached hop; N sequential resolve_username() lookups -> one
LEFT JOIN; N sequential "already an assignee?" SELECTs -> one `= ANY(...)`
query) — see crypto.py's "Batch decrypt" section and routes/tasks_read.py for
the established pattern this mirrors. Every assertion here is about the
externally-visible result (which rows get written, which outbox events get
enqueued, with what content) so it holds regardless of which internal shape
produced it.

Every org/channel/user/task/event id is freshly generated per test: db_app's
cleanup only truncates task_assignees/tasks/idempotency_keys/org_keys/
user_projection between tests (matching the sibling integration suites),
NOT outbox or consumed_events — so a shared id would leak outbox rows or a
dedup claim across tests. See test_create_task_assignee_org.py for the same
convention.

Needs a real Postgres with RLS enforced, like the sibling integration suites.
"""

from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.integration


def _uuid() -> str:
    return str(uuid.uuid4())


async def _seed_task(org: str, sender: str, task_id: str, title: str, description: str, *, channel_id: str) -> None:
    from crypto import cryptor
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        title_enc = await cryptor().encrypt(conn, org, title)
        desc_enc = await cryptor().encrypt(conn, org, description)
        await conn.execute(
            text(
                "INSERT INTO tasks (id, org_id, sender_id, channel_id, title_enc, description_enc) "
                "VALUES (:id, :org, :sender, :ch, :t, :d)"
            ),
            {"id": task_id, "org": org, "sender": sender, "ch": channel_id, "t": title_enc, "d": desc_enc},
        )


async def _seed_assignee(org: str, task_id: str, assignee_id: str, status: str) -> None:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        await conn.execute(
            text(
                "INSERT INTO task_assignees (task_id, org_id, assignee_id, status) "
                "VALUES (:tid, :org, :aid, CAST(:status AS assignee_status))"
            ),
            {"tid": task_id, "org": org, "aid": assignee_id, "status": status},
        )


async def _assignee_rows(task_id: str, assignee_id: str) -> int:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        return (
            await conn.execute(
                text("SELECT count(*) FROM task_assignees WHERE task_id = :tid AND assignee_id = :aid"),
                {"tid": task_id, "aid": assignee_id},
            )
        ).scalar()


async def _outbox_events_for(assignee_id: str) -> list[dict]:
    from app.db import get_engine

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        rows = (
            await conn.execute(
                text("SELECT payload FROM outbox WHERE payload->>'assigneeId' = :aid ORDER BY created_at"),
                {"aid": assignee_id},
            )
        ).all()
    return [r.payload if isinstance(r.payload, dict) else json.loads(r.payload) for r in rows]


def _event(event_id: str, *, org: str, channel: str, user_id: str) -> dict:
    return {
        "type": "channel.member.joined",
        "eventId": event_id,
        "orgId": org,
        "channelId": channel,
        "userId": user_id,
    }


async def test_active_task_fans_out_with_correct_title_description_and_sender_username(
    db_app, seed_members
):
    org, channel, sender = _uuid(), _uuid(), _uuid()
    new_member, existing_assignee, task_id = _uuid(), _uuid(), _uuid()
    await seed_members(org, sender)
    await _seed_task(org, sender, task_id, "Ship the release notes", "Before Friday", channel_id=channel)
    await _seed_assignee(org, task_id, existing_assignee, "SENT")  # keeps the task "active"

    from app.consumer import TaskSvcConsumer

    await TaskSvcConsumer()._handle_channel_member_joined(  # noqa: SLF001
        _event(_uuid(), org=org, channel=channel, user_id=new_member)
    )

    assert await _assignee_rows(task_id, new_member) == 1
    events = await _outbox_events_for(new_member)
    assert len(events) == 1
    assert events[0]["taskId"] == task_id
    assert events[0]["title"] == "Ship the release notes"
    assert events[0]["description"] == "Before Friday"
    assert events[0]["senderUsername"] == "member-0"  # seed_members names it member-0
    assert events[0]["senderId"] == sender
    assert events[0]["statusVersion"] == 0


async def test_sender_with_no_user_projection_row_gets_an_empty_username_not_an_error(db_app):
    # No seed_members call: the sender is a stranger to user_projection (e.g. a
    # producer race, or a since-purged account). The LEFT JOIN must still
    # return the row with an empty username, matching resolve_username()'s old
    # `or ""` fallback, not drop the task or raise.
    org, channel, sender = _uuid(), _uuid(), _uuid()
    new_member, existing_assignee, task_id = _uuid(), _uuid(), _uuid()
    await _seed_task(org, sender, task_id, "Orphaned sender task", "", channel_id=channel)
    await _seed_assignee(org, task_id, existing_assignee, "ACKNOWLEDGED")

    from app.consumer import TaskSvcConsumer

    await TaskSvcConsumer()._handle_channel_member_joined(  # noqa: SLF001
        _event(_uuid(), org=org, channel=channel, user_id=new_member)
    )

    events = await _outbox_events_for(new_member)
    assert len(events) == 1
    assert events[0]["senderUsername"] == ""


async def test_a_task_with_only_terminal_assignees_is_not_fanned_out(db_app, seed_members):
    org, channel, sender = _uuid(), _uuid(), _uuid()
    new_member, existing_assignee, task_id = _uuid(), _uuid(), _uuid()
    await seed_members(org, sender)
    await _seed_task(org, sender, task_id, "Old resolved task", "done long ago", channel_id=channel)
    await _seed_assignee(org, task_id, existing_assignee, "COMPLETED")  # no active assignee left

    from app.consumer import TaskSvcConsumer

    await TaskSvcConsumer()._handle_channel_member_joined(  # noqa: SLF001
        _event(_uuid(), org=org, channel=channel, user_id=new_member)
    )

    assert await _assignee_rows(task_id, new_member) == 0
    assert await _outbox_events_for(new_member) == []


async def test_a_task_the_new_member_is_already_assigned_to_is_skipped_without_a_duplicate(
    db_app, seed_members
):
    org, channel, sender = _uuid(), _uuid(), _uuid()
    new_member, existing_assignee, task_id = _uuid(), _uuid(), _uuid()
    await seed_members(org, sender)
    await _seed_task(org, sender, task_id, "Already yours", "", channel_id=channel)
    await _seed_assignee(org, task_id, existing_assignee, "SENT")
    # The new member somehow already has a row (e.g. the channel admin
    # pre-added them, or a previous delivery of this same event already ran).
    await _seed_assignee(org, task_id, new_member, "ACKNOWLEDGED")

    from app.consumer import TaskSvcConsumer

    await TaskSvcConsumer()._handle_channel_member_joined(  # noqa: SLF001
        _event(_uuid(), org=org, channel=channel, user_id=new_member)
    )

    # Still exactly one row — no duplicate INSERT, and its status is untouched.
    assert await _assignee_rows(task_id, new_member) == 1
    assert await _outbox_events_for(new_member) == []


async def test_redelivery_of_the_same_event_id_is_a_no_op(db_app, seed_members):
    org, channel, sender = _uuid(), _uuid(), _uuid()
    new_member, existing_assignee, task_id = _uuid(), _uuid(), _uuid()
    await seed_members(org, sender)
    await _seed_task(org, sender, task_id, "Idempotency check", "", channel_id=channel)
    await _seed_assignee(org, task_id, existing_assignee, "SENT")

    from app.consumer import TaskSvcConsumer

    consumer = TaskSvcConsumer()
    ev = _event(_uuid(), org=org, channel=channel, user_id=new_member)
    await consumer._handle_channel_member_joined(ev)  # noqa: SLF001
    await consumer._handle_channel_member_joined(ev)  # noqa: SLF001 - Kafka redelivery

    assert await _assignee_rows(task_id, new_member) == 1
    assert len(await _outbox_events_for(new_member)) == 1


async def test_two_active_tasks_spanning_a_dek_rotation_both_decrypt_correctly(db_app, seed_members):
    """The exact scenario warm_dek_versions(versions: set[int]) exists for:
    a single fan-out spans more than one task, and those tasks' ciphertexts
    were written under DIFFERENT key_versions. Every version the batch needs
    must be warmed, and each row decrypted under its OWN embedded version."""
    org, channel, sender = _uuid(), _uuid(), _uuid()
    new_member, existing_assignee = _uuid(), _uuid()
    pre_id, post_id = _uuid(), _uuid()
    await seed_members(org, sender)
    from crypto import cryptor
    from app.db import get_engine

    await _seed_task(org, sender, pre_id, "Before rotation", "v1 key", channel_id=channel)
    await _seed_assignee(org, pre_id, existing_assignee, "SENT")

    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        old_version, new_version = await cryptor().rotate_dek(conn, org)
    assert new_version == old_version + 1

    await _seed_task(org, sender, post_id, "After rotation", "v2 key", channel_id=channel)
    await _seed_assignee(org, post_id, existing_assignee, "ACKNOWLEDGED")

    from app.consumer import TaskSvcConsumer

    await TaskSvcConsumer()._handle_channel_member_joined(  # noqa: SLF001
        _event(_uuid(), org=org, channel=channel, user_id=new_member)
    )

    events = {e["taskId"]: e for e in await _outbox_events_for(new_member)}
    assert events[pre_id]["title"] == "Before rotation"
    assert events[pre_id]["description"] == "v1 key"
    assert events[post_id]["title"] == "After rotation"
    assert events[post_id]["description"] == "v2 key"


async def test_a_task_in_a_different_channel_is_not_included(db_app, seed_members):
    org, channel, other_channel, sender = _uuid(), _uuid(), _uuid(), _uuid()
    new_member, existing_assignee, task_id = _uuid(), _uuid(), _uuid()
    await seed_members(org, sender)
    await _seed_task(org, sender, task_id, "Wrong channel", "", channel_id=other_channel)
    await _seed_assignee(org, task_id, existing_assignee, "SENT")

    from app.consumer import TaskSvcConsumer

    await TaskSvcConsumer()._handle_channel_member_joined(  # noqa: SLF001
        _event(_uuid(), org=org, channel=channel, user_id=new_member)
    )

    assert await _assignee_rows(task_id, new_member) == 0
