"""task_channels: the constraints the mixed-assignment model relies on, checked
against the real migrated schema as the unprivileged app role (a superuser would
bypass RLS and prove nothing)."""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

pytestmark = pytest.mark.integration

ORG_A = "11111111-1111-1111-1111-111111111111"
ORG_B = "22222222-2222-2222-2222-222222222222"


def _id() -> str:
    return str(uuid.uuid4())


async def _task(org: str) -> str:
    from app.db import session, set_org_context

    task_id = _id()
    async with session() as db:
        await set_org_context(db, org)
        await db.execute(
            text("INSERT INTO tasks (id, org_id, sender_id, title_enc) VALUES (:t, :o, :s, :e)"),
            {"t": task_id, "o": org, "s": _id(), "e": b"x"},
        )
        await db.commit()
    return task_id


async def _channels_of(org: str, task_id: str) -> list[str]:
    from app.db import session, set_org_context

    async with session() as db:
        await set_org_context(db, org)
        rows = await db.execute(text("SELECT channel_id FROM task_channels WHERE task_id = :t"), {"t": task_id})
        return sorted(str(r.channel_id) for r in rows)


async def test_a_channel_cannot_be_attached_to_a_task_twice(db_app):
    from app.db import session, set_org_context

    task_id, ch = await _task(ORG_A), _id()
    insert = text("INSERT INTO task_channels (task_id, org_id, channel_id) VALUES (:t, :o, :c)")
    async with session() as db:
        await set_org_context(db, ORG_A)
        await db.execute(insert, {"t": task_id, "o": ORG_A, "c": ch})
        await db.commit()
    async with session() as db:
        await set_org_context(db, ORG_A)
        with pytest.raises(IntegrityError):
            await db.execute(insert, {"t": task_id, "o": ORG_A, "c": ch})


async def test_the_insert_helper_ignores_a_repeated_channel(db_app):
    """The schedule worker calls it; a raise there would be retried forever."""
    from app.db import session, set_org_context
    from app.routes.tasks_write import _insert_task_channels

    task_id, ch = await _task(ORG_A), _id()
    async with session() as db:
        await set_org_context(db, ORG_A)
        await _insert_task_channels(db, org_id=ORG_A, task_id=task_id, channel_ids=[ch, ch])
        await _insert_task_channels(db, org_id=ORG_A, task_id=task_id, channel_ids=[ch])
        await db.commit()
    assert await _channels_of(ORG_A, task_id) == [ch]


async def test_a_task_channel_needs_a_real_task(db_app):
    from app.db import session, set_org_context

    async with session() as db:
        await set_org_context(db, ORG_A)
        with pytest.raises(IntegrityError):
            await db.execute(
                text("INSERT INTO task_channels (task_id, org_id, channel_id) VALUES (:t, :o, :c)"),
                {"t": _id(), "o": ORG_A, "c": _id()},
            )


async def test_another_org_can_neither_read_nor_write_a_tasks_channels(db_app):
    from app.db import session, set_org_context

    task_id, ch = await _task(ORG_A), _id()
    async with session() as db:
        await set_org_context(db, ORG_A)
        await db.execute(
            text("INSERT INTO task_channels (task_id, org_id, channel_id) VALUES (:t, :o, :c)"),
            {"t": task_id, "o": ORG_A, "c": ch},
        )
        await db.commit()

    assert await _channels_of(ORG_B, task_id) == []  # invisible across orgs
    async with session() as db:
        await set_org_context(db, ORG_B)
        with pytest.raises(DBAPIError):  # RLS WITH CHECK: org B cannot stamp org A's row
            await db.execute(
                text("INSERT INTO task_channels (task_id, org_id, channel_id) VALUES (:t, :o, :c)"),
                {"t": task_id, "o": ORG_A, "c": _id()},
            )


async def test_deleting_a_task_removes_its_channels(db_app):
    from app.db import session, set_org_context

    task_id = await _task(ORG_A)
    async with session() as db:
        await set_org_context(db, ORG_A)
        await db.execute(
            text("INSERT INTO task_channels (task_id, org_id, channel_id) VALUES (:t, :o, :c), (:t, :o, :d)"),
            {"t": task_id, "o": ORG_A, "c": _id(), "d": _id()},
        )
        await db.commit()
    assert len(await _channels_of(ORG_A, task_id)) == 2

    async with session() as db:  # as the app role, under RLS, like the delete endpoints
        await set_org_context(db, ORG_A)
        await db.execute(text("DELETE FROM tasks WHERE id = :t"), {"t": task_id})
        await db.commit()

    assert await _channels_of(ORG_A, task_id) == []


async def test_purging_an_org_removes_its_task_channels_and_only_its_own(db_app):
    from app.db import session, set_org_context
    from app.org_purge import purge_org

    mine, theirs = await _task(ORG_A), await _task(ORG_B)
    for org, task_id in ((ORG_A, mine), (ORG_B, theirs)):
        async with session() as db:
            await set_org_context(db, org)
            await db.execute(
                text("INSERT INTO task_channels (task_id, org_id, channel_id) VALUES (:t, :o, :c)"),
                {"t": task_id, "o": org, "c": _id()},
            )
            await db.commit()

    await purge_org(ORG_A)

    assert await _channels_of(ORG_A, mine) == []
    assert len(await _channels_of(ORG_B, theirs)) == 1
