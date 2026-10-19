from __future__ import annotations

import json

import uuid6
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


def iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


async def resolve_username(db: AsyncSession, org_id: str, user_id: str) -> str:
    row = (
        await db.execute(
            text(
                "SELECT username FROM user_projection WHERE user_id = :uid AND org_id = :org"
            ),
            {"uid": user_id, "org": org_id},
        )
    ).first()
    return row.username if row else ""


async def resolve_display_name(db: AsyncSession, org_id: str, user_id: str) -> str:
    """The human-facing name for Rule C/D title derivation (app/allocation.py)
    — ``display_name`` with the same username/empty fallback used everywhere
    else a person's name is shown (tasks_read.py, schedules.py)."""
    row = (
        await db.execute(
            text(
                "SELECT COALESCE(NULLIF(display_name, ''), username, '') AS name "
                "FROM user_projection WHERE user_id = :uid AND org_id = :org"
            ),
            {"uid": user_id, "org": org_id},
        )
    ).first()
    return row.name if row else ""


def enqueue_outbox(db: AsyncSession, topic: str, key: str, payload: dict):
    return db.execute(
        text(
            "INSERT INTO outbox (id, topic, kafka_key, payload) "
            "VALUES (:id, :topic, :key, CAST(:payload AS jsonb))"
        ),
        {
            "id": str(uuid6.uuid7()),
            "topic": topic,
            "key": key,
            "payload": json.dumps(payload),
        },
    )


async def current_assignee(db: AsyncSession, org_id: str, task_id: str, me: str):
    return (
        await db.execute(
            text(
                "SELECT status, status_version FROM task_assignees "
                "WHERE org_id = :org AND task_id = :tid AND assignee_id = :me"
            ),
            {"org": org_id, "tid": task_id, "me": me},
        )
    ).first()


async def task_sender(db: AsyncSession, org_id: str, task_id: str) -> str | None:
    row = (
        await db.execute(
            text("SELECT sender_id FROM tasks WHERE id = :tid AND org_id = :org"),
            {"tid": task_id, "org": org_id},
        )
    ).first()
    return str(row.sender_id) if row else None
