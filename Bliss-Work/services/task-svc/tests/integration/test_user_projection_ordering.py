from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from app.consumer import TaskSvcConsumer
from app.db import get_engine

pytestmark = pytest.mark.integration


def _id() -> str:
    return str(uuid.uuid4())


async def _projection(user_id: str):
    async with get_engine().begin() as conn:
        await conn.execute(text("SELECT set_config('app.bypass_rls', 'on', true)"))
        return (
            await conn.execute(
                text(
                    "SELECT username, display_name, active, source_occurred_at "
                    "FROM user_projection WHERE user_id = :user_id"
                ),
                {"user_id": user_id},
            )
        ).first()


@pytest.mark.parametrize(
    "created_at",
    ["2026-10-08T10:01:00.000Z", "2026-10-08T10:02:00.000Z"],
)
async def test_delayed_user_created_cannot_reactivate_a_deactivated_projection(db_app, created_at):
    consumer = TaskSvcConsumer()
    user_id, org_id = _id(), _id()
    await consumer._handle_membership_changed(
        {
            "eventId": _id(),
            "type": "user.deactivated",
            "orgId": org_id,
            "userId": user_id,
            "occurredAt": "2026-10-08T10:02:00.000Z",
        },
        active=False,
    )
    await consumer._handle_user_created(
        {
            "eventId": _id(),
            "type": "user.created",
            "orgId": org_id,
            "userId": user_id,
            "username": "member",
            "displayName": "Member",
            "occurredAt": created_at,
        }
    )

    row = await _projection(user_id)
    assert row.active is False
    assert row.username == "member"
    assert row.display_name == "Member"
    assert row.source_occurred_at.isoformat().startswith("2026-10-08T10:02:00")


async def test_newer_reactivation_supersedes_the_projection_tombstone(db_app):
    consumer = TaskSvcConsumer()
    user_id, org_id = _id(), _id()
    await consumer._handle_membership_changed(
        {
            "eventId": _id(),
            "type": "user.deactivated",
            "orgId": org_id,
            "userId": user_id,
            "occurredAt": "2026-10-08T10:02:00.000Z",
        },
        active=False,
    )
    await consumer._handle_membership_changed(
        {
            "eventId": _id(),
            "type": "user.reactivated",
            "orgId": org_id,
            "userId": user_id,
            "occurredAt": "2026-10-08T10:03:00.000Z",
        },
        active=True,
    )

    row = await _projection(user_id)
    assert row.active is True
    assert row.source_occurred_at.isoformat().startswith("2026-10-08T10:03:00")
